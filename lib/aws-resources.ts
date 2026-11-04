import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  RDSClient,
} from "@aws-sdk/client-rds";
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  DescribeLoadBalancersCommand as DescribeV2LBsCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  DescribeLoadBalancersCommand as DescribeClassicLBsCommand,
  ElasticLoadBalancingClient,
} from "@aws-sdk/client-elastic-load-balancing";
import { DescribeFileSystemsCommand, EFSClient } from "@aws-sdk/client-efs";
import { DescribeServerCommand, ListServersCommand, TransferClient } from "@aws-sdk/client-transfer";
import { accountClientConfig } from "@/lib/aws";
import { RDS_MAX_CONNECTIONS } from "@/lib/monitoring-config";

function clientConfig(region?: string) {
  return accountClientConfig(region);
}

export type Health = "healthy" | "attention" | "critical";

export interface LiveInstance {
  kind: "ec2";
  id: string;
  name: string;
  state: string;
  type: string;
  region: string;
  az: string;
  launchDays: number;
  cpuAvg7d: number | null;
  diskGb: number;
  status: Health;
  flags: string[];
}

export interface LiveDatabase {
  kind: "rds";
  id: string;
  engine: string;
  class: string;
  region: string;
  status: string;
  storageGb: number | null;
  storageUsedPct: number | null;
  /** 7-day CloudWatch CPU average. Null when AWS did not return it. */
  cpuAvg7d: number | null;
  /** Connections as a percent of the known class maximum. Null when either number is missing. */
  connectionPct: number | null;
  backupRetentionDays: number | null;
  manualSnapshots: number;
  multiAz: boolean;
  statusLevel: Health;
  flags: string[];
}

export interface LiveBucket {
  kind: "s3";
  name: string;
  region: string;
  sizeGb: number;
  objects: number;
  estimated: boolean;
  versioning: string;
  lifecycle: boolean;
  statusLevel: Health;
  flags: string[];
}

export interface LiveVolume {
  kind: "ebs";
  id: string;
  sizeGb: number;
  type: string;
  state: string;
  attachedTo: string | null;
  region: string;
  ageDays: number;
  flags: string[];
}

export interface LiveSnapshot {
  kind: "snapshot";
  id: string;
  store: "ebs" | "rds";
  source: string;
  sizeGb: number;
  ageDays: number;
  region: string;
  flags: string[];
}

export interface LiveLB {
  kind: "elb";
  name: string;
  lbType: string;
  scheme: string;
  region: string;
  flags: string[];
}

export interface LiveEFS {
  kind: "efs";
  id: string;
  name: string;
  sizeGb: number;
  region: string;
  flags: string[];
}

export interface LiveTransfer {
  kind: "transfer";
  id: string;
  protocols: string;
  state: string;
  region: string;
  flags: string[];
}

export interface WasteItem {
  severity: Health;
  title: string;
  detail: string;
  action: string;
  /** Which scoped rescan replaces this row. Older cached rows omit it. */
  source?: "ec2" | "rds" | "s3" | "other";
}

const DAY = 86400000;
const daysSince = (d?: Date) =>
  d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY)) : 0;

async function regions(ec2: EC2Client): Promise<string[]> {
  try {
    const r = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
    return (r.Regions ?? []).map((x) => x.RegionName ?? "").filter(Boolean);
  } catch {
    return [process.env.AWS_REGION || "ap-south-1", "us-east-1"];
  }
}

async function cpuForInstances(
  region: string,
  ids: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  try {
    const cw = new CloudWatchClient(clientConfig(region));
    const end = new Date();
    const start = new Date(end.getTime() - 7 * DAY);
    const res = await cw.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: ids.slice(0, 100).map((id, i) => ({
          Id: `c${i}`,
          Label: id,
          MetricStat: {
            Metric: {
              Namespace: "AWS/EC2",
              MetricName: "CPUUtilization",
              Dimensions: [{ Name: "InstanceId", Value: id }],
            },
            Period: 604800,
            Stat: "Average",
          },
        })),
      })
    );
    for (const r of res.MetricDataResults ?? []) {
      const v = r.Values?.[0];
      if (r.Label && typeof v === "number") out.set(r.Label, Math.round(v));
    }
  } catch {
    /* metrics best-effort */
  }
  return out;
}

async function rdsStorageUsedPct(
  region: string,
  ids: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  try {
    const cw = new CloudWatchClient(clientConfig(region));
    const end = new Date();
    const start = new Date(end.getTime() - 7 * DAY);
    const res = await cw.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: ids.slice(0, 100).map((id, i) => ({
          Id: `f${i}`,
          Label: id,
          MetricStat: {
            Metric: {
              Namespace: "AWS/RDS",
              MetricName: "FreeStorageSpace",
              Dimensions: [{ Name: "DBInstanceIdentifier", Value: id }],
            },
            Period: 604800,
            Stat: "Average",
          },
        })),
      })
    );
    for (const r of res.MetricDataResults ?? []) {
      const v = r.Values?.[0];
      if (r.Label && typeof v === "number") out.set(r.Label, v);
    }
  } catch {
    /* best-effort */
  }
  return out;
}

/** 7-day CPU average and connection count. Same GetMetricData shape as the EC2 CPU query. */
async function rdsWorkload(
  region: string,
  ids: string[]
): Promise<Map<string, { cpu: number | null; connections: number | null }>> {
  const out = new Map<string, { cpu: number | null; connections: number | null }>();
  for (const id of ids) out.set(id, { cpu: null, connections: null });
  if (ids.length === 0) return out;
  try {
    const cw = new CloudWatchClient(clientConfig(region));
    const end = new Date();
    const start = new Date(end.getTime() - 7 * DAY);
    for (let offset = 0; offset < ids.length; offset += 50) {
      const slice = ids.slice(offset, offset + 50);
      const byQuery = new Map<string, { id: string; kind: "cpu" | "connections" }>();
      const queries = slice.flatMap((id, index) => {
        const dims = [{ Name: "DBInstanceIdentifier", Value: id }];
        const cpuId = `c${index}`;
        const connId = `n${index}`;
        byQuery.set(cpuId, { id, kind: "cpu" });
        byQuery.set(connId, { id, kind: "connections" });
        return [
          {
            Id: cpuId,
            MetricStat: {
              Metric: { Namespace: "AWS/RDS", MetricName: "CPUUtilization", Dimensions: dims },
              Period: 604800,
              Stat: "Average" as const,
            },
          },
          {
            Id: connId,
            MetricStat: {
              Metric: { Namespace: "AWS/RDS", MetricName: "DatabaseConnections", Dimensions: dims },
              Period: 604800,
              Stat: "Average" as const,
            },
          },
        ];
      });
      const res = await cw.send(
        new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries })
      );
      for (const row of res.MetricDataResults ?? []) {
        const meta = row.Id ? byQuery.get(row.Id) : undefined;
        const value = row.Values?.[0];
        const target = meta ? out.get(meta.id) : undefined;
        if (!meta || !target || typeof value !== "number") continue;
        if (meta.kind === "cpu") target.cpu = Math.round(value);
        else target.connections = value;
      }
    }
  } catch {
    /* best-effort */
  }
  return out;
}

// Phase 1: cheap existence sweep. Answers only "does anything live here?"
// so Phase 2 (CloudWatch, snapshot pagination, S3 detail) runs solely
// where it can find something. One fast pass over all regions.
async function sweepRegion(region: string, scope?: InventoryScope): Promise<boolean> {
  if (scope === "ec2") {
    try {
      const ec2 = new EC2Client(clientConfig(region));
      const found = await ec2.send(new DescribeInstancesCommand({ MaxResults: 5 }));
      return (found.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []).length > 0;
    } catch {
      return false;
    }
  }
  if (scope === "rds") {
    try {
      const rds = new RDSClient(clientConfig(region));
      const found = await rds.send(new DescribeDBInstancesCommand({ MaxRecords: 20 }));
      return (found.DBInstances ?? []).length > 0;
    } catch {
      return false;
    }
  }
  const ec2 = new EC2Client(clientConfig(region));
  const rds = new RDSClient(clientConfig(region));
  try {
    const [inst, vols, dbs, snaps] = await Promise.all([
      ec2
        .send(new DescribeInstancesCommand({ MaxResults: 5 }))
        .then((r) =>
          (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).length
        )
        .catch(() => 0),
      ec2
        .send(new DescribeVolumesCommand({ MaxResults: 5 }))
        .then((r) => (r.Volumes ?? []).length)
        .catch(() => 0),
      rds
        .send(new DescribeDBInstancesCommand({ MaxRecords: 5 }))
        .then((r) => (r.DBInstances ?? []).length)
        .catch(() => 0),
      ec2
        .send(new DescribeSnapshotsCommand({ OwnerIds: ["self"], MaxResults: 5 }))
        .then((r) => (r.Snapshots ?? []).length)
        .catch(() => 0),
    ]);
    if (inst > 0 || vols > 0 || dbs > 0 || snaps > 0) return true;
  } catch {
    return false;
  }
  try {
    const [v2, classic, fs, t] = await Promise.all([
      new ElasticLoadBalancingV2Client(clientConfig(region))
        .send(new DescribeV2LBsCommand({}))
        .then((r) => (r.LoadBalancers ?? []).length)
        .catch(() => 0),
      new ElasticLoadBalancingClient(clientConfig(region))
        .send(new DescribeClassicLBsCommand({}))
        .then((r) => (r.LoadBalancerDescriptions ?? []).length)
        .catch(() => 0),
      new EFSClient(clientConfig(region))
        .send(new DescribeFileSystemsCommand({}))
        .then((r) => (r.FileSystems ?? []).length)
        .catch(() => 0),
      new TransferClient(clientConfig(region))
        .send(new ListServersCommand({ MaxResults: 5 }))
        .then((r) => (r.Servers ?? []).length)
        .catch(() => 0),
    ]);
    return v2 > 0 || classic > 0 || fs > 0 || t > 0;
  } catch {
    return false;
  }
}

async function scanRegion(region: string, acc: {
  instances: LiveInstance[];
  databases: LiveDatabase[];
  volumes: LiveVolume[];
  snapshots: LiveSnapshot[];
  lbs: LiveLB[];
  efs: LiveEFS[];
  transfer: LiveTransfer[];
  waste: WasteItem[];
}, scope?: InventoryScope) {
  const ec2 = new EC2Client(clientConfig(region));
  const rds = new RDSClient(clientConfig(region));

  if (!scope || scope === "ec2") {
  // ---- EC2 instances ----
  try {
    let token: string | undefined;
    const found: LiveInstance[] = [];
    do {
      const res = await ec2.send(
        new DescribeInstancesCommand({ NextToken: token, MaxResults: 100 })
      );
      for (const r of res.Reservations ?? []) {
        for (const i of r.Instances ?? []) {
          const state = i.State?.Name ?? "unknown";
          if (state === "terminated" || state === "shutting-down") continue;
          const name =
            i.Tags?.find((t) => t.Key === "Name")?.Value ?? i.InstanceId ?? "";
          // disk size refined after volumes are collected (see buildInventory)
          found.push({
            kind: "ec2",
            id: i.InstanceId ?? "",
            name,
            state,
            type: i.InstanceType ?? "?",
            region,
            az: i.Placement?.AvailabilityZone ?? region,
            launchDays: daysSince(i.LaunchTime),
            cpuAvg7d: null,
            diskGb: 0,
            status: "healthy",
            flags: [],
          });
        }
      }
      token = res.NextToken;
    } while (token);
    const cpu = await cpuForInstances(
      region,
      found.filter((f) => f.state === "running").map((f) => f.id)
    );
    for (const f of found) {
      const c = cpu.get(f.id) ?? null;
      f.cpuAvg7d = c;
      if (f.state !== "running") {
        f.status = "attention";
        f.flags.push(`Stopped — server is off but its disks keep billing`);
        acc.waste.push({
          severity: "attention",
          title: `${f.name || f.id} is stopped`,
          detail: `In ${region}. Compute charges paused, but attached storage still bills until deleted.`,
          action: "Restart it, or delete it with its disks if abandoned.",
          source: "ec2",
        });
      } else if (c !== null && c >= 80) {
        f.status = "critical";
        f.flags.push(`Overloaded — CPU ${c}% over 7 days`);
      }
    }
    acc.instances.push(...found);
  } catch {
    /* region may be disabled */
  }
  }

  if (!scope) {
  // ---- EBS volumes ----
  try {
    let token: string | undefined;
    do {
      const res = await ec2.send(
        new DescribeVolumesCommand({ NextToken: token, MaxResults: 100 })
      );
      for (const v of res.Volumes ?? []) {
        const attached = v.Attachments?.[0]?.InstanceId ?? null;
        const vol: LiveVolume = {
          kind: "ebs",
          id: v.VolumeId ?? "",
          sizeGb: v.Size ?? 0,
          type: v.VolumeType ?? "",
          state: v.State ?? "",
          attachedTo: attached,
          region,
          ageDays: daysSince(v.CreateTime),
          flags: [],
        };
        if (v.State === "available") {
          vol.flags.push("Unattached disk — pure waste until deleted");
          acc.waste.push({
            severity: "attention",
            title: `Orphaned disk ${v.VolumeId} (${v.Size} GB)`,
            detail: `Unattached in ${region} for an unknown period — bills at full rate with zero benefit.`,
            action: "Snapshot it if the data matters, then delete the volume.",
            source: "other",
          });
        }
        acc.volumes.push(vol);
      }
      token = res.NextToken;
    } while (token);
  } catch {
    /* ignore */
  }

  // ---- EBS snapshots (own account) ----
  try {
    let token: string | undefined;
    let count = 0;
    do {
      const res = await ec2.send(
        new DescribeSnapshotsCommand({
          OwnerIds: ["self"],
          NextToken: token,
          MaxResults: 100,
        })
      );
      for (const s of res.Snapshots ?? []) {
        const age = daysSince(s.StartTime);
        const flags: string[] = [];
        if (age > 90) {
          flags.push(`Old snapshot (${age} days) — review whether still needed`);
          if (count < 3)
            acc.waste.push({
              severity: "attention",
              title: `Stale snapshot ${s.SnapshotId} (${s.VolumeSize} GB, ${age}d old)`,
              detail: `In ${region}. Snapshots pile up silently at ~$0.05/GB-month.`,
              action: "Delete it if no longer needed for rollback.",
              source: "other",
            });
        }
        acc.snapshots.push({
          kind: "snapshot",
          id: s.SnapshotId ?? "",
          store: "ebs",
          source: s.VolumeId ?? "",
          sizeGb: s.VolumeSize ?? 0,
          ageDays: age,
          region,
          flags,
        });
        count++;
        if (count >= 100) break;
      }
      token = count >= 100 ? undefined : res.NextToken;
    } while (token);
  } catch {
    /* ignore */
  }
  }

  if (!scope || scope === "rds") {
  // ---- RDS ----
  try {
    let marker: string | undefined;
    const dbs: LiveDatabase[] = [];
    do {
      const res = await rds.send(
        new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 })
      );
      for (const d of res.DBInstances ?? []) {
        dbs.push({
          kind: "rds",
          id: d.DBInstanceIdentifier ?? "",
          engine: `${d.Engine ?? ""} ${d.EngineVersion ?? ""}`.trim(),
          class: d.DBInstanceClass ?? "",
          region,
          status: d.DBInstanceStatus ?? "",
          storageGb: d.AllocatedStorage ?? null,
          storageUsedPct: null,
          cpuAvg7d: null,
          connectionPct: null,
          backupRetentionDays: d.BackupRetentionPeriod ?? null,
          manualSnapshots: 0,
          multiAz: d.MultiAZ ?? false,
          statusLevel: d.DBInstanceStatus === "available" ? "healthy" : "attention",
          flags: [],
        });
      }
      marker = res.Marker;
    } while (marker);
    const dbIds = dbs.map((d) => d.id);
    const [free, workload] = await Promise.all([
      rdsStorageUsedPct(region, dbIds),
      rdsWorkload(region, dbIds),
    ]);
    for (const d of dbs) {
      const load = workload.get(d.id);
      d.cpuAvg7d = load?.cpu ?? null;
      const maxConnections = RDS_MAX_CONNECTIONS[d.class];
      d.connectionPct =
        load?.connections == null || !maxConnections
          ? null
          : Math.round((load.connections / maxConnections) * 100);
      const freeBytes = free.get(d.id);
      if (freeBytes !== undefined && d.storageGb) {
        const used = Math.round(
          (1 - freeBytes / (d.storageGb * 1073741824)) * 100
        );
        d.storageUsedPct = Math.max(0, Math.min(100, used));
        if (used >= 85) {
          d.statusLevel = "critical";
          d.flags.push(`Storage ${used}% full — will run out soon`);
          acc.waste.push({
            severity: "critical",
            title: `Database ${d.id} almost full`,
            detail: `${used}% of ${d.storageGb} GB used in ${region}.`,
            action: "Grow storage or archive old data this week.",
            source: "rds",
          });
        } else if (used >= 70) {
          if (d.statusLevel === "healthy") d.statusLevel = "attention";
          d.flags.push(`Storage ${used}% full — watch it`);
        }
      }
      if ((d.backupRetentionDays ?? 0) > 14) {
        d.flags.push(
          `Long backup retention (${d.backupRetentionDays}d) — excess backup storage bills extra`
        );
      }
    }
    // manual snapshot counts
    try {
      let sm: string | undefined;
      const counts = new Map<string, number>();
      do {
        const res = await rds.send(
          new DescribeDBSnapshotsCommand({
            SnapshotType: "manual",
            Marker: sm,
            MaxRecords: 100,
          })
        );
        for (const s of res.DBSnapshots ?? []) {
          const key = s.DBInstanceIdentifier ?? "";
          counts.set(key, (counts.get(key) ?? 0) + 1);
          acc.snapshots.push({
            kind: "snapshot",
            id: s.DBSnapshotIdentifier ?? "",
            store: "rds",
            source: key,
            sizeGb: s.AllocatedStorage ?? 0,
            ageDays: daysSince(s.InstanceCreateTime),
            region,
            flags:
              daysSince(s.InstanceCreateTime) > 90
                ? ["Old manual snapshot — review whether still needed"]
                : [],
          });
        }
        sm = res.Marker;
      } while (sm);
      for (const d of dbs) {
        d.manualSnapshots = counts.get(d.id) ?? 0;
        if (d.manualSnapshots >= 5)
          d.flags.push(`${d.manualSnapshots} manual snapshots kept — each adds backup cost`);
      }
    } catch {
      /* ignore */
    }
    acc.databases.push(...dbs);
  } catch {
    /* ignore */
  }
  }

  if (!scope) {
  // ---- Load balancers (v2 + classic) ----
  try {
    const v2 = new ElasticLoadBalancingV2Client(clientConfig(region));
    let marker: string | undefined;
    do {
      const res = await v2.send(new DescribeV2LBsCommand({ Marker: marker }));
      for (const lb of res.LoadBalancers ?? []) {
        acc.lbs.push({
          kind: "elb",
          name: lb.LoadBalancerName ?? "",
          lbType: lb.Type ?? "",
          scheme: lb.Scheme ?? "",
          region,
          flags:
            lb.State?.Code && lb.State.Code !== "active"
              ? [`State: ${lb.State.Code}`]
              : [],
        });
      }
      marker = res.NextMarker;
    } while (marker);
  } catch {
    /* ignore */
  }
  try {
    const cl = new ElasticLoadBalancingClient(clientConfig(region));
    let marker: string | undefined;
    do {
      const res = await cl.send(new DescribeClassicLBsCommand({ Marker: marker }));
      for (const lb of res.LoadBalancerDescriptions ?? []) {
        acc.lbs.push({
          kind: "elb",
          name: lb.LoadBalancerName ?? "",
          lbType: "classic",
          scheme: lb.Scheme ?? "",
          region,
          flags: ["Older generation — consider an Application/Network LB"],
        });
      }
      marker = res.NextMarker;
    } while (marker);
  } catch {
    /* ignore */
  }

  // ---- EFS ----
  try {
    const efs = new EFSClient(clientConfig(region));
    const res = await efs.send(new DescribeFileSystemsCommand({}));
    for (const f of res.FileSystems ?? []) {
      const bytes = Number(f.SizeInBytes?.Value ?? 0);
      acc.efs.push({
        kind: "efs",
        id: f.FileSystemId ?? "",
        name: f.Name ?? f.FileSystemId ?? "",
        sizeGb: Math.round((bytes / 1073741824) * 10) / 10,
        region,
        flags: [],
      });
    }
  } catch {
    /* ignore */
  }

  // ---- Transfer Family ----
  try {
    const t = new TransferClient(clientConfig(region));
    let token: string | undefined;
    const ids: string[] = [];
    do {
      const res = await t.send(new ListServersCommand({ NextToken: token, MaxResults: 100 }));
      for (const s of res.Servers ?? []) {
        if (s.ServerId) ids.push(s.ServerId);
      }
      token = res.NextToken;
    } while (token);
    for (const id of ids.slice(0, 10)) {
      try {
        const det = await t.send(new DescribeServerCommand({ ServerId: id }));
        const s = (det.Server ?? {}) as { State?: string; Protocols?: string[] };
        const state = s.State ?? "";
        acc.transfer.push({
          kind: "transfer",
          id,
          protocols: ((s.Protocols ?? []) as string[]).join(", "),
          state,
          region,
          flags:
            state === "OFFLINE"
              ? ["Server offline — still billed hourly while it exists"]
              : [],
        });
        if (state === "OFFLINE")
          acc.waste.push({
            severity: "attention",
            title: `Transfer server ${id} is offline`,
            detail: `In ${region}. Offline servers still incur hourly charges.`,
            action: "Bring it back or delete it.",
            source: "other",
          });
      } catch {
        /* ignore one server */
      }
    }
  } catch {
    /* ignore */
  }
  }
}

export const HOME_REGIONS = [
  "us-west-2",
  "eu-central-1",
  "ap-southeast-2",
];

export type InventoryScope = "ec2" | "rds" | "s3";

export interface Inventory {
  live: boolean;
  scannedRegions: number;
  deepRegions: number;
  homeRegions: string[];
  /** Scopes included in this payload. Absent on a full scan cached before scoped refresh existed. */
  scannedScopes?: InventoryScope[];
  /** True when a full scan collected disks, snapshots, load balancers, and file systems. */
  detailScan?: boolean;
  /** Monotonic cache write id so a slower response cannot overwrite a newer one. */
  cacheRevision?: number;
  instances: LiveInstance[];
  databases: LiveDatabase[];
  buckets: LiveBucket[];
  volumes: LiveVolume[];
  snapshots: LiveSnapshot[];
  lbs: LiveLB[];
  efs: LiveEFS[];
  transfer: LiveTransfer[];
  waste: WasteItem[];
}

async function bucketsInto(acc: { buckets: LiveBucket[]; waste: WasteItem[] }) {
  const s3 = new S3Client(clientConfig());
  const listed = await s3.send(new ListBucketsCommand({}));
  for (const b of listed.Buckets ?? []) {
    const name = b.Name ?? "";
    if (!name) continue;
    let region = "us-east-1";
    try {
      const loc = await s3.send(new GetBucketLocationCommand({ Bucket: name }));
      if (loc.LocationConstraint) region = loc.LocationConstraint;
    } catch {
      /* keep default */
    }
    const rs3 = new S3Client(clientConfig(region));
    let versioning = "off";
    try {
      const v = await rs3.send(new GetBucketVersioningCommand({ Bucket: name }));
      versioning = (v.Status ?? "off").toLowerCase();
    } catch {
      /* ignore */
    }
    let lifecycle = false;
    try {
      await rs3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: name }));
      lifecycle = true;
    } catch {
      lifecycle = false;
    }
    // size + count via listing (buckets here are small; hard cap for safety)
    let bytes = 0;
    let objects = 0;
    let estimated = false;
    try {
      let token: string | undefined;
      let pages = 0;
      do {
        const res = await rs3.send(
          new ListObjectsV2Command({ Bucket: name, ContinuationToken: token, MaxKeys: 1000 })
        );
        for (const o of res.Contents ?? []) {
          bytes += o.Size ?? 0;
          objects++;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
        pages++;
        if (pages >= 20 && token) {
          estimated = true;
          break;
        }
      } while (token);
    } catch {
      /* ignore */
    }
    const flags: string[] = [];
    if (!lifecycle && objects > 0) {
      flags.push("No lifecycle rules — old files pile up forever");
      acc.waste.push({
        severity: "attention",
        title: `Bucket ${name} has no cleanup rules`,
        detail: `${objects} objects with no expiry or archiving policy.`,
        action: "Add a lifecycle rule: expire temp files, archive old ones.",
        source: "s3",
      });
    }
    if (versioning === "enabled" && !lifecycle) {
      flags.push("Versioning on without cleanup — old versions accumulate");
    }
    acc.buckets.push({
      kind: "s3",
      name,
      region,
      sizeGb: Math.round((bytes / 1073741824) * 100) / 100,
      objects,
      estimated,
      versioning,
      lifecycle,
      statusLevel: flags.length ? "attention" : "healthy",
      flags,
    });
  }
}

export async function buildInventory(scope?: InventoryScope): Promise<Inventory> {
  const acc = {
    instances: [] as LiveInstance[],
    databases: [] as LiveDatabase[],
    buckets: [] as LiveBucket[],
    volumes: [] as LiveVolume[],
    snapshots: [] as LiveSnapshot[],
    lbs: [] as LiveLB[],
    efs: [] as LiveEFS[],
    transfer: [] as LiveTransfer[],
    waste: [] as WasteItem[],
  };
  const scannedScopes: InventoryScope[] = scope ? [scope] : ["ec2", "rds", "s3"];
  if (scope === "s3") {
    try {
      await bucketsInto(acc);
    } catch {
      /* s3 best-effort */
    }
    return {
      live: true,
      scannedRegions: 0,
      deepRegions: 0,
      homeRegions: HOME_REGIONS,
      scannedScopes,
      detailScan: false,
      ...acc,
    };
  }
  const seed = new EC2Client(clientConfig());
  const regs = await regions(seed);
  // Phase 1: cheap sweep everywhere (high concurrency — these are tiny calls).
  // A scoped rescan sweeps only that service.
  const CONC_SWEEP = 12;
  const active: string[] = [];
  for (let i = 0; i < regs.length; i += CONC_SWEEP) {
    const chunk = regs.slice(i, i + CONC_SWEEP);
    const hits = await Promise.all(chunk.map((r) => sweepRegion(r, scope)));
    chunk.forEach((r, j) => {
      if (hits[j]) active.push(r);
    });
  }
  // Nothing outside home regions goes unnoticed — it gets flagged instead.
  // Scoped scans leave this row alone; only a full scan has seen every service.
  if (!scope) {
    const outside = active.filter((r) => !HOME_REGIONS.includes(r));
    if (outside.length > 0) {
      acc.waste.push({
        severity: "attention",
        title: `Activity outside your home regions: ${outside.join(", ")}`,
        detail: `Your home regions are ${HOME_REGIONS.join(", ")}. Resources found elsewhere are easy to forget.`,
        action: "Review these regions in the console — move or delete strays.",
        source: "other",
      });
    }
  }
  // Phase 2: deep scan only where the sweep found something.
  const CONC = 8;
  for (let i = 0; i < active.length; i += CONC) {
    await Promise.all(active.slice(i, i + CONC).map((r) => scanRegion(r, acc, scope)));
  }
  if (!scope) {
    try {
      await bucketsInto(acc);
    } catch {
      /* s3 best-effort */
    }
  }
  // attach disk sizes to instances where visible
  const byInstance = new Map<string, number>();
  for (const v of acc.volumes) {
    if (v.attachedTo) byInstance.set(v.attachedTo, (byInstance.get(v.attachedTo) ?? 0) + v.sizeGb);
  }
  for (const inst of acc.instances) {
    if (byInstance.has(inst.id)) inst.diskGb = byInstance.get(inst.id) ?? 0;
  }
  return {
    live: true,
    scannedRegions: regs.length,
    deepRegions: active.length,
    homeRegions: HOME_REGIONS,
    scannedScopes,
    detailScan: !scope,
    ...acc,
  };
}
