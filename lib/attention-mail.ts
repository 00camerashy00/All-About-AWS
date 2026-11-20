// Sends one digest after a live scan. Mail failure must not fail the scan.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { accountClientConfig } from "@/lib/aws";
import { getAccount } from "@/lib/account-store";
import {
  ATTENTION_DEDUP_MS,
  alertEmailFrom,
  alertEmailRegion,
  alertEmailTo,
  attentionFindings,
  dueFindings,
  renderAttentionEmail,
  stampSent,
  type AttentionAsg,
  type AttentionDatabase,
  type AttentionFinding,
  type AttentionInstance,
} from "@/lib/attention";

export interface AttentionMailResult {
  sent: boolean;
  warning?: string;
}

export interface AttentionScan {
  instances?: readonly AttentionInstance[];
  databases?: readonly AttentionDatabase[];
  autoScalingGroups?: readonly AttentionAsg[];
}

const globalStore = globalThis as typeof globalThis & {
  __awsDashAttentionSent?: Record<string, number>;
  __awsDashAttentionFile?: string;
};

export async function notifyAttention(scan: AttentionScan, now = Date.now()): Promise<AttentionMailResult> {
  const findings = attentionFindings(scan);
  if (findings.length === 0) return { sent: false };

  const book = loadBook(now);
  const due = dueFindings(findings, book, now);
  if (due.length === 0) return { sent: false };

  const from = alertEmailFrom(process.env.ALERT_EMAIL_FROM);
  const to = alertEmailTo(process.env.ALERT_EMAIL_TO);
  if (!from.includes("@") || to.length === 0 || to.some((address) => !address.includes("@"))) {
    console.warn("attention email not sent: sender not configured");
    return {
      sent: false,
      warning: "ALERT_EMAIL_FROM is not set to a sender address, so the attention email was not sent. The scan completed.",
    };
  }

  const message = renderAttentionEmail(due, new Date(now));
  try {
    const account = getAccount();
    if (!account) {
      console.warn("attention email not sent: no account");
      return {
        sent: false,
        warning: "AWS credentials were not available, so the attention email was not sent. The scan completed.",
      };
    }
    const region = alertEmailRegion(process.env.ALERT_EMAIL_REGION) || account.region;
    const ses = new SESClient(accountClientConfig(region));
    await ses.send(
      new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: to },
        Message: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: message.text, Charset: "UTF-8" },
            Html: { Data: message.html, Charset: "UTF-8" },
          },
        },
      }),
      { abortSignal: AbortSignal.timeout(15000) }
    );
  } catch (error) {
    const name = (error as { name?: string })?.name ?? "error";
    console.warn("attention email not sent:", name);
    return {
      sent: false,
      warning: `Amazon SES could not send the attention email (${name}). The scan completed.`,
    };
  }

  saveBook(stampSent(book, due, now));
  console.info("attention email sent");
  return { sent: true };
}

function loadBook(now: number): Record<string, number> {
  if (!globalStore.__awsDashAttentionSent) globalStore.__awsDashAttentionSent = readBook(now);
  const fresh: Record<string, number> = {};
  const book = globalStore.__awsDashAttentionSent;
  for (const key of Object.keys(book)) {
    const at = book[key];
    if (typeof at === "number" && now - at < ATTENTION_DEDUP_MS) fresh[key] = at;
  }
  globalStore.__awsDashAttentionSent = fresh;
  return fresh;
}

function readBook(now: number): Record<string, number> {
  try {
    const raw = fs.readFileSync(dedupFile(), "utf8");
    const json = JSON.parse(raw) as { sent?: Record<string, number> };
    const sent = json.sent;
    if (!sent || typeof sent !== "object") return {};
    const fresh: Record<string, number> = {};
    for (const key of Object.keys(sent)) {
      const at = sent[key];
      if (typeof at === "number" && now - at < ATTENTION_DEDUP_MS) fresh[key] = at;
    }
    return fresh;
  } catch {
    return {};
  }
}

function saveBook(book: Record<string, number>) {
  globalStore.__awsDashAttentionSent = book;
  try {
    const file = dedupFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sent: book }));
  } catch (error) {
    const name = (error as { name?: string })?.name ?? "error";
    console.warn("attention email dedup was kept in memory only:", name);
  }
}

function dedupFile(): string {
  if (globalStore.__awsDashAttentionFile) return globalStore.__awsDashAttentionFile;
  const local = path.join(process.cwd(), ".data");
  try {
    fs.mkdirSync(local, { recursive: true });
    fs.accessSync(local, fs.constants.W_OK);
    globalStore.__awsDashAttentionFile = path.join(local, "attention-sent.json");
  } catch {
    globalStore.__awsDashAttentionFile = path.join(os.tmpdir(), "aaa-attention-sent.json");
  }
  return globalStore.__awsDashAttentionFile;
}

export function resetAttentionMailState() {
  globalStore.__awsDashAttentionSent = {};
  globalStore.__awsDashAttentionFile = undefined;
}

export type { AttentionFinding };
