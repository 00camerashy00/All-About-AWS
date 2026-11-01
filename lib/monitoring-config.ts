// Thresholds, windows, cache TTL, and the optional region allow-list.
// Change these values to retune health without touching the collectors.

export type WindowId = "24h" | "7d" | "14d" | "30d";

export interface WindowDef {
  id: WindowId;
  seconds: number;
  days: number;
  label: string;
}

export const WINDOWS: Record<WindowId, WindowDef> = {
  "24h": { id: "24h", seconds: 86_400, days: 1, label: "24 hours" },
  "7d": { id: "7d", seconds: 604_800, days: 7, label: "7 days" },
  "14d": { id: "14d", seconds: 1_209_600, days: 14, label: "14 days" },
  "30d": { id: "30d", seconds: 2_592_000, days: 30, label: "30 days" },
};

export const DEFAULT_WINDOW: WindowId = "7d";

export function monitoringTtlMs(): number {
  const raw = Number(process.env.MONITORING_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 60_000) return raw;
  return 6 * 60 * 60 * 1000;
}

/** Empty means every enabled region. Comma-separated, e.g. ap-south-1,us-east-1 */
export function regionAllowList(): string[] | null {
  const raw = process.env.MONITORING_REGIONS?.trim();
  if (!raw) return null;
  const list = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return list.length ? list : null;
}

export const thresholds = {
  ec2: {
    cpuMedium: 40,
    cpuOverloaded: 75,
    cpuUnderutilized: 5,
  },
  rds: {
    cpuMedium: 40,
    cpuOverloaded: 75,
    cpuUnderutilized: 5,
    freeStorageMediumPct: 30,
    freeStorageOverloadedPct: 15,
    connectionsMediumPct: 50,
    connectionsOverloadedPct: 80,
  },
  s3: {
    errorRateMediumPct: 1,
    errorRateOverloadedPct: 5,
  },
};

/** Approximate MySQL/PostgreSQL max_connections for common classes. Unknown classes stay "max unknown". */
export const RDS_MAX_CONNECTIONS: Record<string, number> = {
  "db.t3.micro": 85,
  "db.t3.small": 150,
  "db.t3.medium": 340,
  "db.t4g.micro": 85,
  "db.t4g.small": 150,
  "db.t4g.medium": 340,
  "db.m5.large": 681,
  "db.m5.xlarge": 1362,
  "db.m6g.large": 681,
  "db.r5.large": 1362,
  "db.r6g.large": 1362,
};
