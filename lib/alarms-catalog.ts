// Friendly names, units, and direction. A new metric is a new entry, not a pipeline change.

export type UnitKind = "percent" | "bytes" | "seconds" | "count";
export type Direction = "higher" | "lower";
export type ServiceTab = "ec2" | "rds" | "s3" | "unmapped";

export interface MetricCatalogEntry {
  namespace: string;
  metric: string;
  friendly: string;
  ruleName: string;
  unit: UnitKind;
  direction: Direction;
  explain: string;
}

export const METRIC_CATALOG: MetricCatalogEntry[] = [
  { namespace: "AWS/EC2", metric: "CPUUtilization", friendly: "CPU usage", ruleName: "CPU", unit: "percent", direction: "higher", explain: "Share of CPU in use on the instance." },
  { namespace: "AWS/EC2", metric: "StatusCheckFailed", friendly: "status check failures", ruleName: "Status check failures", unit: "count", direction: "higher", explain: "Instance or system checks that failed." },
  { namespace: "AWS/EC2", metric: "NetworkIn", friendly: "network in", ruleName: "Network in", unit: "bytes", direction: "higher", explain: "Bytes received." },
  { namespace: "AWS/RDS", metric: "CPUUtilization", friendly: "CPU usage", ruleName: "CPU", unit: "percent", direction: "higher", explain: "Share of CPU in use on the database." },
  { namespace: "AWS/RDS", metric: "FreeStorageSpace", friendly: "free storage space", ruleName: "Free storage space", unit: "bytes", direction: "lower", explain: "Bytes still free on the database volume." },
  { namespace: "AWS/RDS", metric: "FreeableMemory", friendly: "freeable memory", ruleName: "Freeable memory", unit: "bytes", direction: "lower", explain: "Memory the database can give back." },
  { namespace: "AWS/RDS", metric: "DiskQueueDepth", friendly: "disk queue depth", ruleName: "Disk queue depth", unit: "count", direction: "higher", explain: "Waiting disk operations." },
  { namespace: "AWS/RDS", metric: "ReplicaLag", friendly: "replica lag", ruleName: "Replica lag", unit: "seconds", direction: "higher", explain: "How far a replica is behind its primary." },
  { namespace: "AWS/RDS", metric: "ReadIOPS", friendly: "read IOPS", ruleName: "read IOPS", unit: "count", direction: "higher", explain: "Average read operations per second." },
  { namespace: "AWS/RDS", metric: "WriteIOPS", friendly: "write IOPS", ruleName: "write IOPS", unit: "count", direction: "higher", explain: "Average write operations per second." },
  { namespace: "AWS/RDS", metric: "DatabaseConnections", friendly: "database connections", ruleName: "Database connections", unit: "count", direction: "higher", explain: "Open connections." },
  { namespace: "AWS/S3", metric: "4xxErrors", friendly: "client errors", ruleName: "Client errors", unit: "count", direction: "higher", explain: "Requests that failed with a 4xx status." },
  { namespace: "AWS/S3", metric: "5xxErrors", friendly: "server errors", ruleName: "Server errors", unit: "count", direction: "higher", explain: "Requests that failed with a 5xx status." },
  { namespace: "AWS/S3", metric: "BucketSizeBytes", friendly: "bucket size", ruleName: "Bucket size", unit: "bytes", direction: "higher", explain: "Stored bytes." },
  { namespace: "AWS/Lambda", metric: "Errors", friendly: "function errors", ruleName: "Function errors", unit: "count", direction: "higher", explain: "Invocations that failed." },
  { namespace: "AWS/EBS", metric: "VolumeQueueLength", friendly: "volume queue length", ruleName: "Volume queue length", unit: "count", direction: "higher", explain: "Waiting operations on the disk." },
  { namespace: "AWS/ApplicationELB", metric: "HTTPCode_Target_5XX_Count", friendly: "target 5xx errors", ruleName: "Target 5xx errors", unit: "count", direction: "higher", explain: "Errors from the targets." },
  { namespace: "AWS/DynamoDB", metric: "ConsumedReadCapacityUnits", friendly: "read capacity", ruleName: "Read capacity", unit: "count", direction: "higher", explain: "Consumed read capacity." },
];

const RESOURCE_DIMENSION: Record<string, string> = {
  "AWS/RDS": "DBInstanceIdentifier",
  "AWS/EC2": "InstanceId",
  "AWS/S3": "BucketName",
  "AWS/Lambda": "FunctionName",
  "AWS/EBS": "VolumeId",
  "AWS/ApplicationELB": "LoadBalancer",
  "AWS/ELB": "LoadBalancerName",
  "AWS/DynamoDB": "TableName",
};

const NAMESPACE_SERVICE: Record<string, Exclude<ServiceTab, "unmapped">> = {
  "AWS/EC2": "ec2",
  "AWS/RDS": "rds",
  "AWS/S3": "s3",
};

export const REGION_NAMES: Record<string, string> = {
  "us-east-1": "N. Virginia",
  "us-east-2": "Ohio",
  "us-west-1": "N. California",
  "us-west-2": "Oregon",
  "ap-south-1": "Mumbai",
  "ap-southeast-1": "Singapore",
  "ap-southeast-2": "Sydney",
  "eu-west-1": "Ireland",
  "eu-central-1": "Frankfurt",
};

export function catalogEntry(namespace: string | undefined, metric: string | undefined): MetricCatalogEntry | null {
  if (!namespace || !metric) return null;
  return METRIC_CATALOG.find((entry) => entry.namespace === namespace && entry.metric === metric) ?? null;
}

export function regionDisplayName(code: string): string {
  return REGION_NAMES[code] ?? code;
}

export function serviceForNamespace(namespace: string | undefined): ServiceTab {
  if (!namespace) return "unmapped";
  return NAMESPACE_SERVICE[namespace] ?? "unmapped";
}

export function resourceDimension(namespace: string | undefined): string | null {
  if (!namespace) return null;
  return RESOURCE_DIMENSION[namespace] ?? null;
}
