import type { AlarmsPayload } from "@/lib/alarms-types";

const globalStore = globalThis as typeof globalThis & {
  __awsDashAlarms?: { at: number; data: AlarmsPayload } | null;
};

export function readAlarmsCache() {
  return globalStore.__awsDashAlarms ?? null;
}

export function writeAlarmsCache(data: AlarmsPayload) {
  globalStore.__awsDashAlarms = { at: Date.now(), data };
}

export function resetAlarmsCache() {
  globalStore.__awsDashAlarms = null;
}
