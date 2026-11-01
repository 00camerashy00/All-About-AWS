import type { ServiceTab } from "./alarms-catalog";
import type { AlarmKind, AlarmState } from "./alarms-english";

export type Cue = "alarm" | "ok" | "insufficient" | "warning";
export type CoverageStatus = "present" | "noisy" | "missing" | "na" | "unknown";
export type ResourceRole = "primary" | "replica" | "unknown";

export interface RawAlarm {
  name: string;
  region: string;
  kind: AlarmKind;
  namespace?: string;
  metricName?: string;
  dimensions: { name: string; value: string }[];
  comparison?: string | null;
  threshold?: number | null;
  period?: number | null;
  evaluationPeriods?: number | null;
  datapointsToAlarm?: number | null;
  treatMissingData?: string | null;
  state: AlarmState;
  stateUpdatedAt: string;
  stateReason: string;
  recentValues: number[];
  actions: string[];
  actionsEnabled: boolean;
  expression?: string | null;
  alarmRule?: string | null;
}

export interface RawHistoryEvent {
  alarmName: string;
  region: string;
  at: string;
  oldState: AlarmState | null;
  newState: AlarmState;
}

export interface ResourceHint {
  service: "ec2" | "rds" | "s3";
  id: string;
  name: string;
  region: string;
  role: ResourceRole;
  performanceInsights: boolean | null;
}

export interface HistoryEpisode {
  startedAt: string;
  endedAt: string | null;
  durationLabel: string;
  sentence: string;
}

export interface AlarmView {
  id: string;
  name: string;
  region: string;
  regionName: string;
  service: ServiceTab;
  resourceId: string | null;
  resourceName: string | null;
  orphaned: boolean;
  metricName: string | null;
  friendlyMetric: string;
  state: AlarmState;
  cue: Cue;
  stateUpdatedAt: string;
  headline: string;
  rule: string;
  valueLine: string | null;
  closeness: string | null;
  closenessNote: string | null;
  missingData: string;
  noiseProne: boolean;
  noiseReasons: string[];
  flapping: boolean;
  flapCount: number;
  shortEpisodes: number;
  noAction: boolean;
  actionsDisabled: boolean;
  advanced: boolean;
  expression: string | null;
  actions: string[];
  links: { alarm: string; resource: string | null; performanceInsights: string | null; monitoring: string | null };
  gauge: { value: number; limit: number; direction: "higher" | "lower" } | null;
  history: HistoryEpisode[];
  stateReason: string;
}

export interface CoverageCell {
  status: CoverageStatus;
  alarmName: string | null;
}

export interface CoverageRow {
  resourceId: string;
  name: string;
  region: string;
  role: ResourceRole;
  cells: Record<string, CoverageCell>;
}

export interface AlarmsPayload {
  live: boolean;
  asOf: string;
  historyRetentionDays: number;
  warnings: string[];
  estimate: { regions: number; alarms: number; describeAlarms: number; historyCalls: number; metricCalls: number; note: string };
  alarms: AlarmView[];
  coverage: { metrics: { id: string; label: string }[]; rows: CoverageRow[] };
  summary: Record<ServiceTab, { alarm: number; ok: number; insufficient: number; warning: number }>;
}
