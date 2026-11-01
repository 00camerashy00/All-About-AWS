export type Health = "healthy" | "attention" | "critical";
export type ResourceKind = "ec2" | "rds" | "s3";

export interface AwsResource {
  id: string;
  name: string;
  kind: ResourceKind;
  plainType: string;
  region: string;
  status: Health;
  cpu: number;
  ram: number;
  storage: number;
  insight: string;
}

export const resources: AwsResource[] = [
  {
    id: "web-prod-1",
    name: "web-prod-1",
    kind: "ec2",
    plainType: "Virtual server",
    region: "ap-south-1",
    status: "critical",
    cpu: 87,
    ram: 78,
    storage: 62,
    insight: "Overloaded for 2 days — CPU above 80%. Requests may slow down.",
  },
  {
    id: "web-prod-2",
    name: "web-prod-2",
    kind: "ec2",
    plainType: "Virtual server",
    region: "ap-south-1",
    status: "healthy",
    cpu: 34,
    ram: 41,
    storage: 38,
    insight: "Running normally — plenty of headroom.",
  },
  {
    id: "worker-batch-1",
    name: "worker-batch-1",
    kind: "ec2",
    plainType: "Virtual server",
    region: "ap-south-1",
    status: "healthy",
    cpu: 8,
    ram: 12,
    storage: 25,
    insight: "CPU is under 10%. Usage is light and the server is healthy.",
  },
  {
    id: "api-staging-1",
    name: "api-staging-1",
    kind: "ec2",
    plainType: "Virtual server",
    region: "us-east-1",
    status: "healthy",
    cpu: 27,
    ram: 33,
    storage: 29,
    insight: "Running normally for staging use.",
  },
  {
    id: "orders-db",
    name: "orders-db",
    kind: "rds",
    plainType: "Database",
    region: "ap-south-1",
    status: "attention",
    cpu: 58,
    ram: 64,
    storage: 85,
    insight: "Storage 85% full — will run out in about 20 days at current growth.",
  },
  {
    id: "analytics-db",
    name: "analytics-db",
    kind: "rds",
    plainType: "Database",
    region: "ap-south-1",
    status: "healthy",
    cpu: 31,
    ram: 38,
    storage: 46,
    insight: "Healthy — usage is steady and storage is comfortable.",
  },
  {
    id: "app-uploads",
    name: "app-uploads",
    kind: "s3",
    plainType: "File storage",
    region: "ap-south-1",
    status: "healthy",
    cpu: 12,
    ram: 0,
    storage: 54,
    insight: "Growing normally — 540 GB of 1 TB used, mostly backups and uploads.",
  },
  {
    id: "db-backups",
    name: "db-backups",
    kind: "s3",
    plainType: "File storage",
    region: "ap-south-1",
    status: "attention",
    cpu: 5,
    ram: 0,
    storage: 91,
    insight: "Almost full and growing fast — duplicate daily backups detected.",
  },
];
