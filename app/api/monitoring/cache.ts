import type { MonitoringPayload } from "@/lib/monitoring-types";

const globalStore = globalThis as typeof globalThis & {
  __awsDashMonitoring?: Record<string, { at: number; data: MonitoringPayload }> | null;
};

export function readMonitoringCache(key: string) {
  return globalStore.__awsDashMonitoring?.[key] ?? null;
}

export function writeMonitoringCache(key: string, data: MonitoringPayload) {
  const current = globalStore.__awsDashMonitoring ?? {};
  current[key] = { at: Date.now(), data };
  globalStore.__awsDashMonitoring = current;
}

export function resetMonitoringCache() {
  globalStore.__awsDashMonitoring = null;
}
