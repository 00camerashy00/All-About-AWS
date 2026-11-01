import type { RawAlarm, RawHistoryEvent, ResourceHint } from "./alarms-types";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const SNS = "arn:aws:sns:ap-south-1:123456789012:db-alarms";

function metric(input: {
  name: string;
  resource: string;
  region?: string;
  namespace?: string;
  dimension?: string;
  metric: string;
  comparison: string;
  threshold: number;
  period?: number;
  evaluationPeriods?: number;
  datapointsToAlarm?: number;
  state?: RawAlarm["state"];
  at?: string;
  recent?: number[];
  actions?: string[];
  actionsEnabled?: boolean;
  treatMissingData?: string;
  reason?: string;
}): RawAlarm {
  return {
    name: input.name,
    region: input.region ?? "ap-south-1",
    kind: "metric",
    namespace: input.namespace ?? "AWS/RDS",
    metricName: input.metric,
    dimensions: [{ name: input.dimension ?? "DBInstanceIdentifier", value: input.resource }],
    comparison: input.comparison,
    threshold: input.threshold,
    period: input.period ?? 300,
    evaluationPeriods: input.evaluationPeriods ?? 3,
    datapointsToAlarm: input.datapointsToAlarm ?? 3,
    treatMissingData: input.treatMissingData ?? "missing",
    state: input.state ?? "OK",
    stateUpdatedAt: input.at ?? "2026-09-20T08:00:00.000Z",
    stateReason: input.reason ?? "Threshold not crossed.",
    recentValues: input.recent ?? [],
    actions: input.actions ?? [SNS],
    actionsEnabled: input.actionsEnabled ?? true,
  };
}

function standard(id: string, storageGb: number, memoryMb: number, queue: number | null, replica: boolean): RawAlarm[] {
  const rows = [
    metric({ name: `${id}-cpu`, resource: id, metric: "CPUUtilization", comparison: "GreaterThanOrEqualToThreshold", threshold: 90, recent: id === "indiana-uat" ? [82] : [40] }),
    metric({ name: `${id}-storage`, resource: id, metric: "FreeStorageSpace", comparison: "LessThanThreshold", threshold: storageGb * GB, recent: [40 * GB] }),
    metric({ name: `${id}-memory`, resource: id, metric: "FreeableMemory", comparison: "LessThanThreshold", threshold: memoryMb * MB, recent: [2 * GB] }),
  ];
  if (queue != null) {
    rows.push(metric({ name: `${id}-queue`, resource: id, metric: "DiskQueueDepth", comparison: "GreaterThanOrEqualToThreshold", threshold: queue, recent: [2] }));
  }
  if (replica) {
    rows.push(metric({ name: `${id}-lag`, resource: id, metric: "ReplicaLag", comparison: "GreaterThanOrEqualToThreshold", threshold: 60, recent: [4] }));
  }
  return rows;
}

export const alarmFixtures: RawAlarm[] = [
  ...standard("indiana-production", 15, 512, 24, false),
  ...standard("indiana-production-query", 15, 512, null, true),
  ...standard("indiana-uat", 10, 256, 32, false),
  ...standard("indiana-uat-read-replica", 10, 256, 32, true),
  metric({
    name: "iu-prod-clone-1-read-iops",
    resource: "iu-prod-clone-1",
    region: "us-west-2",
    metric: "ReadIOPS",
    comparison: "GreaterThanThreshold",
    threshold: 2000,
    period: 60,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    state: "ALARM",
    at: "2026-09-21T12:10:41.000Z",
    recent: [2248.2089203415694],
    actions: ["arn:aws:sns:us-west-2:123456789012:db-alarms"],
    reason: "Threshold Crossed: 1 out of the last 1 datapoints [2248.2089203415694] was greater than the threshold (2000.0).",
  }),
  metric({
    name: "indiana-production-write-iops-legacy",
    resource: "indiana-production",
    metric: "WriteIOPS",
    comparison: "GreaterThanThreshold",
    threshold: 30,
    period: 60,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    recent: [12],
    reason: "Old single-minute write alarm kept as a noise example.",
  }),
  {
    name: "indiana-production-composite",
    region: "ap-south-1",
    kind: "composite",
    dimensions: [],
    state: "OK",
    stateUpdatedAt: "2026-09-20T08:00:00.000Z",
    stateReason: "Composite is OK.",
    recentValues: [],
    actions: [SNS],
    actionsEnabled: true,
    alarmRule: 'ALARM("indiana-production-cpu") OR ALARM("indiana-production-storage")',
  },
  {
    name: "indiana-production-math",
    region: "ap-south-1",
    kind: "math",
    namespace: "AWS/RDS",
    metricName: "CPUUtilization",
    dimensions: [{ name: "DBInstanceIdentifier", value: "indiana-production" }],
    comparison: "GreaterThanThreshold",
    threshold: 1,
    period: 300,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    state: "OK",
    stateUpdatedAt: "2026-09-20T08:00:00.000Z",
    stateReason: "Metric math alarm.",
    recentValues: [],
    actions: [SNS],
    actionsEnabled: true,
    expression: "m1/m2",
  },
  {
    name: "indiana-production-anomaly",
    region: "ap-south-1",
    kind: "anomaly",
    namespace: "AWS/RDS",
    metricName: "CPUUtilization",
    dimensions: [{ name: "DBInstanceIdentifier", value: "indiana-production" }],
    comparison: "LessThanLowerOrGreaterThanUpperThreshold",
    threshold: null,
    period: 300,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    state: "OK",
    stateUpdatedAt: "2026-09-20T08:00:00.000Z",
    stateReason: "Anomaly detection band.",
    recentValues: [],
    actions: [SNS],
    actionsEnabled: true,
  },
  {
    name: "custom-billing-unmapped",
    region: "ap-south-1",
    kind: "metric",
    namespace: "Custom/Billing",
    metricName: "InvoiceLag",
    dimensions: [],
    comparison: "GreaterThanThreshold",
    threshold: 2,
    period: 300,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    state: "OK",
    stateUpdatedAt: "2026-09-20T08:00:00.000Z",
    stateReason: "No resource dimension.",
    recentValues: [1],
    actions: [SNS],
    actionsEnabled: true,
  },
  metric({
    name: "i-worker1-status",
    resource: "i-worker1",
    namespace: "AWS/EC2",
    dimension: "InstanceId",
    metric: "StatusCheckFailed",
    comparison: "GreaterThanThreshold",
    threshold: 0,
    state: "ALARM",
    at: "2026-10-15T04:00:00.000Z",
    recent: [1],
    reason: "Status check failed.",
  }),
  metric({
    name: "app-uploads-errors",
    resource: "app-uploads",
    namespace: "AWS/S3",
    dimension: "BucketName",
    metric: "4xxErrors",
    comparison: "GreaterThanThreshold",
    threshold: 50,
    recent: [3],
  }),
  metric({
    name: "deleted-db-cpu",
    resource: "deleted-db",
    metric: "CPUUtilization",
    comparison: "GreaterThanOrEqualToThreshold",
    threshold: 90,
    state: "INSUFFICIENT_DATA",
    recent: [],
    treatMissingData: "notBreaching",
    reason: "Database is gone. No value is invented.",
  }),
  metric({
    name: "i-staging1-cpu-silent",
    resource: "i-staging1",
    namespace: "AWS/EC2",
    dimension: "InstanceId",
    metric: "CPUUtilization",
    comparison: "GreaterThanOrEqualToThreshold",
    threshold: 90,
    recent: [10],
    actions: [],
    actionsEnabled: false,
  }),
];

export const historyFixtures: RawHistoryEvent[] = [
  { alarmName: "iu-prod-clone-1-read-iops", region: "us-west-2", at: "2026-09-21T12:10:41.000Z", oldState: "OK", newState: "ALARM" },
  { alarmName: "indiana-production-write-iops-legacy", region: "ap-south-1", at: "2026-09-21T12:10:00.000Z", oldState: "OK", newState: "ALARM" },
  { alarmName: "indiana-production-write-iops-legacy", region: "ap-south-1", at: "2026-09-21T12:14:00.000Z", oldState: "ALARM", newState: "OK" },
  { alarmName: "indiana-production-write-iops-legacy", region: "ap-south-1", at: "2026-09-21T12:20:00.000Z", oldState: "OK", newState: "ALARM" },
  { alarmName: "indiana-production-write-iops-legacy", region: "ap-south-1", at: "2026-09-21T12:22:00.000Z", oldState: "ALARM", newState: "OK" },
];

export const resourceHints: ResourceHint[] = [
  { service: "rds", id: "indiana-production", name: "indiana-production", region: "ap-south-1", role: "primary", performanceInsights: false },
  { service: "rds", id: "indiana-production-query", name: "indiana-production-query", region: "ap-south-1", role: "replica", performanceInsights: false },
  { service: "rds", id: "indiana-uat", name: "indiana-uat", region: "ap-south-1", role: "primary", performanceInsights: false },
  { service: "rds", id: "indiana-uat-read-replica", name: "indiana-uat-read-replica", region: "ap-south-1", role: "replica", performanceInsights: false },
  { service: "rds", id: "iu-prod-clone-1", name: "iu-prod-clone-1", region: "us-west-2", role: "primary", performanceInsights: true },
  { service: "ec2", id: "i-worker1", name: "worker-batch-1", region: "ap-south-1", role: "unknown", performanceInsights: null },
  { service: "ec2", id: "i-staging1", name: "api-staging-1", region: "ap-south-1", role: "unknown", performanceInsights: null },
  { service: "s3", id: "app-uploads", name: "app-uploads", region: "ap-south-1", role: "unknown", performanceInsights: null },
];
