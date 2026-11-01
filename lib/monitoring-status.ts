import { thresholds } from "./monitoring-config";

export type Health = "healthy" | "medium" | "overloaded" | "no-data";

export interface MetricValue {
  id: string;
  label: string;
  value: number | null;
  display: string;
  status: Health;
  drivesHealth: boolean;
}

const RANK: Record<Health, number> = {
  "no-data": 0,
  healthy: 1,
  medium: 2,
  overloaded: 3,
};

/**
 * CloudWatch already aggregated this metric. More than one value means the
 * period was not the full window, and this app refuses to average them.
 */
export function soleCloudWatchValue(values: number[] | undefined | null): {
  value: number | null;
  rejected: boolean;
} {
  if (!values || values.length === 0) return { value: null, rejected: false };
  if (values.length !== 1 || !Number.isFinite(values[0])) return { value: null, rejected: true };
  return { value: values[0], rejected: false };
}

/**
 * S3 storage metrics are published once a day. This picks the newest daily
 * value. It does not average the days together.
 */
export function latestDailyValue(
  values: number[] | undefined | null,
  timestamps?: (Date | string)[] | null
): { value: number | null; rejected: boolean } {
  if (!values || values.length === 0) return { value: null, rejected: false };
  if (values.length === 1) {
    return Number.isFinite(values[0]) ? { value: values[0], rejected: false } : { value: null, rejected: true };
  }
  if (!timestamps || timestamps.length !== values.length) return { value: null, rejected: true };
  let best = -1;
  let bestTime = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    const time = new Date(timestamps[i]).getTime();
    if (Number.isFinite(time) && time >= bestTime) {
      bestTime = time;
      best = i;
    }
  }
  if (best < 0) return { value: null, rejected: true };
  return { value: values[best], rejected: false };
}

export function cpuStatus(cpu: number | null, medium = thresholds.ec2.cpuMedium, overloaded = thresholds.ec2.cpuOverloaded): Health {
  if (cpu == null) return "no-data";
  if (cpu > overloaded) return "overloaded";
  if (cpu >= medium) return "medium";
  return "healthy";
}

export function freeStorageStatus(freePct: number | null): Health {
  if (freePct == null) return "no-data";
  if (freePct < thresholds.rds.freeStorageOverloadedPct) return "overloaded";
  if (freePct < thresholds.rds.freeStorageMediumPct) return "medium";
  return "healthy";
}

export function connectionStatus(pctOfMax: number | null): Health {
  if (pctOfMax == null) return "no-data";
  if (pctOfMax > thresholds.rds.connectionsOverloadedPct) return "overloaded";
  if (pctOfMax > thresholds.rds.connectionsMediumPct) return "medium";
  return "healthy";
}

export function errorRateStatus(pct: number | null): Health {
  if (pct == null) return "no-data";
  if (pct > thresholds.s3.errorRateOverloadedPct) return "overloaded";
  if (pct >= thresholds.s3.errorRateMediumPct) return "medium";
  return "healthy";
}

export function statusCheckStatus(failureAverage: number | null): Health {
  if (failureAverage == null) return "no-data";
  return failureAverage > 0 ? "overloaded" : "healthy";
}

export function isUnderutilized(cpu: number | null, running: boolean, limit = thresholds.ec2.cpuUnderutilized): boolean {
  return running && cpu != null && cpu < limit;
}

export function worstHealth(statuses: Health[]): Health {
  const known = statuses.filter((status) => status !== "no-data");
  if (!known.length) return "no-data";
  return known.reduce((left, right) => (RANK[left] >= RANK[right] ? left : right));
}

export function overallHealth(metrics: MetricValue[]): { health: Health; reason: string } {
  const driving = metrics.filter((metric) => metric.drivesHealth);
  const health = worstHealth(driving.map((metric) => metric.status));
  if (health === "no-data") return { health, reason: "No health metrics in this window" };
  const triggers = driving.filter((metric) => metric.status === health).map((metric) => metric.label);
  return { health, reason: triggers.join(", ") };
}

/** SampleCount is one CloudWatch number. This only labels coverage; it does not average metrics. */
export function coverageLabel(sampleCount: number | null, windowDays: number, intervalSeconds = 300): string | null {
  if (sampleCount == null || sampleCount <= 0 || windowDays <= 0) return null;
  const expected = (windowDays * 86_400) / intervalSeconds;
  if (sampleCount >= expected * 0.9) return null;
  const days = Math.min(windowDays, Math.max(1, Math.round((sampleCount * intervalSeconds) / 86_400)));
  if (days >= windowDays) return null;
  return `${days} of ${windowDays} days`;
}

export function percentDisplay(value: number | null, missing: "Not available" | "Not enabled" = "Not available"): string {
  if (value == null) return missing;
  const shown = Math.abs(value) < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown}%`;
}

export function metric(input: {
  id: string;
  label: string;
  value: number | null;
  display: string;
  status: Health;
  drivesHealth: boolean;
}): MetricValue {
  return input;
}
