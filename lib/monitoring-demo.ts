import { DEFAULT_WINDOW, WINDOWS } from "./monitoring-config";
import {
  connectionStatus,
  cpuStatus,
  errorRateStatus,
  freeStorageStatus,
  isUnderutilized,
  metric,
  overallHealth,
  percentDisplay,
  statusCheckStatus,
} from "./monitoring-status";
import type { MonitoringPayload, MonitoringResource, ServiceId } from "./monitoring-types";

function finish(resource: Omit<MonitoringResource, "health" | "healthReason">): MonitoringResource {
  const overall = overallHealth(resource.metrics);
  return { ...resource, health: overall.health, healthReason: overall.reason };
}

function ec2(): MonitoringResource[] {
  const rows: MonitoringResource[] = [
    finish({
      service: "ec2",
      id: "i-webprod1",
      name: "web-prod-1",
      region: "ap-south-1",
      state: "running",
      tags: { Team: "web" },
      underutilized: false,
      coverage: null,
      notes: [],
      extras: { instanceType: "m5.large", family: "m5", state: "running" },
      metrics: [
        metric({ id: "cpu", label: "Avg CPU", value: 88, display: percentDisplay(88), status: cpuStatus(88), drivesHealth: true }),
        metric({ id: "networkIn", label: "Network in", value: 42, display: "42.0 MB", status: "no-data", drivesHealth: false }),
        metric({ id: "networkOut", label: "Network out", value: 18, display: "18.0 MB", status: "no-data", drivesHealth: false }),
        metric({ id: "status", label: "Status checks", value: 0, display: "No failures", status: statusCheckStatus(0), drivesHealth: true }),
        metric({ id: "memory", label: "Memory", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
        metric({ id: "disk", label: "Disk", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
      ],
    }),
    finish({
      service: "ec2",
      id: "i-worker1",
      name: "worker-batch-1",
      region: "ap-south-1",
      state: "running",
      tags: { Team: "data" },
      underutilized: isUnderutilized(3, true),
      coverage: null,
      notes: ["Average CPU is under 5%. This is a cost hint, not a health failure."],
      extras: { instanceType: "t3.medium", family: "t3", state: "running" },
      metrics: [
        metric({ id: "cpu", label: "Avg CPU", value: 3, display: percentDisplay(3), status: cpuStatus(3), drivesHealth: true }),
        metric({ id: "networkIn", label: "Network in", value: 1, display: "1.2 MB", status: "no-data", drivesHealth: false }),
        metric({ id: "networkOut", label: "Network out", value: 0.4, display: "0.4 MB", status: "no-data", drivesHealth: false }),
        metric({ id: "status", label: "Status checks", value: 0, display: "No failures", status: statusCheckStatus(0), drivesHealth: true }),
        metric({ id: "credits", label: "CPU credit balance", value: 8, display: "8", status: "no-data", drivesHealth: false }),
        metric({ id: "memory", label: "Memory", value: 71, display: percentDisplay(71), status: "no-data", drivesHealth: false }),
        metric({ id: "disk", label: "Disk", value: 40, display: percentDisplay(40), status: "no-data", drivesHealth: false }),
      ],
    }),
    finish({
      service: "ec2",
      id: "i-staging1",
      name: "api-staging-1",
      region: "us-east-1",
      state: "stopped",
      tags: { Env: "staging" },
      underutilized: isUnderutilized(null, false),
      coverage: "1 of 7 days",
      notes: ["Stopped instances often have no samples. Missing CPU is not shown as 0%."],
      extras: { instanceType: "t3.small", family: "t3", state: "stopped" },
      metrics: [
        metric({ id: "cpu", label: "Avg CPU", value: null, display: "Not available", status: cpuStatus(null), drivesHealth: true }),
        metric({ id: "networkIn", label: "Network in", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
        metric({ id: "networkOut", label: "Network out", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
        metric({ id: "status", label: "Status checks", value: null, display: "Not available", status: statusCheckStatus(null), drivesHealth: true }),
        metric({ id: "memory", label: "Memory", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
        metric({ id: "disk", label: "Disk", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
      ],
    }),
    finish({
      service: "ec2",
      id: "i-webprod2",
      name: "web-prod-2",
      region: "ap-south-1",
      state: "running",
      tags: { Team: "web" },
      underutilized: false,
      coverage: null,
      notes: [],
      extras: { instanceType: "m5.large", family: "m5", state: "running" },
      metrics: [
        metric({ id: "cpu", label: "Avg CPU", value: 54, display: percentDisplay(54), status: cpuStatus(54), drivesHealth: true }),
        metric({ id: "networkIn", label: "Network in", value: 20, display: "20.0 MB", status: "no-data", drivesHealth: false }),
        metric({ id: "networkOut", label: "Network out", value: 11, display: "11.0 MB", status: "no-data", drivesHealth: false }),
        metric({ id: "status", label: "Status checks", value: 0.02, display: "Failures in window", status: statusCheckStatus(0.02), drivesHealth: true }),
        metric({ id: "memory", label: "Memory", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
        metric({ id: "disk", label: "Disk", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
      ],
    }),
  ];
  return rows;
}

function rds(): MonitoringResource[] {
  return [
    finish({
      service: "rds",
      id: "orders-db",
      name: "orders-db",
      region: "ap-south-1",
      state: "available",
      tags: { App: "checkout" },
      underutilized: false,
      coverage: null,
      notes: [],
      extras: { engine: "postgres", class: "db.m5.large", multiAz: true, freeStoragePct: 12 },
      metrics: [
        metric({ id: "cpu", label: "Avg CPU", value: 36, display: percentDisplay(36), status: cpuStatus(36), drivesHealth: true }),
        metric({ id: "memory", label: "Freeable memory", value: 1.2, display: "1.2 GB", status: "no-data", drivesHealth: false }),
        metric({ id: "storage", label: "Free storage", value: 12, display: percentDisplay(12), status: freeStorageStatus(12), drivesHealth: true }),
        metric({ id: "connections", label: "Connections", value: 40, display: "40% of max", status: connectionStatus(40), drivesHealth: true }),
        metric({ id: "iops", label: "IOPS", value: 180, display: "180", status: "no-data", drivesHealth: false }),
        metric({ id: "latency", label: "Latency", value: 2, display: "2 ms", status: "no-data", drivesHealth: false }),
      ],
    }),
    finish({
      service: "rds",
      id: "analytics-db",
      name: "analytics-db",
      region: "us-east-1",
      state: "stopped",
      tags: { App: "analytics" },
      underutilized: false,
      coverage: null,
      notes: ["Stopped database. Missing metrics are not filled with zero."],
      extras: { engine: "mysql", class: "db.t3.medium", multiAz: false, freeStoragePct: null },
      metrics: [
        metric({ id: "cpu", label: "Avg CPU", value: null, display: "Not available", status: cpuStatus(null), drivesHealth: true }),
        metric({ id: "memory", label: "Freeable memory", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
        metric({ id: "storage", label: "Free storage", value: null, display: "Not available", status: freeStorageStatus(null), drivesHealth: true }),
        metric({ id: "connections", label: "Connections", value: null, display: "Not available", status: connectionStatus(null), drivesHealth: true }),
        metric({ id: "iops", label: "IOPS", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
        metric({ id: "latency", label: "Latency", value: null, display: "Not available", status: "no-data", drivesHealth: false }),
      ],
    }),
  ];
}

function s3(): MonitoringResource[] {
  return [
    finish({
      service: "s3",
      id: "app-uploads",
      name: "app-uploads",
      region: "ap-south-1",
      state: "versioned",
      tags: { Data: "uploads" },
      underutilized: false,
      coverage: null,
      notes: ["Size and object count are the latest daily CloudWatch storage values. Days are not averaged."],
      extras: { sizeBytes: 48 * 1024 ** 3, versioning: "Enabled", storageClass: "Standard" },
      metrics: [
        metric({ id: "size", label: "Total size", value: 48, display: "48 GB", status: "no-data", drivesHealth: false }),
        metric({ id: "objects", label: "Objects", value: 120430, display: "120,430", status: "no-data", drivesHealth: false }),
        metric({ id: "requests", label: "Requests", value: 840, display: "840 avg", status: "no-data", drivesHealth: false }),
        metric({ id: "errors", label: "Error rate", value: 0.4, display: percentDisplay(0.4), status: errorRateStatus(0.4), drivesHealth: true }),
      ],
    }),
    finish({
      service: "s3",
      id: "db-backups",
      name: "db-backups",
      region: "us-east-1",
      state: "unversioned",
      tags: {},
      underutilized: false,
      coverage: null,
      notes: ["Request metrics are off for this bucket."],
      extras: { sizeBytes: 210 * 1024 ** 3, versioning: "Off", storageClass: "Glacier" },
      metrics: [
        metric({ id: "size", label: "Total size", value: 210, display: "210 GB", status: "no-data", drivesHealth: false }),
        metric({ id: "objects", label: "Objects", value: 86, display: "86", status: "no-data", drivesHealth: false }),
        metric({ id: "requests", label: "Requests", value: null, display: "Not enabled", status: "no-data", drivesHealth: false }),
        metric({ id: "errors", label: "Error rate", value: null, display: "Not enabled", status: "no-data", drivesHealth: false }),
      ],
    }),
  ];
}

const BY_SERVICE = { ec2: ec2, rds: rds, s3: s3 };

export function demoMonitoring(service: ServiceId, window: typeof DEFAULT_WINDOW = DEFAULT_WINDOW): MonitoringPayload {
  const chosen = WINDOWS[window] ?? WINDOWS[DEFAULT_WINDOW];
  return {
    live: false,
    service,
    window: chosen.id,
    windowLabel: chosen.label,
    asOf: new Date().toISOString(),
    warnings: [
      "Demo data. Add keys to .env.local, then press Rescan on this page to read CloudWatch. Nothing here refreshes on its own.",
    ],
    resources: BY_SERVICE[service](),
  };
}
