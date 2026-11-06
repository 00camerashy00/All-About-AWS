"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Circle, CircleAlert, Database, Download, HardDrive, RefreshCw, Search, Server, Unlink } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard, type StatTone } from "@/components/stat-card";
import { useAccount } from "@/components/account-provider";
import type { ServiceTab } from "@/lib/alarms-catalog";
import { demoAlarms } from "@/lib/alarms-mock";
import { formatLocal, formatUtc } from "@/lib/alarms-english";
import type { AlarmView, AlarmsPayload, CoverageStatus, Cue } from "@/lib/alarms-types";

const PAGE_SIZE = 8;
const TABS: { id: ServiceTab; label: string }[] = [
  { id: "rds", label: "RDS" },
  { id: "ec2", label: "EC2" },
  { id: "s3", label: "S3" },
  { id: "unmapped", label: "Unmapped" },
];

const CUE: Record<Cue, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  alarm: { label: "In alarm", className: "bg-red-50 text-red-800 ring-red-200", Icon: CircleAlert },
  warning: { label: "Near limit", className: "bg-amber-50 text-amber-900 ring-amber-200", Icon: AlertTriangle },
  ok: { label: "OK", className: "bg-emerald-50 text-emerald-800 ring-emerald-200", Icon: CheckCircle2 },
  insufficient: { label: "Insufficient data", className: "bg-gray-100 text-gray-600 ring-gray-200", Icon: Circle },
};

const COVERAGE: Record<CoverageStatus, string> = {
  present: "Present",
  noisy: "Noisy",
  missing: "Missing",
  na: "n/a",
  unknown: "Unknown",
};

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export default function AlarmsPage() {
  const { account, revision } = useAccount();
  const [service, setService] = useState<ServiceTab>("rds");
  const [payload, setPayload] = useState<AlarmsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshNow = useRef(false);
  const [query, setQuery] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [cue, setCue] = useState<"all" | Cue>("all");
  const [metric, setMetric] = useState("all");
  const [noisyOnly, setNoisyOnly] = useState(false);
  const [noActionOnly, setNoActionOnly] = useState(false);
  const [sortKey, setSortKey] = useState("resource");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [utc, setUtc] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const next = params.get("service");
    const resource = params.get("resource");
    if (next === "ec2" || next === "rds" || next === "s3" || next === "unmapped") setService(next);
    if (resource) setQuery(resource);
  }, []);

  useEffect(() => {
    if (!account.configured) {
      setPayload(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const refresh = refreshNow.current;
    refreshNow.current = false;
    if (refresh) setLoading(true);
    setError(null);
    fetch(refresh ? "/api/alarms?refresh=1" : "/api/alarms")
      .then(async (response) => {
        const json = await response.json();
        if (cancelled) return;
        if (response.ok && json.live) {
          setPayload(json as AlarmsPayload);
          return;
        }
        setPayload(null);
        if (json.error !== "not_scanned" && json.error !== "sync_disabled") {
          setError("Live alarm scan failed. Sample alarms are not shown in their place.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPayload(null);
          setError("Live alarm scan failed. Sample alarms are not shown in their place.");
        }
      })
      .finally(() => {
        if (!cancelled && refresh) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account.configured, revision, refreshTick]);

  const demo = useMemo(() => demoAlarms(), []);
  const data = payload?.live ? payload : error ? null : demo;
  const alarms = data?.alarms ?? [];
  const inService = useMemo(() => alarms.filter((alarm) => alarm.service === service), [alarms, service]);

  const regionOptions = useMemo(() => Array.from(new Set(inService.map((alarm) => alarm.region))).sort(), [inService]);
  const metrics = useMemo(() => Array.from(new Set(inService.map((alarm) => alarm.friendlyMetric))).sort(), [inService]);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inService.filter((alarm) => {
      if (regions.length && !regions.includes(alarm.region)) return false;
      if (metric !== "all" && alarm.friendlyMetric !== metric) return false;
      if (noisyOnly && !(alarm.noiseProne || alarm.flapping)) return false;
      if (noActionOnly && !alarm.noAction && !alarm.actionsDisabled) return false;
      if (!q) return true;
      return `${alarm.resourceName ?? ""} ${alarm.resourceId ?? ""} ${alarm.name} ${alarm.friendlyMetric}`.toLowerCase().includes(q);
    });
  }, [inService, query, regions, metric, noisyOnly, noActionOnly]);

  const counts = useMemo(() => {
    const tally = { alarm: 0, ok: 0, insufficient: 0, warning: 0 };
    for (const alarm of matched) tally[alarm.cue] += 1;
    return tally;
  }, [matched]);

  const filtered = useMemo(() => {
    const list = cue === "all" ? matched.slice() : matched.filter((alarm) => alarm.cue === cue);
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => String(sortValue(a, sortKey)).localeCompare(String(sortValue(b, sortKey))) * dir);
    return list;
  }, [matched, cue, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const selected = alarms.find((alarm) => alarm.id === selectedId) ?? null;
  const stamp = (iso: string) => (utc ? formatUtc(iso) : formatLocal(iso));

  const exportCsv = () => {
    const header = ["Resource", "Region", "State", "What", "Rule", "Headline"];
    const lines = filtered.map((alarm) => [alarm.resourceName ?? "", alarm.region, CUE[alarm.cue].label, alarm.friendlyMetric, alarm.rule, alarm.headline]);
    const csv = [header, ...lines].map((line) => line.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${service}-alarms.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="Alarms"
        subtitle="Each service has its own list. Sentences come from the alarm definition. This page does not change alarms, draw charts, or refresh on its own."
        action={
          <span className="flex items-center gap-2">
            {account.configured && (
              <button
                type="button"
                onClick={() => {
                  refreshNow.current = true;
                  setRefreshTick((value) => value + 1);
                }}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60"
              >
                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
                Rescan
              </button>
            )}
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TABS.map((tab) => {
          const summary = data?.summary[tab.id];
          const total = summary ? summary.alarm + summary.ok + summary.insufficient + summary.warning : 0;
          const tone: StatTone = tab.id === "rds" ? "amber" : tab.id === "ec2" ? "slate" : tab.id === "s3" ? "yellow" : "red";
          const icon = tab.id === "rds" ? Database : tab.id === "ec2" ? Server : tab.id === "s3" ? HardDrive : Unlink;
          return (
            <StatCard
              key={tab.id}
              label={tab.label}
              value={summary ? `${summary.alarm}` : "—"}
              caption={summary ? `${summary.alarm} in alarm · ${total} total` : "Waiting for data"}
              tone={tone}
              icon={icon}
              active={service === tab.id}
              onClick={() => {
                setService(tab.id);
                setCue("all");
                setRegions([]);
                setMetric("all");
                setPage(0);
                setSelectedId(null);
              }}
            />
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span>{data ? `Data as of ${stamp(data.asOf)}` : "Waiting for data"}</span>
        <span>History is kept {data?.historyRetentionDays ?? 14} days.</span>
        <button type="button" onClick={() => setUtc((value) => !value)} className="rounded-full bg-gray-100 px-2 py-1 font-semibold text-gray-700">
          {utc ? "Showing UTC" : "Showing local time"}
        </button>
      </div>

      {(error || (data?.warnings.length ?? 0) > 0) && (
        <p className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          {error ? `${error} ` : ""}
          {data?.warnings.slice(0, 3).join(" ")}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <FilterChip label="All" count={matched.length} active={cue === "all"} onClick={() => { setCue("all"); setPage(0); }} />
        {(Object.keys(CUE) as Cue[]).map((key) => (
          <FilterChip key={key} label={CUE[key].label} count={counts[key]} active={cue === key} onClick={() => { setCue(key); setPage(0); }} />
        ))}
      </div>

      <div className="card mt-3 space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-52 flex-1 items-center gap-2 rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-500 sm:max-w-72">
            <Search size={16} />
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Search resource or alarm" className="w-full bg-transparent outline-none placeholder:text-gray-400" />
          </label>
          <select aria-label="Metric" value={metric} onChange={(event) => { setMetric(event.target.value); setPage(0); }} className="rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 outline-none">
            <option value="all">Any metric</option>
            {metrics.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <button type="button" onClick={() => { setNoisyOnly((value) => !value); setPage(0); }} className={noisyOnly ? "rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white" : "rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700"}>
            Noisy only
          </button>
          <button type="button" onClick={() => { setNoActionOnly((value) => !value); setPage(0); }} className={noActionOnly ? "rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white" : "rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700"}>
            No notification
          </button>
          <button type="button" onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700">
            <Download size={15} />
            Export CSV
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {regionOptions.map((region) => {
            const on = regions.includes(region);
            return (
              <button key={region} type="button" aria-pressed={on} onClick={() => { setRegions((current) => current.includes(region) ? current.filter((item) => item !== region) : [...current, region]); setPage(0); }} className={on ? "rounded-full bg-gray-900 px-3 py-1 text-xs font-semibold text-white" : "rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600"}>
                {region}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card mt-3 overflow-hidden">
        {loading && (
          <div className="space-y-2 p-4" aria-busy="true">
            <div className="h-8 animate-pulse rounded-lg bg-gray-100" />
            <div className="h-8 animate-pulse rounded-lg bg-gray-100" />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                {[["resource", "Resource"], ["region", "Region"], ["what", "What"], ["state", "State"], ["rule", "Rule"], ["since", "Since"]].map(([key, label]) => (
                  <th key={key} className="px-3 py-3 font-medium">
                    <button type="button" onClick={() => { setPage(0); if (sortKey === key) setSortDir((dir) => (dir === "asc" ? "desc" : "asc")); else { setSortKey(key); setSortDir("asc"); } }}>
                      {label} {sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((alarm) => (
                <tr key={alarm.id} onClick={() => { setSelectedId(alarm.id); setShowRaw(false); }} className="cursor-pointer hover:bg-gray-50/80">
                  <td className="px-3 py-3">
                    <span className="font-medium text-gray-900">{alarm.resourceName}</span>
                    {alarm.orphaned && <span className="mt-0.5 block text-xs text-amber-700">Resource no longer found</span>}
                    {(alarm.noiseProne || alarm.flapping) && <span className="mt-0.5 block text-xs text-amber-700">Noisy configuration</span>}
                  </td>
                  <td className="px-3 py-3">{alarm.region}<span className="block text-xs text-gray-400">{alarm.regionName}</span></td>
                  <td className="px-3 py-3">{alarm.friendlyMetric}</td>
                  <td className="px-3 py-3"><CueBadge cue={alarm.cue} /></td>
                  <td className="max-w-xs px-3 py-3 text-gray-600">{alarm.rule}</td>
                  <td className="px-3 py-3">{stamp(alarm.stateUpdatedAt)}</td>
                </tr>
              ))}
              {!loading && visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">No alarms match this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
          <span>{filtered.length === 0 ? "0 alarms" : `${safePage * PAGE_SIZE + 1}–${Math.min(filtered.length, safePage * PAGE_SIZE + PAGE_SIZE)} of ${filtered.length}`}</span>
          <span className="flex gap-2">
            <button type="button" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded-lg px-2 py-1 disabled:text-gray-300">Previous</button>
            <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => value + 1)} className="rounded-lg px-2 py-1 disabled:text-gray-300">Next</button>
          </span>
        </div>
      </div>

      {selected && (
        <section className="card mt-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-base font-semibold text-gray-900">{selected.headline}</h2>
            <CueBadge cue={selected.cue} />
          </div>
          <p className="mt-2 text-sm text-gray-700">{selected.rule}</p>
          {selected.valueLine && <p className="mt-1 text-sm text-gray-700">{selected.valueLine}</p>}
          {selected.closeness && <p className="mt-1 text-sm font-medium text-gray-900">{selected.closeness}</p>}
          {selected.closenessNote && <p className="mt-1 text-xs text-gray-500">{selected.closenessNote}</p>}
          <p className="mt-1 text-xs text-gray-500">{selected.missingData} State changed {stamp(selected.stateUpdatedAt)}.</p>
          {selected.gauge && <Gauge gauge={selected.gauge} />}
          {selected.noiseReasons.length > 0 && (
            <ul className="mt-3 list-disc pl-5 text-xs text-amber-800">
              {selected.noiseReasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
          {selected.flapping && <p className="mt-2 text-xs text-amber-800">{selected.flapCount} entries into alarm, {selected.shortEpisodes} shorter than 5 minutes.</p>}
          {(selected.noAction || selected.actionsDisabled) && <p className="mt-2 text-xs text-amber-800">{selected.noAction ? "No notification action is configured." : "Notification actions are turned off."}</p>}
          <div className="mt-3 flex flex-wrap gap-3 text-xs font-semibold">
            <a href={selected.links.alarm} target="_blank" rel="noreferrer" className="text-gray-900 underline">CloudWatch alarm</a>
            {selected.links.resource && <a href={selected.links.resource} target="_blank" rel="noreferrer" className="text-gray-900 underline">Resource in AWS</a>}
            {selected.links.performanceInsights && <a href={selected.links.performanceInsights} target="_blank" rel="noreferrer" className="text-gray-900 underline">Performance Insights</a>}
            {selected.links.monitoring && <Link href={selected.links.monitoring} className="text-gray-900 underline">Monitoring detail</Link>}
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">History</h3>
          {selected.history.length === 0 ? (
            <p className="mt-1 text-xs text-gray-500">No state changes in the retained history.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm text-gray-700">
              {selected.history.map((episode) => (
                <li key={episode.startedAt}>{utc ? episode.sentence : `${stamp(episode.startedAt)} → ${episode.endedAt ? stamp(episode.endedAt) : "still in alarm"} (${episode.durationLabel})`}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setShowRaw((value) => !value)} className="mt-3 text-xs font-semibold text-gray-600 underline">
            {showRaw ? "Hide raw definition" : "Show raw definition"}
          </button>
          {showRaw && (
            <pre className="mt-2 overflow-x-auto rounded-xl bg-gray-50 p-3 text-xs text-gray-700">{JSON.stringify(rawOf(selected), null, 2)}</pre>
          )}
        </section>
      )}

      {service === "rds" && data && (
        <section className="card mt-3 overflow-hidden">
          <div className="px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-900">RDS coverage</h2>
            <p className="mt-1 text-xs text-gray-500">Expected alarms versus what exists. Replica lag is n/a on a primary. A missing cell is not a zero.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-y border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-3 py-2 font-medium">Database</th>
                  {data.coverage.metrics.map((metricItem) => (
                    <th key={metricItem.id} className="px-3 py-2 font-medium">{metricItem.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.coverage.rows.map((row) => (
                  <tr key={row.resourceId}>
                    <td className="px-3 py-2">
                      <span className="font-medium">{row.name}</span>
                      <span className="block text-xs text-gray-400">{row.region} · {row.role}</span>
                    </td>
                    {data.coverage.metrics.map((metricItem) => {
                      const cell = row.cells[metricItem.id];
                      return <td key={metricItem.id} className="px-3 py-2">{COVERAGE[cell?.status ?? "missing"]}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && (
        <p className="mt-3 text-xs leading-relaxed text-gray-500">
          A live refresh of {data.estimate.alarms} alarms across {data.estimate.regions} regions is about {data.estimate.describeAlarms + data.estimate.historyCalls + data.estimate.metricCalls} CloudWatch reads ({data.estimate.describeAlarms} alarm lists, {data.estimate.historyCalls} histories, {data.estimate.metricCalls} current-value calls), cached for about 2 minutes. {data.estimate.note}
        </p>
      )}
    </div>
  );
}

function sortValue(alarm: AlarmView, key: string): string {
  if (key === "region") return alarm.region;
  if (key === "what") return alarm.friendlyMetric;
  if (key === "state") return alarm.cue;
  if (key === "rule") return alarm.rule;
  if (key === "since") return alarm.stateUpdatedAt;
  return alarm.resourceName ?? alarm.name;
}

function rawOf(alarm: AlarmView) {
  return {
    name: alarm.name,
    region: alarm.region,
    state: alarm.state,
    stateUpdatedAt: alarm.stateUpdatedAt,
    stateReason: alarm.stateReason,
    metric: alarm.metricName,
    actions: alarm.actions,
    expression: alarm.expression,
  };
}

function CueBadge({ cue }: { cue: Cue }) {
  const meta = CUE[cue];
  const Icon = meta.Icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${meta.className}`}>
      <Icon size={13} aria-hidden />
      {meta.label}
    </span>
  );
}

function FilterChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={active ? "rounded-full bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white" : "rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 ring-1 ring-gray-200"}>
      {count} {label}
    </button>
  );
}

function Gauge({ gauge }: { gauge: { value: number; limit: number; direction: "higher" | "lower" } }) {
  const ratio = gauge.direction === "higher" ? gauge.value / gauge.limit : gauge.limit / Math.max(gauge.value, Number.MIN_VALUE);
  const width = Math.max(0, Math.min(100, ratio * 100));
  return (
    <div className="mt-3">
      <div className="h-2 rounded-full bg-gray-100" role="img" aria-label="Current value against the limit">
        <div className="h-2 rounded-full bg-gray-900" style={{ width: `${width}%` }} />
      </div>
      <p className="mt-1 text-xs text-gray-500">Single reading against the limit. Not a timeline.</p>
    </div>
  );
}
