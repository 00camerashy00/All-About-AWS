import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENTION_DEDUP_MS,
  DEFAULT_ALERT_EMAIL_TO,
  alertEmailFrom,
  alertEmailTo,
  attentionFindings,
  autoScalingEnabled,
  dueFindings,
  findingKey,
  renderAttentionEmail,
  stampSent,
  type AttentionDatabase,
  type AttentionInstance,
} from "../lib/attention";

function server(partial: Partial<AttentionInstance> = {}): AttentionInstance {
  return {
    id: "i-web",
    name: "web-prod-1",
    state: "running",
    region: "ap-south-1",
    cpuAvg7d: 40,
    diskUsedPct: null,
    autoScalingGroup: null,
    ...partial,
  };
}

function database(partial: Partial<AttentionDatabase> = {}): AttentionDatabase {
  return {
    id: "orders-db",
    region: "ap-south-1",
    status: "available",
    cpuAvg7d: 40,
    storageUsedPct: 40,
    connectionPct: 20,
    ...partial,
  };
}

function reasons(partial: Parameters<typeof attentionFindings>[0]) {
  return attentionFindings(partial).map((finding) => `${finding.type}:${finding.id}:${finding.reason}:${finding.value}`);
}

test("disk at 80% is a finding and 79% is not", () => {
  assert.deepEqual(reasons({ instances: [server({ diskUsedPct: 80 })] }), ["Server:i-web:disk-space:Disk 80%"]);
  assert.deepEqual(reasons({ instances: [server({ diskUsedPct: 79 })] }), []);
  assert.deepEqual(
    reasons({ databases: [database({ storageUsedPct: 80, cpuAvg7d: 40, connectionPct: 10 })] }),
    ["Database:orders-db:disk-space:Disk 80%"]
  );
});

test("server sizing follows the 7-day CPU bands and ignores a stopped server", () => {
  assert.deepEqual(reasons({ instances: [server({ cpuAvg7d: 80 })] }), ["Server:i-web:under-provisioned:CPU 80%"]);
  assert.deepEqual(reasons({ instances: [server({ cpuAvg7d: 10 })] }), ["Server:i-web:over-provisioned:CPU 10%"]);
  assert.deepEqual(reasons({ instances: [server({ cpuAvg7d: 11 })] }), []);
  assert.deepEqual(reasons({ instances: [server({ state: "stopped", cpuAvg7d: 1, diskUsedPct: 10 })] }), []);
});

test("a full disk and a hot CPU are separate findings on the same server", () => {
  const found = attentionFindings({ instances: [server({ cpuAvg7d: 91, diskUsedPct: 88 })] });
  assert.deepEqual(
    found.map((finding) => finding.reason),
    ["disk-space", "under-provisioned"]
  );
  assert.equal(found[0]?.value, "Disk 88%");
  assert.equal(found[1]?.value, "CPU 91%");
});

test("database under-provisioned uses CPU, storage, or connections, and over-provisioned stays strict", () => {
  assert.equal(
    reasons({ databases: [database({ cpuAvg7d: 80, storageUsedPct: 40, connectionPct: 10 })] })[0],
    "Database:orders-db:under-provisioned:CPU 80%"
  );
  assert.equal(
    reasons({ databases: [database({ cpuAvg7d: 20, storageUsedPct: 85, connectionPct: 10 })] }).join(" | "),
    "Database:orders-db:disk-space:Disk 85% | Database:orders-db:under-provisioned:Disk 85%"
  );
  assert.equal(
    reasons({ databases: [database({ cpuAvg7d: 20, storageUsedPct: 40, connectionPct: 80 })] })[0],
    "Database:orders-db:under-provisioned:Connections 80%"
  );
  assert.equal(
    reasons({ databases: [database({ cpuAvg7d: 10, storageUsedPct: 69, connectionPct: 10 })] })[0],
    "Database:orders-db:over-provisioned:CPU 10%, Disk 69%"
  );
  assert.deepEqual(
    reasons({ databases: [database({ status: "stopped", cpuAvg7d: 1, storageUsedPct: 10 })] }),
    []
  );
  assert.deepEqual(reasons({ databases: [database({ cpuAvg7d: 10, storageUsedPct: 70 })] }), []);
});

test("an enabled auto-scaling group and a member instance are findings", () => {
  assert.equal(autoScalingEnabled([]), true);
  assert.equal(autoScalingEnabled(["Launch"]), true);
  assert.equal(autoScalingEnabled(["Launch", "Terminate"]), false);

  const found = attentionFindings({
    instances: [server({ autoScalingGroup: "web-asg", cpuAvg7d: 40 })],
    autoScalingGroups: [{ name: "web-asg", region: "ap-south-1", enabled: true }],
  });
  assert.deepEqual(
    found.map((finding) => `${finding.type}:${finding.value}`),
    ["Auto Scaling group:auto-scaling enabled", "Server:auto-scaling enabled"]
  );
  assert.equal(found.find((finding) => finding.type === "Server")?.note, "web-asg");

  assert.deepEqual(
    attentionFindings({
      instances: [server({ autoScalingGroup: null })],
      autoScalingGroups: [{ name: "web-asg", region: "ap-south-1", enabled: false }],
    }),
    []
  );
  assert.equal(
    attentionFindings({
      instances: [server({ autoScalingGroup: "web-asg" })],
      autoScalingGroups: [{ name: "web-asg", region: "ap-south-1", enabled: false }],
    }).length,
    0
  );
  assert.equal(
    attentionFindings({ instances: [server({ autoScalingGroup: "web-asg" })] }).length,
    1
  );
});

test("the digest names each finding and escapes HTML", () => {
  const mail = renderAttentionEmail(
    attentionFindings({
      instances: [server({ name: "web <prod>", cpuAvg7d: 90, diskUsedPct: 81 })],
    }),
    new Date("2026-11-17T04:42:00.000Z")
  );
  assert.equal(mail.subject, "AAA: 2 resources need attention");
  assert.match(mail.html, /All About AWS/);
  assert.match(mail.html, /#f6f7f9/);
  assert.match(mail.html, /web &lt;prod&gt;/);
  assert.equal(mail.html.includes("web <prod>"), false);
  assert.match(mail.html, /Disk 81%/);
  assert.match(mail.html, /CPU 90%/);
  assert.match(mail.html, /ap-south-1/);
  assert.match(mail.text, /web <prod>/);
  assert.match(mail.text, /Under-provisioned/);
  assert.match(mail.text, /Disk at or above 80%/);
  assert.match(mail.text, /Scanned 2026-11-17 04:42 UTC/);
  assert.equal(mail.html.toLowerCase().includes("progress"), false);
  assert.equal(/#[0-9a-f]*[7]c3aed/i.test(mail.html), false);
});

test("the same resource and reason is skipped for 24 hours", () => {
  const findings = attentionFindings({ instances: [server({ cpuAvg7d: 90, diskUsedPct: 90 })] });
  const now = Date.parse("2026-11-17T04:42:00.000Z");
  const sent = stampSent({}, findings, now);
  assert.equal(dueFindings(findings, sent, now + ATTENTION_DEDUP_MS - 1).length, 0);
  const again = dueFindings(findings, sent, now + ATTENTION_DEDUP_MS);
  assert.equal(again.length, findings.length);
  const diskOnly = findings.filter((finding) => finding.reason === "disk-space");
  const partial = stampSent({}, diskOnly, now);
  const due = dueFindings(findings, partial, now + 1000);
  assert.deepEqual(due.map((finding) => finding.reason), ["under-provisioned"]);
  assert.equal(findingKey(findings[0]!) !== findingKey(findings[1]!), true);
});

test("alert recipient defaults to its@krishagni.com and From stays empty until set", () => {
  assert.deepEqual(alertEmailTo(undefined), [DEFAULT_ALERT_EMAIL_TO]);
  assert.deepEqual(alertEmailTo(" ops@example.com "), ["ops@example.com"]);
  assert.equal(alertEmailFrom(undefined), "");
  assert.equal(alertEmailFrom(" aaa@krishagni.com "), "aaa@krishagni.com");
});
