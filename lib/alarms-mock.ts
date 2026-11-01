import { alarmFixtures, historyFixtures, resourceHints } from "./alarms-fixtures";
import { buildAlarmViews } from "./alarms-model";
import type { AlarmsPayload } from "./alarms-types";

export function demoAlarms(): AlarmsPayload {
  const payload = buildAlarmViews(alarmFixtures, historyFixtures, resourceHints, { live: false, metricCalls: 0 });
  payload.warnings = [
    "Demo alarms from the DBA standard and one sample read-IOPS alarm. Add keys to .env.local, then press Rescan on this page to read CloudWatch. Nothing here is created or changed in AWS.",
    "CloudWatch keeps alarm history for 14 days. This demo includes only the sample events.",
  ];
  return payload;
}
