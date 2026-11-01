import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { demoAlarms } from "../lib/alarms-mock";
import { buildAlarmViews, escalateHealth, episodes } from "../lib/alarms-model";
import {
  closenessText,
  currentReading,
  headline,
  missingDataSentence,
  noiseReasons,
  ruleSentence,
  type SentenceInput,
} from "../lib/alarms-english";
import type { RawAlarm } from "../lib/alarms-types";

const data = demoAlarms();

function alarm(name: string) {
  const found = data.alarms.find((item) => item.name === name);
  assert.ok(found, name);
  return found;
}

function input(partial: Partial<SentenceInput> = {}): SentenceInput {
  return {
    resourceLabel: "db-1",
    regionName: "Mumbai",
    friendly: "CPU usage",
    ruleName: "CPU",
    direction: "higher",
    unit: "percent",
    comparison: "GreaterThanOrEqualToThreshold",
    threshold: 90,
    period: 300,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    state: "OK",
    stateUpdatedAt: "2026-09-21T12:10:41.000Z",
    current: 40,
    kind: "metric",
    nearPct: 10,
    ...partial,
  };
}

test("reference B is a plain-English alarm with a region-code link", () => {
  const row = alarm("iu-prod-clone-1-read-iops");
  assert.equal(
    row.headline,
    "iu-prod-clone-1 (Oregon): read IOPS reached 2,248, above the 2,000 limit. Triggered Sep 21, 12:10 UTC (1 reading over the limit)."
  );
  assert.equal(row.headline.includes("Sep 22"), false);
  assert.equal(row.closeness, "12% over limit");
  assert.equal(row.valueLine, "2,248; alarm above 2,000");
  assert.equal(row.noiseProne, true);
  assert.match(row.links.alarm, /^https:\/\/us-west-2\.console\.aws\.amazon\.com\/cloudwatch\/home\?region=us-west-2#/);
  assert.equal(row.links.alarm.includes("US West"), false);
  assert.equal(row.links.alarm.includes("Oregon"), false);
  assert.match(row.links.resource ?? "", /region=us-west-2#database:id=iu-prod-clone-1;tab=monitoring/);
  assert.match(row.links.performanceInsights ?? "", /region=us-west-2#performance-insights:/);
  assert.equal(row.history[0]?.sentence, "Sep 21, 12:10 UTC: went into alarm; still in alarm.");
});

test("reference A coverage matrix from definitions, not from an email", () => {
  const cell = (id: string, metric: string) => data.coverage.rows.find((row) => row.resourceId === id)?.cells[metric]?.status;
  assert.equal(cell("indiana-production", "CPUUtilization"), "present");
  assert.equal(cell("indiana-production", "FreeStorageSpace"), "present");
  assert.equal(cell("indiana-production", "FreeableMemory"), "present");
  assert.equal(cell("indiana-production", "DiskQueueDepth"), "present");
  assert.equal(cell("indiana-production", "ReplicaLag"), "na");
  assert.equal(cell("indiana-production-query", "DiskQueueDepth"), "missing");
  assert.equal(cell("indiana-production-query", "ReplicaLag"), "present");
  assert.equal(cell("indiana-uat", "ReplicaLag"), "na");
  assert.equal(cell("indiana-uat-read-replica", "ReplicaLag"), "present");
  assert.equal(cell("indiana-uat-read-replica", "DiskQueueDepth"), "present");
});

test("sentence catalog covers the team standard and the noisy pattern", () => {
  const pairs: { text: string; expected: string }[] = [
    { text: alarm("indiana-production-cpu").rule, expected: "CPU stays at or above 90% for 15 minutes." },
    { text: alarm("indiana-production-storage").rule, expected: "Free storage space stays below 15 GB for 15 minutes." },
    { text: alarm("indiana-production-memory").rule, expected: "Freeable memory stays below 512 MB for 15 minutes." },
    { text: alarm("indiana-production-queue").rule, expected: "Disk queue depth stays at or above 24 for 15 minutes." },
    { text: alarm("indiana-production-query-lag").rule, expected: "Replica lag stays at or above 60 sec for 15 minutes." },
    { text: alarm("indiana-uat-storage").rule, expected: "Free storage space stays below 10 GB for 15 minutes." },
    { text: alarm("indiana-uat-memory").rule, expected: "Freeable memory stays below 256 MB for 15 minutes." },
    { text: alarm("iu-prod-clone-1-read-iops").rule, expected: "Read IOPS goes above 2,000 in a single 1-minute reading." },
    { text: alarm("indiana-production-write-iops-legacy").rule, expected: "Write IOPS goes above 30 in a single 1-minute reading." },
    {
      text: ruleSentence(input({ datapointsToAlarm: 2, evaluationPeriods: 3 })),
      expected: "At least 2 of the last 3 5-minute readings of CPU are at or above 90%.",
    },
    { text: missingDataSentence("notBreaching"), expected: "No data is treated as OK." },
    { text: missingDataSentence("breaching"), expected: "No data is treated as in alarm." },
    { text: missingDataSentence("ignore"), expected: "No data is ignored." },
    { text: missingDataSentence("missing"), expected: "No data is treated as missing." },
    { text: alarm("indiana-production-composite").rule, expected: 'Advanced alarm. It follows this rule: ALARM("indiana-production-cpu") OR ALARM("indiana-production-storage"). A metric sentence is not shown.' },
    { text: alarm("indiana-production-math").headline, expected: "Advanced alarm. It uses a metric math expression. A single-metric sentence is not shown." },
    { text: alarm("indiana-production-anomaly").headline, expected: "Advanced alarm. CloudWatch anomaly detection uses a learned band, not a fixed limit." },
    {
      text: headline(input({ kind: "unknown", direction: null, unit: null })),
      expected: "Advanced alarm. The definition is incomplete, so a plain-English rule is not guessed.",
    },
  ];
  assert.equal(pairs.length >= 15, true);
  for (const pair of pairs) assert.equal(pair.text, pair.expected);
});

test("noise, flapping, warning, orphan, and missing values", () => {
  const legacy = alarm("indiana-production-write-iops-legacy");
  assert.equal(legacy.noiseProne, true);
  assert.equal(legacy.flapping, true);
  assert.equal(legacy.history[0]?.sentence, "Sep 21, 12:10 UTC: went into alarm; Sep 21, 12:14 UTC: recovered (4 min).");
  assert.equal(alarm("indiana-production-cpu").noiseProne, false);
  assert.equal(alarm("indiana-uat-cpu").cue, "warning");
  assert.equal(alarm("indiana-uat-cpu").closeness, "9% under the limit");
  const gone = alarm("deleted-db-cpu");
  assert.equal(gone.orphaned, true);
  assert.equal(gone.state, "INSUFFICIENT_DATA");
  assert.equal(gone.cue, "insufficient");
  assert.match(gone.headline, /No value is shown/);
  assert.equal(gone.headline.includes("0%"), false);
  assert.equal(alarm("i-staging1-cpu-silent").noAction, true);
  assert.equal(alarm("i-staging1-cpu-silent").actionsDisabled, true);
  assert.equal(alarm("custom-billing-unmapped").service, "unmapped");
  assert.equal(currentReading([10, 30]), 30);
  assert.equal(currentReading([]), null);
  assert.deepEqual(noiseReasons(input({ period: 60, datapointsToAlarm: 1, evaluationPeriods: 1 })), [
    "Single 1-minute reading. This is the pattern that caused alert spam.",
  ]);
});

test("multiple dimensions still map, and a value-less OK alarm does not invent closeness", () => {
  const raw: RawAlarm = {
    name: "multi",
    region: "us-west-2",
    kind: "metric",
    namespace: "AWS/RDS",
    metricName: "CPUUtilization",
    dimensions: [
      { name: "DBInstanceIdentifier", value: "orders-db" },
      { name: "EngineName", value: "postgres" },
    ],
    comparison: "GreaterThanOrEqualToThreshold",
    threshold: 90,
    period: 300,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    treatMissingData: "ignore",
    state: "OK",
    stateUpdatedAt: "2026-09-21T00:00:00.000Z",
    stateReason: "ok",
    recentValues: [],
    actions: ["arn:aws:sns:us-west-2:1:topic"],
    actionsEnabled: true,
  };
  const view = buildAlarmViews([raw], [], [], { live: false }).alarms[0];
  assert.equal(view.service, "rds");
  assert.equal(view.resourceId, "orders-db");
  assert.equal(view.closeness, null);
  assert.match(view.closenessNote ?? "", /did not include a latest value/);
  assert.equal(view.orphaned, true);
});

test("an active alarm escalates monitoring health off Healthy", () => {
  assert.equal(escalateHealth("healthy", 1, "CPU").health, "overloaded");
  assert.match(escalateHealth("healthy", 1, "CPU").reason, /ALARM state/);
  assert.equal(escalateHealth("overloaded", 1, "Free storage").health, "overloaded");
  assert.equal(escalateHealth("healthy", 0, "CPU").health, "healthy");
  assert.equal(escalateHealth("no-data", 1, "No health metrics").health, "overloaded");
});

test("episode duration is the gap between state changes", () => {
  const result = episodes(
    [
      { alarmName: "a", region: "us-west-2", at: "2026-09-21T12:10:00.000Z", oldState: "OK", newState: "ALARM" },
      { alarmName: "a", region: "us-west-2", at: "2026-09-21T12:14:00.000Z", oldState: "ALARM", newState: "OK" },
    ],
    300
  );
  assert.equal(result.history[0]?.durationLabel, "4 min");
  assert.equal(result.shortEpisodes, 1);
});

test("closeness is not shown for insufficient data", () => {
  assert.equal(closenessText(input({ state: "INSUFFICIENT_DATA", current: 99 })), null);
});

test("the alarms policy is read-only", () => {
  const policy = JSON.parse(fs.readFileSync(new URL("../iam/alarms-readonly.json", import.meta.url), "utf8"));
  const actions: string[] = policy.Statement.flatMap((statement: { Action: string[] }) => statement.Action);
  const banned = ["PutMetricAlarm", "DeleteAlarms", "SetAlarmState", "EnableAlarmActions", "DisableAlarmActions", "sns:Publish", "sns:Subscribe"];
  for (const action of banned) assert.equal(actions.some((item) => item.includes(action)), false);
  assert.ok(actions.includes("cloudwatch:DescribeAlarms"));
  assert.ok(actions.includes("cloudwatch:DescribeAlarmHistory"));
});
