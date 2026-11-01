import { ALARM_HISTORY_DAYS, RDS_BASELINE, alarmQuality } from "./alarms-config";
import { catalogEntry, regionDisplayName, resourceDimension, serviceForNamespace, type ServiceTab } from "./alarms-catalog";
import {
  alarmConsoleLink,
  closenessOmittedReason,
  closenessText,
  currentReading,
  formatDuration,
  formatUtc,
  headline,
  missingDataSentence,
  noiseReasons,
  resourceConsoleLink,
  ruleSentence,
  valueLine,
  type AlarmState,
  type SentenceInput,
} from "./alarms-english";
import type { AlarmView, AlarmsPayload, CoverageRow, Cue, HistoryEpisode, RawAlarm, RawHistoryEvent, ResourceHint } from "./alarms-types";
import type { Health } from "./monitoring-status";

export function episodes(events: RawHistoryEvent[], shortSeconds: number): { history: HistoryEpisode[]; flapCount: number; shortEpisodes: number } {
  const ordered = events.slice().sort((a, b) => a.at.localeCompare(b.at));
  const history: HistoryEpisode[] = [];
  let open: string | null = null;
  let flapCount = 0;
  for (const event of ordered) {
    if (event.newState === "ALARM" && open == null) {
      open = event.at;
      flapCount += 1;
    } else if (event.newState !== "ALARM" && open != null) {
      history.push(closedEpisode(open, event.at));
      open = null;
    }
  }
  if (open) {
    history.push({
      startedAt: open,
      endedAt: null,
      durationLabel: "still open",
      sentence: `${formatUtc(open)}: went into alarm; still in alarm.`,
    });
  }
  const shortEpisodes = history.filter((item) => item.endedAt != null && durationSeconds(item.startedAt, item.endedAt) < shortSeconds).length;
  return { history, flapCount, shortEpisodes };
}

function closedEpisode(start: string, end: string): HistoryEpisode {
  const seconds = durationSeconds(start, end);
  const label = seconds < 3600 ? `${Math.max(1, Math.round(seconds / 60))} min` : formatDuration(seconds);
  return {
    startedAt: start,
    endedAt: end,
    durationLabel: label,
    sentence: `${formatUtc(start)}: went into alarm; ${formatUtc(end)}: recovered (${label}).`,
  };
}

function durationSeconds(start: string, end: string): number {
  return Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 1000);
}

function sentenceFor(alarm: RawAlarm, resourceLabel: string): SentenceInput {
  const entry = catalogEntry(alarm.namespace, alarm.metricName);
  return {
    resourceLabel,
    regionName: regionDisplayName(alarm.region),
    friendly: entry?.friendly ?? alarm.metricName ?? "this alarm",
    ruleName: entry?.ruleName ?? alarm.metricName ?? "This alarm",
    direction: entry?.direction ?? null,
    unit: entry?.unit ?? null,
    comparison: alarm.comparison ?? null,
    threshold: alarm.threshold ?? null,
    period: alarm.period ?? null,
    evaluationPeriods: alarm.evaluationPeriods ?? null,
    datapointsToAlarm: alarm.datapointsToAlarm ?? null,
    state: alarm.state,
    stateUpdatedAt: alarm.stateUpdatedAt,
    current: currentReading(alarm.recentValues),
    kind: entry || alarm.kind !== "metric" ? alarm.kind : "unknown",
    expression: alarm.expression,
    alarmRule: alarm.alarmRule,
    treatMissingData: alarm.treatMissingData,
    nearPct: alarmQuality.nearThresholdPct,
  };
}

function cueFor(state: AlarmState, closeness: string | null): Cue {
  if (state === "ALARM") return "alarm";
  if (state === "INSUFFICIENT_DATA") return "insufficient";
  if (closeness) return "warning";
  return "ok";
}

export function buildAlarmViews(
  alarms: RawAlarm[],
  history: RawHistoryEvent[],
  hints: ResourceHint[],
  options: { live: boolean; asOf?: string; warnings?: string[]; metricCalls?: number; inventoryServices?: Array<"ec2" | "rds" | "s3"> } = { live: false }
): AlarmsPayload {
  const known = new Set(hints.map((hint) => `${hint.service}:${hint.id}`));
  const inventory = new Set(options.inventoryServices ?? ["ec2", "rds", "s3"]);
  const views = alarms.map((alarm) => toView(alarm, history, hints, known, inventory));
  const summary = emptySummary();
  for (const view of views) {
    summary[view.service][view.cue === "warning" ? "warning" : view.cue === "alarm" ? "alarm" : view.cue === "insufficient" ? "insufficient" : "ok"] += 1;
  }
  const regions = Array.from(new Set(alarms.map((alarm) => alarm.region)));
  return {
    live: options.live,
    asOf: options.asOf ?? new Date().toISOString(),
    historyRetentionDays: ALARM_HISTORY_DAYS,
    warnings: options.warnings ?? [],
    estimate: {
      regions: regions.length,
      alarms: alarms.length,
      describeAlarms: Math.max(regions.length, 1),
      historyCalls: alarms.length,
      metricCalls: options.metricCalls ?? 0,
      note: "One DescribeAlarms page per region (more if a region has over 100 alarms) and one DescribeAlarmHistory per alarm. GetMetricData runs only when the alarm state has no latest value. Results are cached. This module never calls a write API.",
    },
    alarms: views.sort((a, b) => a.resourceName?.localeCompare(b.resourceName ?? "") || a.name.localeCompare(b.name)),
    coverage: { metrics: RDS_BASELINE.map((item) => ({ id: item.metric, label: item.label })), rows: coverageRows(views, hints) },
    summary,
  };
}

function toView(
  alarm: RawAlarm,
  history: RawHistoryEvent[],
  hints: ResourceHint[],
  known: Set<string>,
  inventory: Set<string>
): AlarmView {
  const dimension = resourceDimension(alarm.namespace);
  const match = dimension ? alarm.dimensions.find((item) => item.name === dimension) : undefined;
  const service = match ? serviceForNamespace(alarm.namespace) : "unmapped";
  const hint = match ? hints.find((item) => item.id === match.value && item.region === alarm.region) ?? hints.find((item) => item.id === match.value) : undefined;
  const resourceId = match?.value ?? null;
  const resourceLabel = hint?.name || resourceId || alarm.name;
  const input = sentenceFor(alarm, resourceLabel);
  const reasons = noiseReasons(input);
  const episode = episodes(
    history.filter((event) => event.alarmName === alarm.name && event.region === alarm.region),
    alarmQuality.shortEpisodeSeconds
  );
  const flapping = episode.flapCount > alarmQuality.flapCount || episode.shortEpisodes > 0;
  const closeness = closenessText(input);
  const links = resourceId && service !== "unmapped" ? resourceConsoleLink(service, alarm.region, resourceId, hint?.performanceInsights === true) : { resource: "", performanceInsights: null };
  const entry = catalogEntry(alarm.namespace, alarm.metricName);
  const orphaned = Boolean(resourceId && service !== "unmapped" && inventory.has(service) && !known.has(`${service}:${resourceId}`));
  return {
    id: `${alarm.region}:${alarm.name}`,
    name: alarm.name,
    region: alarm.region,
    regionName: regionDisplayName(alarm.region),
    service,
    resourceId,
    resourceName: resourceLabel,
    orphaned,
    metricName: alarm.metricName ?? null,
    friendlyMetric: entry?.friendly ?? alarm.metricName ?? "Advanced alarm",
    state: alarm.state,
    cue: cueFor(alarm.state, closeness),
    stateUpdatedAt: alarm.stateUpdatedAt,
    headline: headline(input),
    rule: ruleSentence(input),
    valueLine: valueLine(input),
    closeness,
    closenessNote: closenessOmittedReason(input),
    missingData: missingDataSentence(alarm.treatMissingData),
    noiseProne: reasons.length > 0,
    noiseReasons: reasons,
    flapping,
    flapCount: episode.flapCount,
    shortEpisodes: episode.shortEpisodes,
    noAction: alarm.actions.length === 0,
    actionsDisabled: alarm.actionsEnabled === false,
    advanced: alarm.kind !== "metric" || !entry,
    expression: alarm.expression ?? alarm.alarmRule ?? null,
    actions: alarm.actions,
    links: {
      alarm: alarmConsoleLink(alarm.region, alarm.name),
      resource: links.resource || null,
      performanceInsights: links.performanceInsights,
      monitoring: resourceId && service !== "unmapped" ? `/monitoring?service=${service}&resource=${encodeURIComponent(resourceId)}` : null,
    },
    gauge:
      alarm.kind === "metric" && entry && input.current != null && input.threshold != null
        ? { value: input.current, limit: input.threshold, direction: entry.direction }
        : null,
    history: episode.history,
    stateReason: alarm.stateReason,
  };
}

function coverageRows(views: AlarmView[], hints: ResourceHint[]): CoverageRow[] {
  return hints
    .filter((hint) => hint.service === "rds")
    .map((hint) => {
      const cells: CoverageRow["cells"] = {};
      for (const metric of RDS_BASELINE) {
        const matching = views.filter((view) => view.resourceId === hint.id && view.metricName === metric.metric && view.service === "rds");
        if (matching.length) {
          const noisy = matching.some((view) => view.noiseProne || view.flapping);
          cells[metric.metric] = { status: noisy ? "noisy" : "present", alarmName: matching[0].name };
        } else if (metric.replicasOnly && hint.role === "primary") {
          cells[metric.metric] = { status: "na", alarmName: null };
        } else if (metric.replicasOnly && hint.role === "unknown") {
          cells[metric.metric] = { status: "unknown", alarmName: null };
        } else {
          cells[metric.metric] = { status: "missing", alarmName: null };
        }
      }
      return { resourceId: hint.id, name: hint.name, region: hint.region, role: hint.role, cells };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function emptySummary(): AlarmsPayload["summary"] {
  const blank = () => ({ alarm: 0, ok: 0, insufficient: 0, warning: 0 });
  return { ec2: blank(), rds: blank(), s3: blank(), unmapped: blank() };
}

export function activeAlarmCount(alarms: AlarmView[], resourceId: string): number {
  return alarms.filter((alarm) => alarm.resourceId === resourceId && alarm.state === "ALARM").length;
}

/** An active alarm raises a non-overloaded monitoring status so Healthy is not shown beside it. */
export function escalateHealth(health: Health, active: number, metricReason: string): { health: Health; reason: string } {
  if (active > 0 && health !== "overloaded") {
    return {
      health: "overloaded",
      reason: `${metricReason}. A CloudWatch alarm is in the ALARM state, so this is not shown as healthy.`,
    };
  }
  return { health, reason: metricReason };
}

export function summaryKey(service: ServiceTab): ServiceTab {
  return service;
}
