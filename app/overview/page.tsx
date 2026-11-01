"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Database, HardDrive, RefreshCw, Search, Server, TriangleAlert } from "lucide-react";
import { StatCard, type StatTone } from "@/components/stat-card";
import { resources } from "@/lib/mock-data";
import { InsightBanner } from "@/components/insight-banner";
import { useAccount } from "@/components/account-provider";
import type { Inventory } from "@/lib/aws-resources";

type Stat = {
  label: string;
  value: string;
  caption: string;
  pct: number;
  tone: StatTone;
};

type Row = {
  key: string;
  href: string;
  title: string;
  detail: string;
  meter: number;
  hot: boolean;
};

type Board = {
  stats: Stat[];
  gauge: { pct: number; value: string; goal: string; caption: string };
  plan: { pct: number; left: string; right: string; caption: string };
  rows: Row[];
};

const statIcon = {
  Servers: Server,
  Databases: Database,
  Buckets: HardDrive,
} as const;

export default function OverviewPage() {
  const { account, revision } = useAccount();
  const router = useRouter();
  const [inv, setInv] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshNow = useRef(false);

  useEffect(() => {
    if (!account.configured) {
      setInv(null);
      setLoading(false);
      setLiveError(null);
      return;
    }
    let cancelled = false;
    const refresh = refreshNow.current;
    refreshNow.current = false;
    if (refresh) setLoading(true);
    setLiveError(null);
    fetch(`/api/resources${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json().then((json) => ({ ok: r.ok, json })))
      .then(({ ok, json }) => {
        if (cancelled) return;
        if (ok && json.live) {
          setInv(json as Inventory);
          setLiveError(null);
          return;
        }
        if (json.error === "not_scanned" || json.error === "sync_disabled") {
          setInv(null);
          setLiveError(null);
          return;
        }
        setInv(null);
        setLiveError(
          json.detail ||
            (json.error === "credentials_expired_or_denied"
              ? "AWS rejected the keys in the user menu. Showing demo data."
              : "Couldn't read the live inventory. Showing demo data.")
        );
      })
      .catch(() => {
        if (!cancelled) {
          setInv(null);
          setLiveError("Couldn't read the live inventory. Showing demo data.");
        }
      })
      .finally(() => {
        if (!cancelled && refresh) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account.configured, revision, refreshTick]);

  const onRefresh = () => {
    if (!account.configured || loading) return;
    refreshNow.current = true;
    setRefreshTick((n) => n + 1);
  };

  const board = useMemo(() => (inv ? liveBoard(inv) : demoBoard()), [inv]);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = search.trim().toLowerCase();
    if (!q) {
      router.push("/resources");
      return;
    }
    const hits = inv
      ? [
          ...inv.instances.map((item) => ({ id: item.id, label: `${item.name} ${item.id}` })),
          ...inv.databases.map((item) => ({ id: item.id, label: item.id })),
          ...inv.buckets.map((item) => ({ id: item.name, label: item.name })),
        ].filter((item) => item.label.toLowerCase().includes(q))
      : resources
          .filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(q))
          .map((item) => ({ id: item.id, label: item.name }));
    if (hits.length === 1) {
      router.push(`/resources/${hits[0].id}`);
      return;
    }
    router.push(`/resources?q=${encodeURIComponent(search.trim())}`);
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Good morning, Ashish</h1>
          <p className="mt-1 text-sm text-gray-500">Let&apos;s take a look at your account today.</p>
        </div>
        <form onSubmit={onSearch} className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm text-gray-500 ring-1 ring-gray-200">
            <button type="submit" aria-label="Search" className="text-gray-500">
              <Search size={15} />
            </button>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search servers, databases, buckets"
              aria-label="Search servers, databases, buckets"
              className="w-44 bg-transparent text-gray-900 outline-none placeholder:text-gray-400 sm:w-64"
            />
          </div>
          {account.configured ? (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-xs font-semibold text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              Rescan
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-xs font-semibold text-gray-600 ring-1 ring-gray-200">
              Demo data
            </span>
          )}
        </form>
      </div>

      {liveError && (
        <div className="mt-4">
          <InsightBanner tone="warn" title="Live data unavailable" body={liveError} />
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {board.stats.map((stat) => (
          <StatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
            caption={stat.caption}
            pct={stat.pct}
            tone={stat.tone}
            icon={statIcon[stat.label as keyof typeof statIcon] ?? TriangleAlert}
          />
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-12">
        <div className="grid gap-3 xl:col-span-4">
          <section className="card p-4">
            <p className="text-sm font-semibold">Healthy share</p>
            <p className="text-xs text-gray-500">Resources that need no decision</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-gray-500">In good shape</p>
                <p className="text-sm font-medium">{board.gauge.caption}</p>
              </div>
              <Gauge pct={board.gauge.pct} value={board.gauge.value} goal={board.gauge.goal} />
            </div>
          </section>
          <section className="card p-4">
            <div className="flex items-center justify-between text-sm">
              <p className="font-semibold">Decision queue</p>
              <p className="font-semibold">{board.plan.pct}%</p>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-zinc-900" style={{ width: `${board.plan.pct}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-gray-500">
              <span>{board.plan.left}</span>
              <span>{board.plan.right}</span>
            </div>
            <p className="mt-2 text-xs text-gray-500">{board.plan.caption}</p>
          </section>
        </div>

        <section className="card p-4 xl:col-span-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Needs a decision</h2>
            <Link href="/resources" className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900">
              All resources <ArrowUpRight size={14} />
            </Link>
          </div>
          {board.rows.length === 0 ? (
            <p className="py-8 text-sm text-gray-500">Nothing is flagged. Servers, databases, and storage look tidy.</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-100">
              {board.rows.map((row) => (
                <li key={row.key}>
                  <Link href={row.href} className="flex items-center gap-3 py-3 hover:bg-gray-50">
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${row.hot ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-700"}`}>
                      <TriangleAlert size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{row.title}</span>
                      <span className="block truncate text-xs text-gray-500">{row.detail}</span>
                    </span>
                    <span className="hidden w-28 sm:block">
                      <span className="mb-1 block text-right text-[10px] text-gray-400">{row.meter}%</span>
                      <span className="flex h-3 items-end gap-0.5">
                        {Array.from({ length: 12 }).map((_, i) => (
                          <span
                            key={i}
                            className={`w-1.5 rounded-sm ${i < Math.round(row.meter / 8.4) ? (row.hot ? "bg-red-400" : "bg-orange-400") : "bg-gray-100"}`}
                            style={{ height: `${8 + (i % 4) * 3}px` }}
                          />
                        ))}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Gauge({ pct, value, goal }: { pct: number; value: string; goal: string }) {
  const r = 36;
  const c = 2 * Math.PI * r;
  const shown = Math.min(100, Math.max(0, pct));
  const dash = (shown / 100) * c;
  return (
    <div className="relative h-24 w-24">
      <svg viewBox="0 0 100 100" className="h-24 w-24">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#f3f4f6" strokeWidth="8" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="#ef4444"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-sm font-semibold">{value}</span>
        <span className="text-[10px] text-gray-400">{goal}</span>
      </div>
    </div>
  );
}

function demoBoard(): Board {
  const servers = resources.filter((r) => r.kind === "ec2");
  const databases = resources.filter((r) => r.kind === "rds");
  const buckets = resources.filter((r) => r.kind === "s3");
  const flagged = resources.filter((r) => r.status !== "healthy");
  const healthy = resources.length - flagged.length;
  return {
    stats: [
      { label: "Servers", value: `${servers.length}`, caption: `${servers.filter((s) => s.status === "healthy").length} running normally`, pct: (servers.filter((s) => s.status === "healthy").length / servers.length) * 100, tone: "slate" },
      { label: "Databases", value: `${databases.length}`, caption: `${databases.filter((d) => d.status !== "healthy").length} need a look`, pct: 70, tone: "amber" },
      { label: "Buckets", value: `${buckets.length}`, caption: "File storage in this sample", pct: 50, tone: "yellow" },
    ],
    gauge: { pct: Math.round((healthy / resources.length) * 100), value: `${healthy}`, goal: `of ${resources.length}`, caption: `${healthy} of ${resources.length} resources` },
    plan: { pct: Math.round((flagged.length / resources.length) * 100), left: "0 flagged", right: `${resources.length} resources`, caption: `${flagged.length} still need a decision.` },
    rows: flagged.map((r) => ({
      key: r.id,
      href: `/resources/${r.id}`,
      title: r.name,
      detail: r.insight,
      meter: r.status === "critical" ? r.cpu : r.storage,
      hot: r.status === "critical",
    })),
  };
}

function liveBoard(inv: Inventory): Board {
  const running = inv.instances.filter((i) => i.state === "running").length;
  const servers = inv.instances.length;
  const databases = inv.databases.length;
  const available = inv.databases.filter((d) => d.status === "available").length;
  const buckets = inv.buckets.length;
  const flagged = inv.waste.filter((w) => w.severity !== "healthy");
  const healthy =
    inv.instances.filter((i) => i.status === "healthy").length +
    inv.databases.filter((d) => d.statusLevel === "healthy").length +
    inv.buckets.filter((b) => b.statusLevel === "healthy").length;
  const total = Math.max(1, servers + databases + buckets);
  return {
    stats: [
      { label: "Servers", value: `${servers}`, caption: `${running} running`, pct: servers ? (running / servers) * 100 : 0, tone: "slate" },
      { label: "Databases", value: `${databases}`, caption: `${available} available`, pct: databases ? (available / databases) * 100 : 0, tone: "amber" },
      { label: "Buckets", value: `${buckets}`, caption: inv.buckets.filter((bucket) => !bucket.lifecycle).length ? `${inv.buckets.filter((bucket) => !bucket.lifecycle).length} without cleanup rules` : "Cleanup rules are on", pct: buckets ? 100 : 0, tone: "yellow" },
    ],
    gauge: {
      pct: Math.round((healthy / total) * 100),
      value: `${healthy}`,
      goal: `of ${servers + databases + buckets}`,
      caption: `${healthy} of ${servers + databases + buckets}`,
    },
    plan: {
      pct: Math.round((flagged.length / total) * 100),
      left: "0 flagged",
      right: `${servers + databases + buckets} resources`,
      caption: flagged.length ? `${flagged[0].title}` : "Nothing is flagged right now.",
    },
    rows: flagged.slice(0, 6).map((w, i) => ({
      key: `${w.title}-${i}`,
      href: "/resources",
      title: w.title,
      detail: w.detail,
      meter: w.severity === "critical" ? 90 : 55,
      hot: w.severity === "critical",
    })),
  };
}
