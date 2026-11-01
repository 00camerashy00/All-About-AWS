import type { WindowId } from "./monitoring-config";
import type { Health, MetricValue } from "./monitoring-status";

export type ServiceId = "ec2" | "rds" | "s3";

export interface MonitoringResource {
  service: ServiceId;
  id: string;
  name: string;
  region: string;
  state: string;
  tags: Record<string, string>;
  health: Health;
  healthReason: string;
  underutilized: boolean;
  coverage: string | null;
  metrics: MetricValue[];
  notes: string[];
  extras: Record<string, string | number | boolean | null>;
}

export interface MonitoringPayload {
  live: boolean;
  service: ServiceId;
  window: WindowId;
  windowLabel: string;
  asOf: string;
  warnings: string[];
  resources: MonitoringResource[];
}

export type { Health, MetricValue, WindowId };
