// Quality rules, cache TTL, and the RDS coverage baseline.
// Add a metric to the baseline here; the collector does not need a new code path.

export const ALARM_HISTORY_DAYS = 14;

export const alarmQuality = {
  /** OK values within this percent of the limit are a warning. No extra API call. */
  nearThresholdPct: 10,
  /** More ALARM entries than this in the history window is flapping. */
  flapCount: 3,
  /** A recovered episode shorter than this is flapping. */
  shortEpisodeSeconds: 300,
  standardPeriodSeconds: 300,
  standardDatapoints: 3,
};

export function alarmsTtlMs(): number {
  const raw = Number(process.env.ALARMS_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 30_000) return raw;
  return 2 * 60 * 1000;
}

/** ALARMS_REGIONS wins. Otherwise the monitoring allow-list. Empty means every enabled region. */
export function alarmRegionAllowList(): string[] | null {
  const own = process.env.ALARMS_REGIONS?.trim();
  const shared = own || process.env.MONITORING_REGIONS?.trim();
  if (!shared) return null;
  const list = shared.split(",").map((item) => item.trim()).filter(Boolean);
  return list.length ? list : null;
}

export interface BaselineMetric {
  metric: string;
  label: string;
  /** Replica lag applies only to replicas. Primaries are n/a. */
  replicasOnly?: boolean;
}

export const RDS_BASELINE: BaselineMetric[] = [
  { metric: "CPUUtilization", label: "CPU" },
  { metric: "FreeStorageSpace", label: "Free storage" },
  { metric: "FreeableMemory", label: "Freeable memory" },
  { metric: "DiskQueueDepth", label: "Disk queue depth" },
  { metric: "ReplicaLag", label: "Replica lag", replicasOnly: true },
];
