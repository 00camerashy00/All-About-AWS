import { CloudWatchClient, DescribeAlarmHistoryCommand, DescribeAlarmsCommand, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeInstancesCommand, DescribeRegionsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { requireAccount } from "@/lib/account-store";
import { accountClientConfig } from "@/lib/aws";
import { ALARM_HISTORY_DAYS, alarmRegionAllowList } from "@/lib/alarms-config";
import { buildAlarmViews } from "@/lib/alarms-model";
import type { AlarmsPayload, RawAlarm, RawHistoryEvent, ResourceHint } from "@/lib/alarms-types";
import type { AlarmKind, AlarmState } from "@/lib/alarms-english";
import { soleCloudWatchValue } from "@/lib/monitoring-status";

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

export async function buildLiveAlarms(): Promise<AlarmsPayload> {
  const warnings = [
    "Alarm history from CloudWatch covers 14 days. State times are StateUpdatedTimestamp, not email delivery time.",
    "One account only. SNS subscribers are not listed; the alarm's action ARNs are shown as configured.",
  ];
  const regions = await enabledRegions(warnings);
  const alarms: RawAlarm[] = [];
  const hints: ResourceHint[] = [];
  const inventory = new Set<"ec2" | "rds" | "s3">();
  await mapPool(regions, 4, async (region) => {
    try {
      alarms.push(...(await alarmsIn(region)));
    } catch (error) {
      warnings.push(`Region ${region} alarms could not be listed (${nameOf(error)}). That region is omitted, not shown as empty.`);
      return;
    }
    try {
      hints.push(...(await databaseHints(region)));
      inventory.add("rds");
    } catch (error) {
      warnings.push(`Region ${region} databases could not be listed (${nameOf(error)}). Replica lag is not marked n/a there.`);
    }
    try {
      hints.push(...(await instanceHints(region)));
      inventory.add("ec2");
    } catch (error) {
      warnings.push(`Region ${region} instances could not be listed (${nameOf(error)}).`);
    }
  });
  const history: RawHistoryEvent[] = [];
  await mapPool(alarms, 4, async (alarm) => {
    try {
      history.push(...(await historyFor(alarm)));
    } catch (error) {
      warnings.push(`History for ${alarm.name} in ${alarm.region} failed (${nameOf(error)}). The alarm is still listed.`);
    }
  });
  const metricCalls = await fillMissingValues(alarms, warnings);
  const inventoryServices: Array<"ec2" | "rds" | "s3"> = [];
  inventory.forEach((service) => inventoryServices.push(service));
  return buildAlarmViews(alarms, history, hints, {
    live: true,
    warnings,
    metricCalls,
    inventoryServices,
  });
}

async function enabledRegions(warnings: string[]): Promise<string[]> {
  const allow = alarmRegionAllowList();
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

async function alarmsIn(region: string): Promise<RawAlarm[]> {
  const cw = new CloudWatchClient(accountClientConfig(region));
  const found: RawAlarm[] = [];
  let token: string | undefined;
  do {
    const page = await withBackoff(() =>
      cw.send(new DescribeAlarmsCommand({ NextToken: token, MaxRecords: 100, AlarmTypes: ["MetricAlarm", "CompositeAlarm"] }))
    );
    for (const alarm of page.MetricAlarms ?? []) {
      if (!alarm.AlarmName) continue;
      found.push(metricFrom(alarm, region));
    }
    for (const alarm of page.CompositeAlarms ?? []) {
      if (!alarm.AlarmName) continue;
      found.push({
        name: alarm.AlarmName,
        region,
        kind: "composite",
        dimensions: [],
        state: stateOf(alarm.StateValue),
        stateUpdatedAt: (alarm.StateUpdatedTimestamp ?? new Date()).toISOString(),
        stateReason: alarm.StateReason ?? "",
        recentValues: [],
        actions: alarm.AlarmActions ?? [],
        actionsEnabled: alarm.ActionsEnabled !== false,
        alarmRule: alarm.AlarmRule ?? "",
      });
    }
    token = page.NextToken;
  } while (token);
  return found;
}

function metricFrom(alarm: {
  AlarmName?: string;
  Namespace?: string;
  MetricName?: string;
  Dimensions?: { Name?: string; Value?: string }[];
  ComparisonOperator?: string;
  Threshold?: number;
  Period?: number;
  EvaluationPeriods?: number;
  DatapointsToAlarm?: number;
  TreatMissingData?: string;
  StateValue?: string;
  StateUpdatedTimestamp?: Date;
  StateReason?: string;
  StateReasonData?: string;
  AlarmActions?: string[];
  ActionsEnabled?: boolean;
  Metrics?: { Expression?: string; Id?: string }[];
  ThresholdMetricId?: string;
}, region: string): RawAlarm {
  const expression = alarm.Metrics?.find((item) => item.Expression)?.Expression ?? null;
  const kind: AlarmKind = alarm.ThresholdMetricId || alarm.ComparisonOperator === "LessThanLowerOrGreaterThanUpperThreshold"
    ? "anomaly"
    : expression
      ? "math"
      : "metric";
  return {
    name: alarm.AlarmName ?? "",
    region,
    kind,
    namespace: alarm.Namespace,
    metricName: alarm.MetricName,
    dimensions: (alarm.Dimensions ?? []).map((item) => ({ name: item.Name ?? "", value: item.Value ?? "" })).filter((item) => item.name),
    comparison: alarm.ComparisonOperator ?? null,
    threshold: alarm.Threshold ?? null,
    period: alarm.Period ?? null,
    evaluationPeriods: alarm.EvaluationPeriods ?? null,
    datapointsToAlarm: alarm.DatapointsToAlarm ?? alarm.EvaluationPeriods ?? null,
    treatMissingData: alarm.TreatMissingData ?? null,
    state: stateOf(alarm.StateValue),
    stateUpdatedAt: (alarm.StateUpdatedTimestamp ?? new Date()).toISOString(),
    stateReason: alarm.StateReason ?? "",
    recentValues: recentValues(alarm.StateReasonData),
    actions: alarm.AlarmActions ?? [],
    actionsEnabled: alarm.ActionsEnabled !== false,
    expression,
  };
}

function recentValues(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { recentDatapoints?: number[]; evaluatedDatapoints?: { value?: number }[] };
    const points = parsed.recentDatapoints ?? (parsed.evaluatedDatapoints ?? []).map((item) => item.value);
    return (points ?? []).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  } catch {
    return [];
  }
}

function stateOf(value: string | undefined): AlarmState {
  if (value === "ALARM" || value === "OK" || value === "INSUFFICIENT_DATA") return value;
  return "INSUFFICIENT_DATA";
}

async function historyFor(alarm: RawAlarm): Promise<RawHistoryEvent[]> {
  const cw = new CloudWatchClient(accountClientConfig(alarm.region));
  const start = new Date(Date.now() - ALARM_HISTORY_DAYS * 86_400 * 1000);
  const events: RawHistoryEvent[] = [];
  let token: string | undefined;
  do {
    const page = await withBackoff(() =>
      cw.send(
        new DescribeAlarmHistoryCommand({
          AlarmName: alarm.name,
          HistoryItemType: "StateUpdate",
          StartDate: start,
          EndDate: new Date(),
          NextToken: token,
          MaxRecords: 50,
        })
      )
    );
    for (const item of page.AlarmHistoryItems ?? []) {
      const parsed = parseHistory(item.HistoryData);
      if (!parsed || !item.Timestamp) continue;
      events.push({ alarmName: alarm.name, region: alarm.region, at: item.Timestamp.toISOString(), oldState: parsed.oldState, newState: parsed.newState });
    }
    token = page.NextToken;
  } while (token);
  return events;
}

function parseHistory(raw: string | undefined): { oldState: AlarmState | null; newState: AlarmState } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { oldState?: { stateValue?: string }; newState?: { stateValue?: string } };
    if (!parsed.newState?.stateValue) return null;
    const next = stateOf(parsed.newState.stateValue);
    const previous = parsed.oldState?.stateValue ? stateOf(parsed.oldState.stateValue) : null;
    return { oldState: previous, newState: next };
  } catch {
    return null;
  }
}

async function databaseHints(region: string): Promise<ResourceHint[]> {
  const rds = new RDSClient(accountClientConfig(region));
  const hints: ResourceHint[] = [];
  let marker: string | undefined;
  do {
    const page = await withBackoff(() => rds.send(new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 })));
    for (const db of page.DBInstances ?? []) {
      if (!db.DBInstanceIdentifier) continue;
      hints.push({
        service: "rds",
        id: db.DBInstanceIdentifier,
        name: db.DBInstanceIdentifier,
        region,
        role: db.ReadReplicaSourceDBInstanceIdentifier ? "replica" : "primary",
        performanceInsights: db.PerformanceInsightsEnabled ?? null,
      });
    }
    marker = page.Marker;
  } while (marker);
  return hints;
}

async function instanceHints(region: string): Promise<ResourceHint[]> {
  const ec2 = new EC2Client(accountClientConfig(region));
  const hints: ResourceHint[] = [];
  let token: string | undefined;
  do {
    const page = await withBackoff(() => ec2.send(new DescribeInstancesCommand({ NextToken: token, MaxResults: 100 })));
    for (const reservation of page.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (!instance.InstanceId || instance.State?.Name === "terminated") continue;
        const name = instance.Tags?.find((tag) => tag.Key === "Name")?.Value || instance.InstanceId;
        hints.push({ service: "ec2", id: instance.InstanceId, name, region, role: "unknown", performanceInsights: null });
      }
    }
    token = page.NextToken;
  } while (token);
  return hints;
}

async function fillMissingValues(alarms: RawAlarm[], warnings: string[]): Promise<number> {
  const pending = alarms.filter(
    (alarm) => alarm.kind === "metric" && alarm.recentValues.length === 0 && alarm.state !== "INSUFFICIENT_DATA" && alarm.namespace && alarm.metricName && alarm.period
  );
  const byRegion = new Map<string, RawAlarm[]>();
  for (const alarm of pending) {
    const list = byRegion.get(alarm.region) ?? [];
    list.push(alarm);
    byRegion.set(alarm.region, list);
  }
  let calls = 0;
  const regions: string[] = [];
  byRegion.forEach((_group, region) => regions.push(region));
  await mapPool(regions, 3, async (region) => {
    const group = byRegion.get(region) ?? [];
    const byPeriod = new Map<number, RawAlarm[]>();
    for (const alarm of group) {
      const period = alarm.period ?? 300;
      const list = byPeriod.get(period) ?? [];
      list.push(alarm);
      byPeriod.set(period, list);
    }
    const cw = new CloudWatchClient(accountClientConfig(region));
    const batches: RawAlarm[][] = [];
    byPeriod.forEach((list) => batches.push(list));
    for (const batch of batches) {
      for (let offset = 0; offset < batch.length; offset += 400) {
        const slice = batch.slice(offset, offset + 400);
        const period = slice[0].period ?? 300;
        calls += 1;
        const end = new Date();
        try {
          const result = await withBackoff(() =>
            cw.send(
              new GetMetricDataCommand({
                StartTime: new Date(end.getTime() - period * 1000),
                EndTime: end,
                MetricDataQueries: slice.map((alarm, index) => ({
                  Id: `a${index}`,
                  MetricStat: {
                    Metric: {
                      Namespace: alarm.namespace,
                      MetricName: alarm.metricName,
                      Dimensions: alarm.dimensions.map((item) => ({ Name: item.name, Value: item.value })),
                    },
                    Period: period,
                    Stat: "Average",
                  },
                  ReturnData: true,
                })),
              })
            )
          );
          for (const row of result.MetricDataResults ?? []) {
            const index = Number((row.Id ?? "").slice(1));
            const target = slice[index];
            if (!target) continue;
            const sole = soleCloudWatchValue(row.Values);
            if (sole.rejected) {
              if (!warnings.includes("A current-value query returned more than one point and was left blank.")) {
                warnings.push("A current-value query returned more than one point and was left blank.");
              }
            } else if (sole.value != null) target.recentValues = [sole.value];
          }
        } catch (error) {
          warnings.push(`Current values in ${region} were not loaded (${nameOf(error)}). Missing numbers stay blank.`);
        }
      }
    }
  });
  return calls;
}

function nameOf(error: unknown): string {
  return (error as { name?: string }).name ?? "error";
}
