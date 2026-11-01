import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionStatus,
  coverageLabel,
  cpuStatus,
  errorRateStatus,
  freeStorageStatus,
  isUnderutilized,
  overallHealth,
  latestDailyValue,
  soleCloudWatchValue,
  statusCheckStatus,
  worstHealth,
  type MetricValue,
} from "../lib/monitoring-status";

function m(partial: Partial<MetricValue> & Pick<MetricValue, "label" | "status">): MetricValue {
  return {
    id: partial.id ?? partial.label,
    value: partial.value ?? null,
    display: partial.display ?? "",
    drivesHealth: partial.drivesHealth ?? true,
    ...partial,
  };
}

test("sole CloudWatch value never averages multiple points", () => {
  assert.deepEqual(soleCloudWatchValue(undefined), { value: null, rejected: false });
  assert.deepEqual(soleCloudWatchValue([]), { value: null, rejected: false });
  assert.deepEqual(soleCloudWatchValue([42]), { value: 42, rejected: false });
  assert.deepEqual(soleCloudWatchValue([10, 20]), { value: null, rejected: true });
});

test("latest daily S3 value is the newest point, never a mean", () => {
  assert.deepEqual(latestDailyValue([10, 30], [new Date("2026-10-01"), new Date("2026-10-02")]), {
    value: 30,
    rejected: false,
  });
  assert.deepEqual(latestDailyValue([10, 30]), { value: null, rejected: true });
  assert.deepEqual(latestDailyValue([48]), { value: 48, rejected: false });
});

test("CPU threshold matrix", () => {
  assert.equal(cpuStatus(null), "no-data");
  assert.equal(cpuStatus(0), "healthy");
  assert.equal(cpuStatus(39.9), "healthy");
  assert.equal(cpuStatus(40), "medium");
  assert.equal(cpuStatus(75), "medium");
  assert.equal(cpuStatus(75.1), "overloaded");
  assert.equal(cpuStatus(100), "overloaded");
});

test("missing CPU is not stored as zero and does not look underutilized", () => {
  assert.equal(cpuStatus(null), "no-data");
  assert.equal(isUnderutilized(null, true), false);
  assert.equal(isUnderutilized(0, true), true);
  assert.equal(isUnderutilized(4.9, true), true);
  assert.equal(isUnderutilized(4.9, false), false);
  assert.equal(isUnderutilized(5, true), false);
});

test("RDS free storage and connections", () => {
  assert.equal(freeStorageStatus(null), "no-data");
  assert.equal(freeStorageStatus(14.9), "overloaded");
  assert.equal(freeStorageStatus(15), "medium");
  assert.equal(freeStorageStatus(29.9), "medium");
  assert.equal(freeStorageStatus(30), "healthy");
  assert.equal(connectionStatus(null), "no-data");
  assert.equal(connectionStatus(50), "healthy");
  assert.equal(connectionStatus(50.1), "medium");
  assert.equal(connectionStatus(80), "medium");
  assert.equal(connectionStatus(80.1), "overloaded");
});

test("S3 error rate and status-check failures", () => {
  assert.equal(errorRateStatus(null), "no-data");
  assert.equal(errorRateStatus(0.2), "healthy");
  assert.equal(errorRateStatus(1), "medium");
  assert.equal(errorRateStatus(5.1), "overloaded");
  assert.equal(statusCheckStatus(null), "no-data");
  assert.equal(statusCheckStatus(0), "healthy");
  assert.equal(statusCheckStatus(0.01), "overloaded");
});

test("overall status is the worst known metric and ignores missing ones", () => {
  assert.equal(worstHealth(["no-data", "no-data"]), "no-data");
  assert.equal(worstHealth(["healthy", "no-data"]), "healthy");
  assert.equal(worstHealth(["healthy", "medium", "no-data"]), "medium");
  const result = overallHealth([
    m({ label: "CPU", status: "healthy" }),
    m({ label: "Memory", status: "no-data" }),
    m({ label: "Free storage", status: "overloaded" }),
    m({ label: "Network in", status: "overloaded", drivesHealth: false }),
  ]);
  assert.equal(result.health, "overloaded");
  assert.equal(result.reason, "Free storage");
});

test("partial window coverage is labeled from SampleCount, not by averaging", () => {
  assert.equal(coverageLabel(7 * 288, 7, 300), null);
  assert.equal(coverageLabel(3 * 288, 7, 300), "3 of 7 days");
  assert.equal(coverageLabel(null, 7, 300), null);
  assert.equal(coverageLabel(0, 7, 300), null);
});
