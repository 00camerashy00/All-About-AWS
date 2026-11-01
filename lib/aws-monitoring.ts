import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import {
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  ListBucketMetricsConfigurationsCommand,
  ListBucketsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import { accountClientConfig } from "@/lib/aws";
import { requireAccount } from "@/lib/account-store";
import { RDS_MAX_CONNECTIONS, WINDOWS, regionAllowList, type WindowId } from "@/lib/monitoring-config";
import {
  connectionStatus,
  coverageLabel,
  cpuStatus,
  errorRateStatus,
  freeStorageStatus,
  isUnderutilized,
  metric,
  overallHealth,
  percentDisplay,
  latestDailyValue,
  soleCloudWatchValue,
  statusCheckStatus,
} from "@/lib/monitoring-status";
import type { MonitoringPayload, MonitoringResource, ServiceId } from "@/lib/monitoring-types";

const S3_STORAGE_TYPES = ["StandardStorage", "StandardIAStorage", "IntelligentTieringFAStorage", "GlacierStorage"];

async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let wait = 300;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      const retry = /Throttl|TooManyRequests|RequestLimitExceeded|SlowDown|ServiceUnavailable/.test(name);
      if (!retry || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait *= 2;
    }
  }
  throw new Error("retry exhausted");
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

interface PointQuery {
  id: string;
  namespace: string;
  name: string;
  dimensions: { Name: string; Value: string }[];
  period: number;
  stat: string;
}

export async function buildMonitoring(service: ServiceId, windowId: WindowId): Promise<MonitoringPayload> {
  const window = WINDOWS[windowId];
  const warnings = [
    "Averages are CloudWatch's Average statistic over one period equal to the selected window. This app does not average raw datapoints.",
    "S3 size and object count are the latest daily CloudWatch value. The window applies to EC2, RDS, and S3 request rates. Daily storage can lag one to two days.",
    "One account only. Cross-account role assumption is not in this scan.",
  ];
  const resources =
    service === "ec2"
      ? await collectEc2(window.seconds, window.days, warnings)
      : service === "rds"
        ? await collectRds(window.seconds, window.days, warnings)
        : await collectS3(window.seconds, warnings);
  return {
    live: true,
    service,
    window: window.id,
    windowLabel: window.label,
    asOf: new Date().toISOString(),
    warnings,
    resources,
  };
}

async function enabledRegions(warnings: string[]): Promise<string[]> {
  const allow = regionAllowList();
  const home = requireAccount().region;
  try {
    const ec2 = new EC2Client(accountClientConfig(home));
    const listed = await withBackoff(() => ec2.send(new DescribeRegionsCommand({ AllRegions: false })));
    let names = (listed.Regions ?? []).map((region) => region.RegionName ?? "").filter(Boolean);
    if (allow) names = names.filter((name) => allow.includes(name));
    return names.length ? names : allow ?? [home];
  } catch {
    warnings.push("Could not list regions. Scanning the account region only.");
    return allow ?? [home];
  }
}

async function metricMap(
  region: string,
  queries: PointQuery[],
  warnings: string[],
  options: { rangeSeconds?: number; pick?: "sole" | "latest" } = {}
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (!queries.length) return out;
  const cw = new CloudWatchClient(accountClientConfig(region));
  const end = new Date();
  const range = options.rangeSeconds ?? queries[0].period;
  const start = new Date(end.getTime() - range * 1000);
  for (let offset = 0; offset < queries.length; offset += 400) {
    const slice = queries.slice(offset, offset + 400);
    const metricQueries: MetricDataQuery[] = slice.map((query) => ({
      Id: query.id,
      MetricStat: {
        Metric: { Namespace: query.namespace, MetricName: query.name, Dimensions: query.dimensions },
        Period: query.period,
        Stat: query.stat,
      },
      ReturnData: true,
    }));
    try {
      const result = await withBackoff(() =>
        cw.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: metricQueries }))
      );
      for (const row of result.MetricDataResults ?? []) {
        if (!row.Id) continue;
        const picked =
          options.pick === "latest"
            ? latestDailyValue(row.Values, row.Timestamps)
            : soleCloudWatchValue(row.Values);
        if (picked.rejected) {
          const note =
            "CloudWatch returned more than one point for a window metric. Those values were left blank instead of being averaged in this app.";
          if (!warnings.includes(note)) warnings.push(note);
          out.set(row.Id, null);
        } else {
          out.set(row.Id, picked.value);
        }
      }
    } catch (error) {
      warnings.push(`CloudWatch in ${region} failed (${(error as { name?: string }).name ?? "error"}). Metrics for that batch are missing, not zero.`);
    }
  }
  return out;
}

function num(map: Map<string, number | null>, id: string): number | null {
  return map.has(id) ? map.get(id) ?? null : null;
}

async function collectEc2(period: number, days: number, warnings: string[]): Promise<MonitoringResource[]> {
  const regions = await enabledRegions(warnings);
  const found: MonitoringResource[] = [];
  await mapPool(regions, 4, async (region) => {
    try {
      const ec2 = new EC2Client(accountClientConfig(region));
      const instances: { id: string; name: string; type: string; state: string; tags: Record<string, string> }[] = [];
      let token: string | undefined;
      do {
        const page = await withBackoff(() => ec2.send(new DescribeInstancesCommand({ NextToken: token, MaxResults: 100 })));
        for (const reservation of page.Reservations ?? []) {
          for (const instance of reservation.Instances ?? []) {
            if (!instance.InstanceId || instance.State?.Name === "terminated") continue;
            const tags: Record<string, string> = {};
            for (const tag of instance.Tags ?? []) if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
            instances.push({
              id: instance.InstanceId,
              name: tags.Name || instance.InstanceId,
              type: instance.InstanceType ?? "unknown",
              state: instance.State?.Name ?? "unknown",
              tags,
            });
          }
        }
        token = page.NextToken;
      } while (token);
      for (let offset = 0; offset < instances.length; offset += 40) {
        const batch = instances.slice(offset, offset + 40);
        const queries: PointQuery[] = [];
        for (const instance of batch) {
          const dims = [{ Name: "InstanceId", Value: instance.id }];
          queries.push(
            { id: idFor(instance.id, "cpu"), namespace: "AWS/EC2", name: "CPUUtilization", dimensions: dims, period, stat: "Average" },
            { id: idFor(instance.id, "samples"), namespace: "AWS/EC2", name: "CPUUtilization", dimensions: dims, period, stat: "SampleCount" },
            { id: idFor(instance.id, "in"), namespace: "AWS/EC2", name: "NetworkIn", dimensions: dims, period, stat: "Average" },
            { id: idFor(instance.id, "out"), namespace: "AWS/EC2", name: "NetworkOut", dimensions: dims, period, stat: "Average" },
            { id: idFor(instance.id, "status"), namespace: "AWS/EC2", name: "StatusCheckFailed", dimensions: dims, period, stat: "Average" },
            { id: idFor(instance.id, "mem"), namespace: "CWAgent", name: "mem_used_percent", dimensions: dims, period, stat: "Average" },
            { id: idFor(instance.id, "disk"), namespace: "CWAgent", name: "disk_used_percent", dimensions: dims, period, stat: "Average" }
          );
          if (/^t/i.test(instance.type)) {
            queries.push({
              id: idFor(instance.id, "credit"),
              namespace: "AWS/EC2",
              name: "CPUCreditBalance",
              dimensions: dims,
              period,
              stat: "Average",
            });
          }
        }
        const values = await metricMap(region, queries, warnings);
        for (const instance of batch) found.push(ec2Resource(instance, region, values, days));
      }
    } catch (error) {
      warnings.push(`Region ${region} could not be scanned (${(error as { name?: string }).name ?? "error"}). Its resources are omitted and listed in this warning.`);
    }
  });
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function ec2Resource(
  instance: { id: string; name: string; type: string; state: string; tags: Record<string, string> },
  region: string,
  values: Map<string, number | null>,
  days: number
): MonitoringResource {
  const cpu = num(values, idFor(instance.id, "cpu"));
  const memory = num(values, idFor(instance.id, "mem"));
  const disk = num(values, idFor(instance.id, "disk"));
  const status = num(values, idFor(instance.id, "status"));
  const credits = num(values, idFor(instance.id, "credit"));
  const running = instance.state === "running";
  const notes: string[] = [];
  if (/^t/i.test(instance.type)) {
    notes.push(
      credits == null
        ? "Burstable instance. CPU % can look low while credits are being spent. Credit balance was not returned."
        : `Burstable instance. CPU credit balance average is ${Math.round(credits)}. CPU % alone can be misleading.`
    );
  }
  if (!running) notes.push("Not running. Missing CPU is left blank rather than shown as 0%.");
  const metrics = [
    metric({ id: "cpu", label: "Avg CPU", value: cpu, display: percentDisplay(cpu), status: cpuStatus(cpu), drivesHealth: true }),
    metric({ id: "networkIn", label: "Network in", value: num(values, idFor(instance.id, "in")), display: megabytes(num(values, idFor(instance.id, "in"))), status: "no-data", drivesHealth: false }),
    metric({ id: "networkOut", label: "Network out", value: num(values, idFor(instance.id, "out")), display: megabytes(num(values, idFor(instance.id, "out"))), status: "no-data", drivesHealth: false }),
    metric({
      id: "status",
      label: "Status checks",
      value: status,
      display: status == null ? "Not available" : status > 0 ? "Failures in window" : "No failures",
      status: statusCheckStatus(status),
      drivesHealth: true,
    }),
    metric({ id: "memory", label: "Memory", value: memory, display: percentDisplay(memory), status: "no-data", drivesHealth: false }),
    metric({ id: "disk", label: "Disk", value: disk, display: percentDisplay(disk), status: "no-data", drivesHealth: false }),
  ];
  if (credits != null) {
    metrics.push(metric({ id: "credits", label: "CPU credit balance", value: credits, display: `${Math.round(credits)}`, status: "no-data", drivesHealth: false }));
  }
  const overall = overallHealth(metrics);
  return {
    service: "ec2",
    id: instance.id,
    name: instance.name,
    region,
    state: instance.state,
    tags: instance.tags,
    health: overall.health,
    healthReason: overall.reason,
    underutilized: isUnderutilized(cpu, running),
    coverage: coverageLabel(num(values, idFor(instance.id, "samples")), days),
    metrics,
    notes,
    extras: { instanceType: instance.type, family: instance.type.split(".")[0] ?? instance.type, state: instance.state },
  };
}

async function collectRds(period: number, days: number, warnings: string[]): Promise<MonitoringResource[]> {
  const regions = await enabledRegions(warnings);
  const found: MonitoringResource[] = [];
  await mapPool(regions, 4, async (region) => {
    try {
      const rds = new RDSClient(accountClientConfig(region));
      const databases: { id: string; engine: string; className: string; state: string; allocatedGb: number | null; multiAz: boolean; tags: Record<string, string> }[] = [];
      let marker: string | undefined;
      do {
        const page = await withBackoff(() => rds.send(new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 })));
        for (const db of page.DBInstances ?? []) {
          if (!db.DBInstanceIdentifier) continue;
          const tags: Record<string, string> = {};
          for (const tag of db.TagList ?? []) if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
          databases.push({
            id: db.DBInstanceIdentifier,
            engine: db.Engine ?? "unknown",
            className: db.DBInstanceClass ?? "unknown",
            state: db.DBInstanceStatus ?? "unknown",
            allocatedGb: db.AllocatedStorage ?? null,
            multiAz: Boolean(db.MultiAZ),
            tags,
          });
        }
        marker = page.Marker;
      } while (marker);
      for (let offset = 0; offset < databases.length; offset += 40) {
        const batch = databases.slice(offset, offset + 40);
        const queries: PointQuery[] = [];
        for (const db of batch) {
          const dims = [{ Name: "DBInstanceIdentifier", Value: db.id }];
          queries.push(
            { id: idFor(db.id, "cpu"), namespace: "AWS/RDS", name: "CPUUtilization", dimensions: dims, period, stat: "Average" },
            { id: idFor(db.id, "samples"), namespace: "AWS/RDS", name: "CPUUtilization", dimensions: dims, period, stat: "SampleCount" },
            { id: idFor(db.id, "mem"), namespace: "AWS/RDS", name: "FreeableMemory", dimensions: dims, period, stat: "Average" },
            { id: idFor(db.id, "free"), namespace: "AWS/RDS", name: "FreeStorageSpace", dimensions: dims, period, stat: "Average" },
            { id: idFor(db.id, "conn"), namespace: "AWS/RDS", name: "DatabaseConnections", dimensions: dims, period, stat: "Average" },
            { id: idFor(db.id, "riops"), namespace: "AWS/RDS", name: "ReadIOPS", dimensions: dims, period, stat: "Average" },
            { id: idFor(db.id, "wiops"), namespace: "AWS/RDS", name: "WriteIOPS", dimensions: dims, period, stat: "Average" },
            { id: idFor(db.id, "rlat"), namespace: "AWS/RDS", name: "ReadLatency", dimensions: dims, period, stat: "Average" }
          );
        }
        const values = await metricMap(region, queries, warnings);
        for (const db of batch) found.push(rdsResource(db, region, values, days));
      }
    } catch (error) {
      warnings.push(`Region ${region} databases could not be scanned (${(error as { name?: string }).name ?? "error"}).`);
    }
  });
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function rdsResource(
  db: { id: string; engine: string; className: string; state: string; allocatedGb: number | null; multiAz: boolean; tags: Record<string, string> },
  region: string,
  values: Map<string, number | null>,
  days: number
): MonitoringResource {
  const cpu = num(values, idFor(db.id, "cpu"));
  const freeBytes = num(values, idFor(db.id, "free"));
  const freePct = freeBytes == null || !db.allocatedGb ? null : (freeBytes / (db.allocatedGb * 1024 ** 3)) * 100;
  const connections = num(values, idFor(db.id, "conn"));
  const max = RDS_MAX_CONNECTIONS[db.className] ?? null;
  const connectionPct = connections == null || !max ? null : (connections / max) * 100;
  const readIops = num(values, idFor(db.id, "riops"));
  const writeIops = num(values, idFor(db.id, "wiops"));
  // Sum of two server-side averages (read and write). Missing side stays missing.
  const iops = readIops != null && writeIops != null ? readIops + writeIops : (readIops ?? writeIops);
  const latency = num(values, idFor(db.id, "rlat"));
  const memoryBytes = num(values, idFor(db.id, "mem"));
  const notes: string[] = [];
  if (!max) notes.push("Max connections for this class is not in the local table, so connection % is not invented.");
  if (db.state !== "available") notes.push("Database is not available. Missing metrics stay blank.");
  const metrics = [
    metric({ id: "cpu", label: "Avg CPU", value: cpu, display: percentDisplay(cpu), status: cpuStatus(cpu), drivesHealth: true }),
    metric({ id: "memory", label: "Freeable memory", value: memoryBytes, display: memoryBytes == null ? "Not available" : `${(memoryBytes / 1024 ** 3).toFixed(1)} GB`, status: "no-data", drivesHealth: false }),
    metric({ id: "storage", label: "Free storage", value: freePct, display: percentDisplay(freePct), status: freeStorageStatus(freePct), drivesHealth: true }),
    metric({
      id: "connections",
      label: "Connections",
      value: connectionPct,
      display: connections == null ? "Not available" : connectionPct == null ? `${Math.round(connections)} (max unknown)` : `${Math.round(connectionPct)}% of max`,
      status: connectionStatus(connectionPct),
      drivesHealth: true,
    }),
    metric({ id: "iops", label: "IOPS", value: iops, display: iops == null ? "Not available" : `${Math.round(iops)}`, status: "no-data", drivesHealth: false }),
    metric({ id: "latency", label: "Read latency", value: latency, display: latency == null ? "Not available" : `${Math.round(latency * 1000)} ms`, status: "no-data", drivesHealth: false }),
  ];
  const overall = overallHealth(metrics);
  return {
    service: "rds",
    id: db.id,
    name: db.id,
    region,
    state: db.state,
    tags: db.tags,
    health: overall.health,
    healthReason: overall.reason,
    underutilized: isUnderutilized(cpu, db.state === "available"),
    coverage: coverageLabel(num(values, idFor(db.id, "samples")), days, 60),
    metrics,
    notes,
    extras: { engine: db.engine, class: db.className, multiAz: db.multiAz, freeStoragePct: freePct },
  };
}

async function collectS3(period: number, warnings: string[]): Promise<MonitoringResource[]> {
  const s3 = new S3Client(accountClientConfig("us-east-1"));
  const listed = await withBackoff(() => s3.send(new ListBucketsCommand({})));
  const buckets = await mapPool(listed.Buckets ?? [], 8, async (bucket) => {
    const name = bucket.Name ?? "";
    if (!name) return null;
    let region = "us-east-1";
    try {
      const location = await withBackoff(() => s3.send(new GetBucketLocationCommand({ Bucket: name })));
      const constraint = location.LocationConstraint ? String(location.LocationConstraint) : "";
      if (constraint === "EU") region = "eu-west-1";
      else if (constraint) region = constraint;
    } catch {
      warnings.push(`Could not read the region for bucket ${name}. It is still listed.`);
    }
    let versioning = "Off";
    try {
      const version = await withBackoff(() => s3.send(new GetBucketVersioningCommand({ Bucket: name })));
      versioning = version.Status ?? "Off";
    } catch {
      versioning = "Unknown";
    }
    const tags: Record<string, string> = {};
    try {
      const tagging = await withBackoff(() => s3.send(new GetBucketTaggingCommand({ Bucket: name })));
      for (const tag of tagging.TagSet ?? []) if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
    } catch {
      /* no tags is normal */
    }
    let filterId: string | null = null;
    try {
      const regional = new S3Client(accountClientConfig(region));
      const configs = await withBackoff(() => regional.send(new ListBucketMetricsConfigurationsCommand({ Bucket: name })));
      filterId = configs.MetricsConfigurationList?.[0]?.Id ?? null;
    } catch {
      filterId = null;
    }
    return { name, region, versioning, tags, filterId };
  });
  const present = buckets.filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== null);
  const byRegion = new Map<string, typeof present>();
  for (const bucket of present) {
    const list = byRegion.get(bucket.region) ?? [];
    list.push(bucket);
    byRegion.set(bucket.region, list);
  }
  const found: MonitoringResource[] = [];
  await mapPool(Array.from(byRegion.entries()), 3, async ([region, group]) => {
    for (let offset = 0; offset < group.length; offset += 15) {
      const batch = group.slice(offset, offset + 15);
      const daily: PointQuery[] = [];
      const rates: PointQuery[] = [];
      for (const bucket of batch) {
        for (const storageType of S3_STORAGE_TYPES) {
          daily.push({
            id: idFor(`${bucket.name}-${storageType}`, "size"),
            namespace: "AWS/S3",
            name: "BucketSizeBytes",
            dimensions: [
              { Name: "BucketName", Value: bucket.name },
              { Name: "StorageType", Value: storageType },
            ],
            period: 86_400,
            stat: "Average",
          });
        }
        daily.push({
          id: idFor(bucket.name, "objects"),
          namespace: "AWS/S3",
          name: "NumberOfObjects",
          dimensions: [
            { Name: "BucketName", Value: bucket.name },
            { Name: "StorageType", Value: "AllStorageTypes" },
          ],
          period: 86_400,
          stat: "Average",
        });
        if (bucket.filterId) {
          const filter = [
            { Name: "BucketName", Value: bucket.name },
            { Name: "FilterId", Value: bucket.filterId },
          ];
          rates.push(
            { id: idFor(bucket.name, "req"), namespace: "AWS/S3", name: "AllRequests", dimensions: filter, period, stat: "Average" },
            { id: idFor(bucket.name, "e4"), namespace: "AWS/S3", name: "4xxErrors", dimensions: filter, period, stat: "Average" },
            { id: idFor(bucket.name, "e5"), namespace: "AWS/S3", name: "5xxErrors", dimensions: filter, period, stat: "Average" }
          );
        }
      }
      const dailyValues = await metricMap(region, daily, warnings, { rangeSeconds: 3 * 86_400, pick: "latest" });
      const rateValues = await metricMap(region, rates, warnings, { pick: "sole" });
      const values = new Map<string, number | null>();
      dailyValues.forEach((value, key) => values.set(key, value));
      rateValues.forEach((value, key) => values.set(key, value));
      for (const bucket of batch) found.push(s3Resource(bucket, values));
    }
  });
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function s3Resource(
  bucket: { name: string; region: string; versioning: string; tags: Record<string, string>; filterId: string | null },
  values: Map<string, number | null>
): MonitoringResource {
  const parts = S3_STORAGE_TYPES.map((storageType) => num(values, idFor(`${bucket.name}-${storageType}`, "size"))).filter(
    (value): value is number => value != null
  );
  const sizeBytes = parts.length ? parts.reduce((sum, value) => sum + value, 0) : null;
  const objects = num(values, idFor(bucket.name, "objects"));
  const enabled = Boolean(bucket.filterId);
  const requests = enabled ? num(values, idFor(bucket.name, "req")) : null;
  const e4 = enabled ? num(values, idFor(bucket.name, "e4")) : null;
  const e5 = enabled ? num(values, idFor(bucket.name, "e5")) : null;
  // Ratio of three CloudWatch averages. A missing error series stays missing, not zero.
  const errorPct = enabled && requests != null && requests > 0 && e4 != null && e5 != null ? ((e4 + e5) / requests) * 100 : null;
  const notes = [
    "Size is the sum of the latest daily CloudWatch value for each storage class. Days are not averaged.",
    enabled ? `Request metrics use filter ${bucket.filterId}.` : "Request metrics are not enabled for this bucket.",
  ];
  const metrics = [
    metric({ id: "size", label: "Total size", value: sizeBytes, display: sizeBytes == null ? "Not available" : gigabytes(sizeBytes), status: "no-data", drivesHealth: false }),
    metric({ id: "objects", label: "Objects", value: objects, display: objects == null ? "Not available" : Math.round(objects).toLocaleString("en-US"), status: "no-data", drivesHealth: false }),
    metric({
      id: "requests",
      label: "Requests",
      value: requests,
      display: enabled ? (requests == null ? "Not available" : `${Math.round(requests)} avg`) : "Not enabled",
      status: "no-data",
      drivesHealth: false,
    }),
    metric({
      id: "errors",
      label: "Error rate",
      value: errorPct,
      display: enabled ? percentDisplay(errorPct) : "Not enabled",
      status: enabled ? errorRateStatus(errorPct) : "no-data",
      drivesHealth: enabled,
    }),
  ];
  const overall = overallHealth(metrics);
  return {
    service: "s3",
    id: bucket.name,
    name: bucket.name,
    region: bucket.region,
    state: bucket.versioning,
    tags: bucket.tags,
    health: overall.health,
    healthReason: overall.reason,
    underutilized: false,
    coverage: null,
    metrics,
    notes,
    extras: { sizeBytes, versioning: bucket.versioning, storageClass: "Mixed" },
  };
}

function idFor(raw: string, suffix: string): string {
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
  return `m${(hash >>> 0).toString(16)}${cleaned}${suffix}`;
}

function megabytes(bytes: number | null): string {
  if (bytes == null) return "Not available";
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function gigabytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}
