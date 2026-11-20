// Findings that AAA emails after a live scan. Pure: no AWS calls and no mail.

import { ec2Provision, rdsProvision } from "./provision";

export const DEFAULT_ALERT_EMAIL_TO = "its@krishagni.com";
export const DISK_ATTENTION_PCT = 80;
export const ATTENTION_DEDUP_MS = 24 * 60 * 60 * 1000;

export type AttentionReason = "disk-space" | "auto-scaling" | "under-provisioned" | "over-provisioned";
export type AttentionType = "Server" | "Database" | "Auto Scaling group";

export interface AttentionInstance {
  id: string;
  name: string;
  state: string;
  region: string;
  cpuAvg7d: number | null;
  diskUsedPct: number | null;
  autoScalingGroup: string | null;
}

export interface AttentionDatabase {
  id: string;
  region: string;
  status: string;
  cpuAvg7d: number | null;
  storageUsedPct: number | null;
  connectionPct: number | null;
}

export interface AttentionAsg {
  name: string;
  region: string;
  enabled: boolean;
}

export interface AttentionFinding {
  id: string;
  name: string;
  type: AttentionType;
  region: string;
  reason: AttentionReason;
  /** CPU %, disk %, connections %, or "auto-scaling enabled". */
  value: string;
  note?: string;
}

export interface AttentionMail {
  subject: string;
  html: string;
  text: string;
}

const CPU_UNDER = 80;
const CPU_OVER = 10;
const STORAGE_UNDER = 85;
const CONNECTIONS_UNDER = 80;

export function alertEmailTo(raw: string | undefined): string[] {
  const source = (raw ?? "").trim() || DEFAULT_ALERT_EMAIL_TO;
  const out: string[] = [];
  for (const part of source.split(",")) {
    const value = part.trim();
    if (value) out.push(value);
  }
  return out;
}

export function alertEmailFrom(raw: string | undefined): string {
  return (raw ?? "").trim();
}

export function alertEmailRegion(raw: string | undefined): string {
  return (raw ?? "").trim();
}

/** Capacity can still change unless both launch and terminate are suspended. */
export function autoScalingEnabled(suspendedProcesses: readonly string[]): boolean {
  let launch = false;
  let terminate = false;
  for (const name of suspendedProcesses) {
    if (name === "Launch") launch = true;
    if (name === "Terminate") terminate = true;
  }
  return !(launch && terminate);
}

export function reasonLabel(reason: AttentionReason): string {
  if (reason === "disk-space") return "Disk at or above 80%";
  if (reason === "auto-scaling") return "Auto-scaling enabled";
  if (reason === "under-provisioned") return "Under-provisioned";
  return "Over-provisioned";
}

export function findingKey(finding: AttentionFinding): string {
  return [finding.type, finding.region, finding.id, finding.reason].join("\n");
}

export function attentionFindings(input: {
  instances?: readonly AttentionInstance[];
  databases?: readonly AttentionDatabase[];
  autoScalingGroups?: readonly AttentionAsg[];
}): AttentionFinding[] {
  const groups = input.autoScalingGroups ?? [];
  const findings: AttentionFinding[] = [];

  for (const group of groups) {
    if (!group.enabled || !group.name) continue;
    findings.push({
      id: group.name,
      name: group.name,
      type: "Auto Scaling group",
      region: group.region,
      reason: "auto-scaling",
      value: "auto-scaling enabled",
    });
  }

  for (const instance of input.instances ?? []) {
    const name = instance.name || instance.id;
    if (instanceScalingOn(instance, groups)) {
      findings.push({
        id: instance.id,
        name,
        type: "Server",
        region: instance.region,
        reason: "auto-scaling",
        value: "auto-scaling enabled",
        note: instance.autoScalingGroup || undefined,
      });
    }
    if (instance.diskUsedPct != null && Number.isFinite(instance.diskUsedPct) && instance.diskUsedPct >= DISK_ATTENTION_PCT) {
      findings.push({
        id: instance.id,
        name,
        type: "Server",
        region: instance.region,
        reason: "disk-space",
        value: pct("Disk", instance.diskUsedPct),
      });
    }
    const sizing = ec2Provision(instance.state, instance.cpuAvg7d);
    if ((sizing === "Under-provisioned" || sizing === "Over-provisioned") && instance.cpuAvg7d != null) {
      findings.push({
        id: instance.id,
        name,
        type: "Server",
        region: instance.region,
        reason: sizing === "Under-provisioned" ? "under-provisioned" : "over-provisioned",
        value: pct("CPU", instance.cpuAvg7d),
      });
    }
  }

  for (const database of input.databases ?? []) {
    if (database.storageUsedPct != null && Number.isFinite(database.storageUsedPct) && database.storageUsedPct >= DISK_ATTENTION_PCT) {
      findings.push({
        id: database.id,
        name: database.id,
        type: "Database",
        region: database.region,
        reason: "disk-space",
        value: pct("Disk", database.storageUsedPct),
      });
    }
    const sizing = rdsProvision({
      available: database.status === "available",
      cpu: database.cpuAvg7d,
      storageUsedPct: database.storageUsedPct,
      connectionPct: database.connectionPct,
    });
    if (sizing === "Under-provisioned" || sizing === "Over-provisioned") {
      findings.push({
        id: database.id,
        name: database.id,
        type: "Database",
        region: database.region,
        reason: sizing === "Under-provisioned" ? "under-provisioned" : "over-provisioned",
        value: databaseValue(database, sizing),
      });
    }
  }

  findings.sort((a, b) => byLabel(a.name, b.name) || byLabel(a.type, b.type) || byLabel(a.reason, b.reason) || byLabel(a.region, b.region));
  return findings;
}

export function dueFindings(
  findings: readonly AttentionFinding[],
  sent: Readonly<Record<string, number>>,
  now: number
): AttentionFinding[] {
  return findings.filter((finding) => {
    const at = sent[findingKey(finding)];
    return at == null || now - at >= ATTENTION_DEDUP_MS;
  });
}

export function stampSent(
  sent: Readonly<Record<string, number>>,
  findings: readonly AttentionFinding[],
  now: number
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const key of Object.keys(sent)) {
    const at = sent[key];
    if (typeof at === "number" && now - at < ATTENTION_DEDUP_MS) next[key] = at;
  }
  for (const finding of findings) next[findingKey(finding)] = now;
  return next;
}

export function renderAttentionEmail(findings: readonly AttentionFinding[], scannedAt: Date): AttentionMail {
  const count = findings.length;
  const noun = count === 1 ? "resource needs" : "resources need";
  const subject = `AAA: ${count} ${count === 1 ? "resource needs" : "resources need"} attention`;
  const intro = `A live scan found ${count} ${noun} attention.`;
  const when = `Scanned ${scannedAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`;
  const footer =
    "The same resource and reason is not emailed again for 24 hours. AAA reads your account and does not change it.";
  const text = [
    "AAA",
    "All About AWS",
    "",
    "Resources that need attention",
    "",
    intro,
    "",
    ...findings.flatMap((finding) => ["", findingText(finding)]),
    "",
    when,
    footer,
  ].join("\n");

  const rows = findings.map((finding) => findingHtml(finding)).join("");
  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#f6f7f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;">
          <tr>
            <td style="padding:28px 28px 12px 28px;font-family:Inter,ui-sans-serif,system-ui,sans-serif;">
              <p style="margin:0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">AAA</p>
              <p style="margin:4px 0 0 0;font-size:12px;color:#6b7280;">All About AWS</p>
              <h1 style="margin:20px 0 0 0;font-size:22px;line-height:1.3;font-weight:600;color:#111827;">Resources that need attention</h1>
              <p style="margin:8px 0 0 0;font-size:14px;line-height:1.5;color:#4b5563;">${escapeHtml(intro)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:4px 28px 8px 28px;font-family:Inter,ui-sans-serif,system-ui,sans-serif;">${rows}</td>
          </tr>
          <tr>
            <td style="padding:8px 28px 28px 28px;font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:12px;line-height:1.5;color:#6b7280;">
              ${escapeHtml(when)} ${escapeHtml(footer)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject, html, text };
}

function instanceScalingOn(instance: AttentionInstance, groups: readonly AttentionAsg[]): boolean {
  if (!instance.autoScalingGroup) return false;
  const related: AttentionAsg[] = [];
  for (const group of groups) {
    if (group.name === instance.autoScalingGroup && group.region === instance.region) related.push(group);
  }
  if (related.length === 0) return true;
  return related.some((group) => group.enabled);
}

function databaseValue(database: AttentionDatabase, sizing: "Under-provisioned" | "Over-provisioned"): string {
  const parts: string[] = [];
  const cpu = finite(database.cpuAvg7d);
  const storage = finite(database.storageUsedPct);
  const connections = finite(database.connectionPct);
  if (sizing === "Under-provisioned") {
    if (cpu != null && cpu >= CPU_UNDER) parts.push(pct("CPU", cpu));
    if (storage != null && storage >= STORAGE_UNDER) parts.push(pct("Disk", storage));
    if (connections != null && connections >= CONNECTIONS_UNDER) parts.push(pct("Connections", connections));
  } else {
    if (cpu != null) parts.push(pct("CPU", cpu));
    if (storage != null) parts.push(pct("Disk", storage));
  }
  return parts.join(", ") || sizing;
}

function findingText(finding: AttentionFinding): string {
  return [finding.name, metaLine(finding), reasonLabel(finding.reason), finding.value].join("\n");
}

function findingHtml(finding: AttentionFinding): string {
  const tone = finding.reason === "over-provisioned" || finding.reason === "auto-scaling" ? "#92400e" : "#b91c1c";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f3f4f6;">
  <tr>
    <td style="padding:14px 0;font-family:Inter,ui-sans-serif,system-ui,sans-serif;">
      <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">${escapeHtml(finding.name)}</p>
      <p style="margin:2px 0 0 0;font-size:12px;color:#6b7280;">${escapeHtml(metaLine(finding))}</p>
      <p style="margin:8px 0 0 0;font-size:13px;color:${tone};">${escapeHtml(reasonLabel(finding.reason))}</p>
      <p style="margin:2px 0 0 0;font-size:13px;color:#374151;">${escapeHtml(finding.value)}</p>
    </td>
  </tr>
</table>`;
}

function metaLine(finding: AttentionFinding): string {
  const parts = [finding.type, finding.region];
  if (finding.id !== finding.name) parts.unshift(finding.id);
  if (finding.note) parts.push(finding.note);
  return parts.join(" · ");
}

function pct(label: "CPU" | "Disk" | "Connections", value: number): string {
  return `${label} ${Math.round(value)}%`;
}

function finite(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : value;
}

function byLabel(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
