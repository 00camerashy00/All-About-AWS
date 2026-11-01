"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Circle, CircleAlert, Download, RefreshCw, Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard, type StatTone } from "@/components/stat-card";
import { useAccount } from "@/components/account-provider";
import { DEFAULT_WINDOW, WINDOWS, type WindowId } from "@/lib/monitoring-config";
import { demoMonitoring } from "@/lib/monitoring-demo";
import { demoAlarms } from "@/lib/alarms-mock";
import { activeAlarmCount, escalateHealth } from "@/lib/alarms-model";
import type { AlarmView } from "@/lib/alarms-types";
import type { Health, MonitoringPayload, MonitoringResource, ServiceId } from "@/lib/monitoring-types";

const PAGE_SIZE = 8;
const SERVICES: { id: ServiceId; label: string }[] = [
  { id: "ec2", label: "EC2" },
  { id: "rds", label: "RDS" },
  { id: "s3", label: "S3" },
];

const HEALTH_META: Record<Health, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  healthy: { label: "Healthy", className: "bg-emerald-50 text-emerald-800 ring-emerald-200", Icon: CheckCircle2 },
  medium: { label: "Medium load", className: "bg-amber-50 text-amber-900 ring-amber-200", Icon: AlertTriangle },
  overloaded: { label: "Overloaded", className: "bg-red-50 text-red-800 ring-red-200", Icon: CircleAlert },
  "no-data": { label: "No data", className: "bg-gray-100 text-gray-600 ring-gray-200", Icon: Circle },
};

const RANK: Record<Health, number> = { "no-data": 0, healthy: 1, medium: 2, overloaded: 3 };

function metricOf(row: MonitoringResource, id: string) {
  return row.metrics.find((item) => item.id === id);
}

function cell(row: MonitoringResource, id: string): string {
  return metricOf(row, id)?.display ?? "Not available";
}

function sortValue(row: MonitoringResource, key: string): string | number {
  if (key === "name") return row.name;
  if (key === "id") return row.id;
  if (key === "region") return row.region;
  if (key === "state") return row.state;
  if (key === "health") return RANK[row.health];
  if (key === "type") return String(row.extras.instanceType ?? "");
  if (key === "engine") return String(row.extras.engine ?? "");
  if (key === "class") return String(row.extras.class ?? "");
  if (key === "versioning") return String(row.extras.versioning ?? "");
  const metric = metricOf(row, key);
  if (!metric || metric.value == null) return -1;
  return metric.value;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export default function MonitoringPage() {
  const { account, revision } = useAccount();
  const [service, setService] = useState<ServiceId>("ec2");
  const [windowId, setWindowId] = useState<WindowId>(DEFAULT_WINDOW);
  const [payload, setPayload] = useState<MonitoringPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshNow = useRef(false);
  const [query, setQuery] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [status, setStatus] = useState<"all" | Health>("all");
  const [tagQuery, setTagQuery] = useState("");
  const [ec2State, setEc2State] = useState("all");
  const [family, setFamily] = useState("all");
  const [cpuBand, setCpuBand] = useState("all");
  const [engine, setEngine] = useState("all");
  const [instanceClass, setInstanceClass] = useState("all");
  const [multiAz, setMultiAz] = useState("all");
  const [storageBand, setStorageBand] = useState("all");
  const [sizeBand, setSizeBand] = useState("all");
  const [versioning, setVersioning] = useState("all");
  const [storageClass, setStorageClass] = useState("all");
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [alarmRows, setAlarmRows] = useState<AlarmView[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const next = params.get("service");
    const resource = params.get("resource");
    if (next === "ec2" || next === "rds" || next === "s3") setService(next);
    if (resource) setQuery(resource);
  }, []);

  useEffect(() => {
    if (!account.configured) {
      setAlarmRows(demoAlarms().alarms);
      return;
    }
    let cancelled = false;
    fetch("/api/alarms")
      .then(async (response) => {
        const json = await response.json();
        if (cancelled) return;
        if (response.ok && json.live) setAlarmRows(json.alarms ?? []);
        else setAlarmRows([]);
      })
      .catch(() => {
        if (!cancelled) setAlarmRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [account.configured, revision]);

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
    fetch(`/api/monitoring?service=${service}&window=${windowId}${refresh ? "&refresh=1" : ""}`)
      .then(async (response) => {
        const json = await response.json();
        if (cancelled) return;
        if (response.ok && json.live) {
          setPayload(json as MonitoringPayload);
          return;
        }
        setPayload(null);
        if (json.error !== "not_scanned" && json.error !== "sync_disabled") {
          setError("Live monitoring scan failed. Sample rows are not shown in their place.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPayload(null);
          setError("Live monitoring scan failed. Sample rows are not shown in their place.");
        }
      })
      .finally(() => {
        if (!cancelled && refresh) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account.configured, revision, service, windowId, refreshTick]);

  const demo = useMemo(() => demoMonitoring(service, windowId), [service, windowId]);
  const livePayload = payload?.service === service && payload.window === windowId ? payload : null;
  const data = error ? null : livePayload ?? demo;
  const resources = data?.resources ?? [];
  const choose = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(0);
  };

  const resetFilters = () => {
    setQuery("");
    setRegions([]);
    setStatus("all");
    setTagQuery("");
    setEc2State("all");
    setFamily("all");
    setCpuBand("all");
    setEngine("all");
    setInstanceClass("all");
    setMultiAz("all");
    setStorageBand("all");
    setSizeBand("all");
    setVersioning("all");
    setStorageClass("all");
    setSortKey("name");
    setSortDir("asc");
    setPage(0);
    setSelectedId(null);
  };

  const regionOptions = useMemo(() => Array.from(new Set(resources.map((row) => row.region))).sort(), [resources]);
  const families = useMemo(
    () => Array.from(new Set(resources.map((row) => String(row.extras.family ?? "")).filter(Boolean))).sort(),
    [resources]
  );
  const states = useMemo(() => Array.from(new Set(resources.map((row) => row.state))).sort(), [resources]);
  const engines = useMemo(
    () => Array.from(new Set(resources.map((row) => String(row.extras.engine ?? "")).filter(Boolean))).sort(),
    [resources]
  );
  const classes = useMemo(
    () => Array.from(new Set(resources.map((row) => String(row.extras.class ?? "")).filter(Boolean))).sort(),
    [resources]
  );

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    const tag = tagQuery.trim().toLowerCase();
    return resources.filter((row) => {
      if (regions.length && !regions.includes(row.region)) return false;
      if (q && !`${row.name} ${row.id}`.toLowerCase().includes(q)) return false;
      if (tag) {
        const hay = Object.entries(row.tags).map(([key, value]) => `${key}:${value}`).join(" ").toLowerCase();
        if (!hay.includes(tag)) return false;
      }
      if (service === "ec2") {
        if (ec2State !== "all" && row.state !== ec2State) return false;
        if (family !== "all" && row.extras.family !== family) return false;
        const cpu = metricOf(row, "cpu");
        if (cpuBand === "none" && cpu?.value != null) return false;
        if (cpuBand === "under40" && (cpu?.value == null || cpu.value >= 40)) return false;
        if (cpuBand === "mid" && (cpu?.value == null || cpu.value < 40 || cpu.value > 75)) return false;
        if (cpuBand === "high" && (cpu?.value == null || cpu.value <= 75)) return false;
      }
      if (service === "rds") {
        if (engine !== "all" && row.extras.engine !== engine) return false;
        if (instanceClass !== "all" && row.extras.class !== instanceClass) return false;
        if (multiAz === "yes" && row.extras.multiAz !== true) return false;
        if (multiAz === "no" && row.extras.multiAz !== false) return false;
        const free = row.extras.freeStoragePct;
        const pct = typeof free === "number" ? free : null;
        if (storageBand === "none" && pct != null) return false;
        if (storageBand === "low" && (pct == null || pct >= 15)) return false;
        if (storageBand === "mid" && (pct == null || pct < 15 || pct >= 30)) return false;
        if (storageBand === "ok" && (pct == null || pct < 30)) return false;
      }
      if (service === "s3") {
        if (versioning !== "all" && row.extras.versioning !== versioning) return false;
        if (storageClass !== "all" && row.extras.storageClass !== storageClass) return false;
        const size = row.extras.sizeBytes;
        const bytes = typeof size === "number" ? size : null;
        const gb = bytes == null ? null : bytes / 1024 ** 3;
        if (sizeBand === "none" && gb != null) return false;
        if (sizeBand === "small" && (gb == null || gb >= 10)) return false;
        if (sizeBand === "mid" && (gb == null || gb < 10 || gb > 100)) return false;
        if (sizeBand === "large" && (gb == null || gb <= 100)) return false;
      }
      return true;
    });
  }, [
    resources,
    query,
    regions,
    tagQuery,
    service,
    ec2State,
    family,
    cpuBand,
    engine,
    instanceClass,
    multiAz,
    storageBand,
    versioning,
    storageClass,
    sizeBand,
  ]);

  const shownHealth = (row: MonitoringResource) => escalateHealth(row.health, activeAlarmCount(alarmRows, row.id), row.healthReason);

  const counts = useMemo(() => {
    const tally: Record<Health, number> = { healthy: 0, medium: 0, overloaded: 0, "no-data": 0 };
    for (const row of matched) tally[shownHealth(row).health] += 1;
    return tally;
  }, [matched, alarmRows]);

  const filtered = useMemo(() => {
    const list = status === "all" ? matched.slice() : matched.filter((row) => shownHealth(row).health === status);
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const left = sortKey === "health" ? RANK[shownHealth(a).health] : sortValue(a, sortKey);
      const right = sortKey === "health" ? RANK[shownHealth(b).health] : sortValue(b, sortKey);
      if (typeof left === "number" && typeof right === "number") return (left - right) * dir;
      return String(left).localeCompare(String(right)) * dir;
    });
    return list;
  }, [matched, status, sortKey, sortDir, alarmRows]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const selected = resources.find((row) => row.id === selectedId) ?? null;

  const columns =
    service === "ec2"
      ? [
          ["name", "Name"],
          ["id", "Instance ID"],
          ["type", "Type"],
          ["state", "State"],
          ["region", "Region"],
          ["cpu", "Avg CPU"],
          ["networkIn", "Network in"],
          ["networkOut", "Network out"],
          ["status", "Status checks"],
          ["health", "Health"],
        ]
      : service === "rds"
        ? [
            ["name", "Identifier"],
            ["engine", "Engine"],
            ["class", "Class"],
            ["region", "Region"],
            ["cpu", "Avg CPU"],
            ["memory", "Freeable memory"],
            ["storage", "Free storage"],
            ["connections", "Connections"],
            ["iops", "IOPS"],
            ["health", "Health"],
          ]
        : [
            ["name", "Bucket"],
            ["region", "Region"],
            ["size", "Total size"],
            ["objects", "Objects"],
            ["requests", "Requests"],
            ["errors", "Error rate"],
            ["versioning", "Versioning"],
            ["health", "Health"],
          ];

  const toggleSort = (key: string) => {
    setPage(0);
    if (sortKey === key) setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const exportCsv = () => {
    const header = columns.map((column) => column[1]);
    const lines = filtered.map((row) =>
      columns.map(([key]) => {
        if (key === "health") return HEALTH_META[row.health].label;
        if (key === "name" || key === "id" || key === "region" || key === "state") return String(sortValue(row, key));
        if (key === "type" || key === "engine" || key === "class" || key === "versioning") return String(sortValue(row, key));
        return cell(row, key);
      })
    );
    const csv = [header, ...lines].map((line) => line.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${service}-monitoring.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="Monitoring"
        subtitle="One list per service. Each number is a single CloudWatch aggregate for the window. This page does not draw charts and does not refresh on its own."
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
            <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ${data?.live ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-gray-100 text-gray-500 ring-gray-200"}`}>
              {data?.live ? "Live AWS data" : "Demo data"}
            </span>
          </span>
        }
      />

      <div className="card flex flex-wrap items-center gap-2 p-3">
        {SERVICES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setService(item.id);
              resetFilters();
            }}
            className={
              service === item.id
                ? "rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
                : "rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700"
            }
          >
            {item.label}
          </button>
        ))}
        <label className="inline-flex items-center gap-2 rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700">
          Window
          <select
            aria-label="Time window"
            value={windowId}
            onChange={(event) => {
              setWindowId(event.target.value as WindowId);
              setPage(0);
            }}
            className="bg-transparent font-semibold text-gray-900 outline-none"
          >
            {Object.values(WINDOWS).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <p className="ml-auto text-xs text-gray-500">
          {data ? `Data as of ${new Date(data.asOf).toLocaleString()} · ${data.windowLabel}` : "Waiting for data"}
        </p>
      </div>

      {(error || (data?.warnings.length ?? 0) > 0) && (
        <p className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          {error ? `${error} ` : ""}
          {data?.warnings.slice(0, 4).join(" ")}
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(Object.keys(HEALTH_META) as Health[]).map((key) => {
          const tone: StatTone = key === "overloaded" ? "red" : key === "medium" ? "amber" : key === "healthy" ? "yellow" : "slate";
          const total = Math.max(1, matched.length);
          return (
            <StatCard
              key={key}
              label={HEALTH_META[key].label}
              value={`${counts[key]}`}
              caption={status === key ? "Showing this group" : `${matched.length} in this list`}
              pct={(counts[key] / total) * 100}
              tone={tone}
              icon={HEALTH_META[key].Icon}
              active={status === key}
              onClick={() => {
                setStatus(status === key ? "all" : key);
                setPage(0);
              }}
            />
          );
        })}
      </div>

      <div className="card mt-3 space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-52 flex-1 items-center gap-2 rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-500 sm:max-w-72">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(0); }}
              placeholder="Search name or ID"
              className="w-full bg-transparent outline-none placeholder:text-gray-400"
            />
          </label>
          <input
            aria-label="Tags"
            value={tagQuery}
            onChange={(event) => { setTagQuery(event.target.value); setPage(0); }}
            placeholder="Tag"
            className="rounded-xl bg-gray-100 px-3 py-2 text-sm outline-none"
          />
          {service === "ec2" && (
            <>
              <FilterSelect label="State" value={ec2State} onChange={choose(setEc2State)} options={["all", ...states]} />
              <FilterSelect label="Family" value={family} onChange={choose(setFamily)} options={["all", ...families]} />
              <FilterSelect
                label="CPU"
                value={cpuBand}
                onChange={choose(setCpuBand)}
                options={[
                  ["all", "Any CPU"],
                  ["under40", "CPU under 40%"],
                  ["mid", "CPU 40–75%"],
                  ["high", "CPU over 75%"],
                  ["none", "CPU no data"],
                ]}
              />
            </>
          )}
          {service === "rds" && (
            <>
              <FilterSelect label="Engine" value={engine} onChange={choose(setEngine)} options={["all", ...engines]} />
              <FilterSelect label="Class" value={instanceClass} onChange={choose(setInstanceClass)} options={["all", ...classes]} />
              <FilterSelect label="Multi-AZ" value={multiAz} onChange={choose(setMultiAz)} options={[["all", "Any Multi-AZ"], ["yes", "Multi-AZ"], ["no", "Single-AZ"]]} />
              <FilterSelect
                label="Storage"
                value={storageBand}
                onChange={choose(setStorageBand)}
                options={[
                  ["all", "Any free storage"],
                  ["low", "Free storage under 15%"],
                  ["mid", "Free storage 15–30%"],
                  ["ok", "Free storage 30% or more"],
                  ["none", "Storage no data"],
                ]}
              />
            </>
          )}
          {service === "s3" && (
            <>
              <FilterSelect
                label="Size"
                value={sizeBand}
                onChange={choose(setSizeBand)}
                options={[
                  ["all", "Any size"],
                  ["small", "Under 10 GB"],
                  ["mid", "10–100 GB"],
                  ["large", "Over 100 GB"],
                  ["none", "Size no data"],
                ]}
              />
              <FilterSelect label="Versioning" value={versioning} onChange={choose(setVersioning)} options={["all", "Enabled", "Off", "Suspended", "Unknown"]} />
              <FilterSelect label="Storage class" value={storageClass} onChange={choose(setStorageClass)} options={["all", "Standard", "Glacier", "Mixed"]} />
            </>
          )}
          <button
            type="button"
            onClick={exportCsv}
            className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {regionOptions.map((region) => {
            const on = regions.includes(region);
            return (
              <button
                key={region}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setRegions((current) => (current.includes(region) ? current.filter((item) => item !== region) : [...current, region]));
                  setPage(0);
                }}
                className={on ? "rounded-full bg-gray-900 px-3 py-1 text-xs font-semibold text-white" : "rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600"}
              >
                {region}
              </button>
            );
          })}
          {regionOptions.length === 0 && <span className="text-xs text-gray-400">No regions in this list</span>}
        </div>
      </div>

      <div className="card mt-3 overflow-hidden">
        {loading && (
          <div className="space-y-2 p-4" aria-busy="true">
            <div className="h-8 animate-pulse rounded-lg bg-gray-100" />
            <div className="h-8 animate-pulse rounded-lg bg-gray-100" />
            <div className="h-8 animate-pulse rounded-lg bg-gray-100" />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                {columns.map(([key, label]) => (
                  <th key={key} className="px-3 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1">
                      {label}
                      {sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((row) => {
                const active = activeAlarmCount(alarmRows, row.id);
                const shown = escalateHealth(row.health, active, row.healthReason);
                return (
                <tr key={row.id} onClick={() => setSelectedId(row.id)} className="cursor-pointer hover:bg-gray-50/80">
                  {columns.map(([key]) => (
                    <td key={key} className="px-3 py-3 align-middle">
                      {key === "health" ? (
                        <HealthBadge health={shown.health} reason={shown.reason} underutilized={row.underutilized} />
                      ) : key === "name" ? (
                        <span>
                          <span className="font-medium text-gray-900">{row.name}</span>
                          {row.coverage && <span className="mt-0.5 block text-xs text-amber-700">{row.coverage}</span>}
                          {active > 0 && (
                            <Link href={`/alarms?service=${row.service}&resource=${encodeURIComponent(row.id)}`} onClick={(event) => event.stopPropagation()} className="mt-0.5 block text-xs font-semibold text-red-700">
                              {active} in alarm
                            </Link>
                          )}
                        </span>
                      ) : key === "id" || key === "region" || key === "state" ? (
                        String(sortValue(row, key))
                      ) : key === "type" || key === "engine" || key === "class" || key === "versioning" ? (
                        String(sortValue(row, key))
                      ) : (
                        cell(row, key)
                      )}
                    </td>
                  ))}
                </tr>
                );
              })}
              {!loading && visible.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-gray-500">
                    No resources match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
          <span>
            {filtered.length === 0
              ? "0 resources"
              : `${safePage * PAGE_SIZE + 1}–${Math.min(filtered.length, safePage * PAGE_SIZE + PAGE_SIZE)} of ${filtered.length}`}
          </span>
          <span className="flex gap-2">
            <button type="button" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded-lg px-2 py-1 disabled:text-gray-300">
              Previous
            </button>
            <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => value + 1)} className="rounded-lg px-2 py-1 disabled:text-gray-300">
              Next
            </button>
          </span>
        </div>
      </div>

      {selected && data && (
        <section className="card mt-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-900">{selected.name}</h2>
              <p className="mt-1 text-xs text-gray-500">
                {selected.id} · {selected.region} · {selected.state} · window {data.windowLabel} · data as of {new Date(data.asOf).toLocaleString()}
                {selected.coverage ? ` · coverage ${selected.coverage}` : ""}
              </p>
            </div>
            <HealthBadge health={escalateHealth(selected.health, activeAlarmCount(alarmRows, selected.id), selected.healthReason).health} reason={escalateHealth(selected.health, activeAlarmCount(alarmRows, selected.id), selected.healthReason).reason} underutilized={selected.underutilized} />
          </div>
          <p className="mt-3 text-sm text-gray-700">Triggered by: {escalateHealth(selected.health, activeAlarmCount(alarmRows, selected.id), selected.healthReason).reason}</p>
          {activeAlarmCount(alarmRows, selected.id) > 0 && (
            <Link href={`/alarms?service=${selected.service}&resource=${encodeURIComponent(selected.id)}`} className="mt-2 inline-block text-xs font-semibold text-red-700">
              {activeAlarmCount(alarmRows, selected.id)} CloudWatch alarm in the ALARM state
            </Link>
          )}
          <ul className="mt-3 divide-y divide-gray-100">
            {selected.metrics.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-gray-600">{item.label}</span>
                <span className="flex items-center gap-2">
                  <span className="font-medium text-gray-900">{item.display}</span>
                  <HealthBadge health={item.status} reason={item.drivesHealth ? item.label : "Does not change overall health"} />
                </span>
              </li>
            ))}
          </ul>
          {selected.notes.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-gray-600">
              {selected.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs leading-relaxed text-gray-500">
            Thresholds: CPU under 40% healthy, 40–75% medium load, over 75% overloaded. RDS free storage under 15% overloaded and under 30% medium. RDS connections over 80% of the class maximum are overloaded. Under 5% CPU on a running resource is an underutilized cost hint, separate from health. Memory and disk need the CloudWatch agent. S3 request rates need request metrics.
          </p>
        </section>
      )}
    </div>
  );
}

function HealthBadge({ health, reason, underutilized = false }: { health: Health; reason: string; underutilized?: boolean }) {
  const meta = HEALTH_META[health];
  const Icon = meta.Icon;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span title={reason} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${meta.className}`}>
        <Icon size={13} aria-hidden />
        {meta.label}
      </span>
      {underutilized && (
        <span title="Average CPU is under 5%" className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-800 ring-1 ring-sky-200">
          Underutilized
        </span>
      )}
    </span>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: (string | [string, string])[];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 outline-none"
    >
      {options.map((option) => {
        const [id, text] = Array.isArray(option) ? option : [option, option === "all" ? `Any ${label.toLowerCase()}` : option];
        return (
          <option key={id} value={id}>
            {text}
          </option>
        );
      })}
    </select>
  );
}
