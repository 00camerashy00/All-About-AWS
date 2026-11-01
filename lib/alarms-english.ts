// Deterministic sentences from an alarm definition. No email parsing and no model call.

import type { Direction, UnitKind } from "./alarms-catalog";

export type AlarmState = "ALARM" | "OK" | "INSUFFICIENT_DATA";
export type AlarmKind = "metric" | "composite" | "math" | "anomaly" | "unknown";

export interface SentenceInput {
  resourceLabel: string;
  regionName: string;
  friendly: string;
  ruleName: string;
  direction: Direction | null;
  unit: UnitKind | null;
  comparison: string | null;
  threshold: number | null;
  period: number | null;
  evaluationPeriods: number | null;
  datapointsToAlarm: number | null;
  state: AlarmState;
  stateUpdatedAt: string;
  current: number | null;
  kind: AlarmKind;
  expression?: string | null;
  alarmRule?: string | null;
  treatMissingData?: string | null;
  nearPct?: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = MONTHS[date.getUTCMonth()];
  const day = date.getUTCDate();
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day}, ${hour}:${minute} UTC`;
}

export function formatLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function formatQuantity(value: number, unit: UnitKind): string {
  if (unit === "percent") {
    const shown = Math.abs(value) < 10 && !Number.isInteger(value) ? Math.round(value * 10) / 10 : Math.round(value);
    return `${shown}%`;
  }
  if (unit === "bytes") {
    const gb = value / 1024 ** 3;
    if (Math.abs(gb) >= 1) {
      const shown = Math.abs(gb) >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
      return `${shown} GB`;
    }
    return `${Math.round(value / 1024 ** 2)} MB`;
  }
  if (unit === "seconds") return `${Math.round(value)} sec`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return `${seconds} seconds`;
}

export function periodPhrase(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}-second`;
}

export function comparisonPhrase(comparison: string | null): string | null {
  switch (comparison) {
    case "GreaterThanOrEqualToThreshold":
      return "at or above";
    case "GreaterThanThreshold":
    case "GreaterThanUpperThreshold":
      return "above";
    case "LessThanThreshold":
    case "LessThanLowerThreshold":
      return "below";
    case "LessThanOrEqualToThreshold":
      return "at or below";
    default:
      return null;
  }
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function ruleSentence(input: SentenceInput): string {
  if (input.kind === "composite") {
    return `Advanced alarm. It follows this rule: ${input.alarmRule || "not provided"}. A metric sentence is not shown.`;
  }
  if (input.kind === "math") {
    return "Advanced alarm. It uses a metric math expression. A single-metric sentence is not shown.";
  }
  if (input.kind === "anomaly") {
    return "Advanced alarm. CloudWatch anomaly detection uses a learned band, not a fixed limit.";
  }
  const phrase = comparisonPhrase(input.comparison);
  if (
    input.kind !== "metric" ||
    !input.direction ||
    !input.unit ||
    input.threshold == null ||
    !phrase ||
    !input.period ||
    !input.evaluationPeriods ||
    !input.datapointsToAlarm
  ) {
    return "Advanced alarm. The definition is incomplete, so a plain-English rule is not guessed.";
  }
  const limit = formatQuantity(input.threshold, input.unit);
  const name = input.ruleName;
  const points = input.datapointsToAlarm;
  const periods = input.evaluationPeriods;
  if (points === periods && periods > 1) {
    return capitalize(`${name} stays ${phrase} ${limit} for ${formatDuration(input.period * periods)}.`);
  }
  if (periods === 1) {
    return capitalize(`${name} goes ${phrase} ${limit} in a single ${periodPhrase(input.period)} reading.`);
  }
  return `At least ${points} of the last ${periods} ${periodPhrase(input.period)} readings of ${name} are ${phrase} ${limit}.`;
}

function readingPhrase(count: number, direction: Direction): string {
  const word = count === 1 ? "reading" : "readings";
  return `${count} ${word} ${direction === "higher" ? "over" : "under"} the limit`;
}

export function headline(input: SentenceInput): string {
  if (input.kind !== "metric" || !input.direction || !input.unit) return ruleSentence(input);
  const where = input.resourceLabel;
  const place = input.regionName;
  if (input.state === "INSUFFICIENT_DATA") {
    return `${where} (${place}): not enough data to judge ${input.friendly}. Last changed ${formatUtc(input.stateUpdatedAt)}. No value is shown.`;
  }
  if (input.current == null || input.threshold == null || !comparisonPhrase(input.comparison)) {
    return `${where} (${place}): ${ruleSentence(input)} The latest value was not in the alarm state, so it is not shown.`;
  }
  const value = formatQuantity(input.current, input.unit);
  const limit = formatQuantity(input.threshold, input.unit);
  if (input.state === "ALARM") {
    const verb = input.direction === "lower" ? "fell to" : "reached";
    const relation = comparisonPhrase(input.comparison);
    const readings = input.datapointsToAlarm ?? 1;
    return `${where} (${place}): ${input.friendly} ${verb} ${value}, ${relation} the ${limit} limit. Triggered ${formatUtc(input.stateUpdatedAt)} (${readingPhrase(readings, input.direction)}).`;
  }
  return `${where} (${place}): ${input.friendly} is ${value}, inside the ${limit} limit. Last changed ${formatUtc(input.stateUpdatedAt)}.`;
}

export function valueLine(input: SentenceInput): string | null {
  if (input.kind !== "metric" || input.current == null || input.threshold == null || !input.unit) return null;
  const phrase = comparisonPhrase(input.comparison);
  if (!phrase) return null;
  const current = formatQuantity(input.current, input.unit);
  const limit = formatQuantity(input.threshold, input.unit);
  if (input.direction === "lower") return `${current} free; alarm ${phrase} ${limit}`;
  return `${current}; alarm ${phrase} ${limit}`;
}

/** Positive means past the limit. Warning band is an OK value within nearPct of the limit. */
export function closenessText(input: SentenceInput): string | null {
  if (input.kind !== "metric" || input.current == null || input.threshold == null || input.threshold === 0 || !input.direction) {
    return null;
  }
  if (input.state === "INSUFFICIENT_DATA") return null;
  const over =
    input.direction === "higher"
      ? ((input.current - input.threshold) / input.threshold) * 100
      : ((input.threshold - input.current) / input.threshold) * 100;
  if (input.state === "ALARM") return over > 0 ? `${Math.round(over)}% over limit` : null;
  const near = input.nearPct ?? 10;
  if (over < 0 && over >= -near) return `${Math.round(Math.abs(over))}% under the limit`;
  return null;
}

export function closenessOmittedReason(input: SentenceInput): string | null {
  if (closenessText(input)) return null;
  if (input.kind !== "metric") return "Closeness is omitted because this is not a single fixed threshold.";
  if (input.state === "OK" && input.current == null) {
    return "Closeness is omitted because the alarm state did not include a latest value.";
  }
  return null;
}

export function missingDataSentence(treat: string | null | undefined): string {
  switch (treat) {
    case "notBreaching":
      return "No data is treated as OK.";
    case "breaching":
      return "No data is treated as in alarm.";
    case "ignore":
      return "No data is ignored.";
    case "missing":
      return "No data is treated as missing.";
    default:
      return "Missing-data behavior was not set on this alarm.";
  }
}

export function noiseReasons(input: SentenceInput): string[] {
  if (input.kind !== "metric") return [];
  if (input.period === 60 && input.datapointsToAlarm === 1) {
    return ["Single 1-minute reading. This is the pattern that caused alert spam."];
  }
  const reasons: string[] = [];
  if (input.datapointsToAlarm === 1) reasons.push("It fires on a single reading.");
  if (input.period != null && input.period < 300) reasons.push("The period is shorter than 5 minutes.");
  return reasons;
}

export function alarmConsoleLink(region: string, name: string): string {
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}`;
}

export function resourceConsoleLink(service: string, region: string, id: string, performanceInsights: boolean): { resource: string; performanceInsights: string | null } {
  if (service === "rds") {
    return {
      resource: `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${encodeURIComponent(id)};tab=monitoring`,
      performanceInsights: performanceInsights
        ? `https://${region}.console.aws.amazon.com/rds/home?region=${region}#performance-insights:resourceName=${encodeURIComponent(id)}`
        : null,
    };
  }
  if (service === "ec2") {
    return {
      resource: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${encodeURIComponent(id)}`,
      performanceInsights: null,
    };
  }
  if (service === "s3") {
    return {
      resource: `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(id)}?region=${region}&tab=metrics`,
      performanceInsights: null,
    };
  }
  return { resource: "", performanceInsights: null };
}

/**
 * The newest datapoint only. recentDatapoints are a list of readings, and this
 * function does not average them.
 */
export function currentReading(values: number[] | undefined | null): number | null {
  if (!values || values.length === 0) return null;
  const last = values[values.length - 1];
  return Number.isFinite(last) ? last : null;
}
