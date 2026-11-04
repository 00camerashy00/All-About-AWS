"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Database, HardDrive, RefreshCw, Search, Server, TriangleAlert, Users } from "lucide-react";
import { StatCard, type StatTone } from "@/components/stat-card";
import { resources } from "@/lib/mock-data";
import { demoUsers } from "@/lib/users-demo";
import { InsightBanner } from "@/components/insight-banner";
import { useAccount } from "@/components/account-provider";
import type { Inventory } from "@/lib/aws-resources";
import { scopeScanned } from "@/lib/inventory-merge";
import type { UsersPayload } from "@/lib/users-types";

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
  Users: Users,
  Servers: Server,
  Databases: Database,
  Buckets: HardDrive,
} as const;

type BusyKey = "all" | "users" | "servers" | "databases" | "buckets" | "health" | "queue" | "decisions";
type ResourceScope = "ec2" | "rds" | "s3";

const cardScope: Record<"servers" | "databases" | "buckets", ResourceScope> = {
  servers: "ec2",
  databases: "rds",
  buckets: "s3",
};

export default function OverviewPage() {
  const { account, revision } = useAccount();
  const router = useRouter();
  const [inv, setInv] = useState<Inventory | null>(null);
  const [directory, setDirectory] = useState<UsersPayload | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<Partial<Record<BusyKey, boolean>>>({});
  const alive = useRef(true);
  const cacheToken = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const applyInventory = (json: Inventory) => {
    setInv((prev) => {
      if (prev && (json.cacheRevision ?? 0) < (prev.cacheRevision ?? 0)) return prev;
      return json;
    });
  };

  const pullUsers = async (refresh: boolean, token?: number) => {
    try {
      const res = await fetch(refresh ? "/api/users?refresh=1" : "/api/users");
      const json = await res.json();
      if (!alive.current || (token !== undefined && token !== cacheToken.current)) return false;
      if (res.ok && json.live) {
        setDirectory(json as UsersPayload);
        return true;
      }
      if (!refresh) setDirectory(null);
      else setLiveError(json.detail || "Couldn't refresh users. Showing the previous list.");
      return false;
    } catch {
      if (!alive.current || (token !== undefined && token !== cacheToken.current)) return false;
      if (!refresh) setDirectory(null);
      else setLiveError("Couldn't refresh users. Showing the previous list.");
      return false;
    }
  };

  const pullResources = async (refresh: boolean, scope?: ResourceScope, token?: number) => {
    const params = new URLSearchParams();
    if (refresh) params.set("refresh", "1");
    if (scope) params.set("scope", scope);
    const qs = params.toString();
    try {
      const res = await fetch(`/api/resources${qs ? `?${qs}` : ""}`);
      const json = await res.json();
      if (!alive.current || (token !== undefined && token !== cacheToken.current)) return false;
      if (res.ok && json.live) {
        applyInventory(json as Inventory);
        return true;
      }
      if (!refresh && (json.error === "not_scanned" || json.error === "sync_disabled")) {
        setInv(null);
        return false;
      }
      if (!refresh) setInv(null);
      setLiveError(
        json.detail ||
          (json.error === "credentials_expired_or_denied"
            ? "AWS rejected the keys in the user menu. Showing demo data."
            : "Couldn't read the live inventory. Showing demo data.")
      );
      return false;
    } catch {
      if (!alive.current || (token !== undefined && token !== cacheToken.current)) return false;
      if (!refresh) setInv(null);
      setLiveError("Couldn't read the live inventory. Showing demo data.");
      return false;
    }
  };

  useEffect(() => {
    if (!account.configured) {
      cacheToken.current += 1;
      setInv(null);
      setDirectory(null);
      setLiveError(null);
      return;
    }
    const token = ++cacheToken.current;
    setLiveError(null);
    void pullUsers(false, token).then((ok) => {
      if (token === cacheToken.current && ok) setLiveError(null);
    });
    void pullResources(false, undefined, token).then((ok) => {
      if (token === cacheToken.current && ok) setLiveError(null);
    });
    return () => {
      if (cacheToken.current === token) cacheToken.current += 1;
    };
    // pullUsers and pullResources close over the latest setters; revision reloads the cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.configured, revision]);

  const run = (key: BusyKey, task: () => Promise<boolean | boolean[]>) => {
    if (!account.configured || busy[key]) return;
    setBusy((prev) => ({ ...prev, [key]: true }));
    void task()
      .then((result) => {
        const ok = Array.isArray(result) ? result.every(Boolean) : result;
        if (ok) setLiveError(null);
      })
      .finally(() => {
        if (alive.current) setBusy((prev) => ({ ...prev, [key]: false }));
      });
  };

  const onRescanAll = () => run("all", () => Promise.all([pullUsers(true), pullResources(true)]));
  const onRescanUsers = () => run("users", () => pullUsers(true));
  const onRescanScope = (key: "servers" | "databases" | "buckets") =>
    run(key, () => pullResources(true, cardScope[key]));
  const onRescanHealth = () =>
    run("health", () => Promise.all([pullResources(true, "ec2"), pullResources(true, "rds"), pullResources(true, "s3")]));
  const onRescanInventory = (key: "queue" | "decisions") => run(key, () => pullResources(true));

  const board = useMemo(() => boardFor(inv), [inv]);
  const people = directory ?? demoUsers();
  const usersCard = userStat(people);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = search.trim().toLowerCase();
    if (!q) {
      router.push("/resources");
      return;
    }
    const hits = [
      ...(inv && scopeScanned(inv, "ec2")
        ? inv.instances.map((item) => ({ id: item.id, label: `${item.name} ${item.id}` }))
        : resources.filter((item) => item.kind === "ec2").map((item) => ({ id: item.id, label: `${item.name} ${item.id}` }))),
      ...(inv && scopeScanned(inv, "rds")
        ? inv.databases.map((item) => ({ id: item.id, label: item.id }))
        : resources.filter((item) => item.kind === "rds").map((item) => ({ id: item.id, label: `${item.name} ${item.id}` }))),
      ...(inv && scopeScanned(inv, "s3")
        ? inv.buckets.map((item) => ({ id: item.name, label: item.name }))
        : resources.filter((item) => item.kind === "s3").map((item) => ({ id: item.id, label: `${item.name} ${item.id}` }))),
    ].filter((item) => item.label.toLowerCase().includes(q));
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
            <RescanButton label="Rescan All" busy={Boolean(busy.all)} onClick={onRescanAll} />
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

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            { stat: usersCard, key: "users" as const, onClick: onRescanUsers },
            { stat: board.stats[0], key: "servers" as const, onClick: () => onRescanScope("servers") },
            { stat: board.stats[1], key: "databases" as const, onClick: () => onRescanScope("databases") },
            { stat: board.stats[2], key: "buckets" as const, onClick: () => onRescanScope("buckets") },
          ] as const
        ).map((card) => (
          <StatCard
            key={card.stat.label}
            label={card.stat.label}
            value={card.stat.value}
            caption={card.stat.caption}
            pct={card.stat.pct}
            tone={card.stat.tone}
            icon={statIcon[card.stat.label as keyof typeof statIcon] ?? TriangleAlert}
            action={
              account.configured ? (
                <RescanButton label={`Rescan ${card.stat.label}`} busy={Boolean(busy[card.key])} onClick={card.onClick} />
              ) : undefined
            }
          />
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-12">
        <div className="grid gap-3 xl:col-span-4">
          <section className="card p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">Healthy share</p>
                <p className="text-xs text-gray-500">Resources that need no decision</p>
              </div>
              {account.configured ? (
                <RescanButton label="Rescan healthy share" busy={Boolean(busy.health)} onClick={onRescanHealth} />
              ) : null}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-gray-500">In good shape</p>
                <p className="text-sm font-medium">{board.gauge.caption}</p>
              </div>
              <Gauge pct={board.gauge.pct} value={board.gauge.value} goal={board.gauge.goal} />
            </div>
          </section>
          <section className="card p-4">
            <div className="flex items-center justify-between gap-2 text-sm">
              <p className="font-semibold">Decision queue</p>
              <div className="flex items-center gap-2">
                {account.configured ? (
                  <RescanButton label="Rescan decision queue" busy={Boolean(busy.queue)} onClick={() => onRescanInventory("queue")} />
                ) : null}
                <p className="font-semibold">{board.plan.pct}%</p>
              </div>
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
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Needs a decision</h2>
            <div className="flex items-center gap-2">
              {account.configured ? (
                <RescanButton label="Rescan needs a decision" busy={Boolean(busy.decisions)} onClick={() => onRescanInventory("decisions")} />
              ) : null}
              <Link href="/resources" className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900">
                All resources <ArrowUpRight size={14} />
              </Link>
            </div>
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

function RescanButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  const text = label === "Rescan All" ? "Rescan All" : "Rescan";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-3 py-2 text-xs font-semibold text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-wait disabled:opacity-60"
    >
      <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
      {text}
    </button>
  );
}

function titledScope(title: string, source?: string): ResourceScope | "other" {
  if (source === "ec2" || source === "rds" || source === "s3" || source === "other") return source;
  if (title.startsWith("Bucket ")) return "s3";
  if (title.startsWith("Database ")) return "rds";
  if (title.endsWith(" is stopped")) return "ec2";
  return "other";
}

function boardFor(inv: Inventory | null): Board {
  if (!inv) return demoBoard();
  const ec2 = scopeScanned(inv, "ec2");
  const rds = scopeScanned(inv, "rds");
  const s3 = scopeScanned(inv, "s3");
  if (ec2 && rds && s3) return liveBoard(inv);
  const demo = demoBoard();
  const live = liveBoard({
    ...inv,
    instances: ec2 ? inv.instances : [],
    databases: rds ? inv.databases : [],
    buckets: s3 ? inv.buckets : [],
    waste: inv.waste.filter((item) => {
      const scope = titledScope(item.title, item.source);
      if (scope === "other") return false;
      return scope === "ec2" ? ec2 : scope === "rds" ? rds : s3;
    }),
  });
  const demoRows = demo.rows.filter((row) => {
    const sample = resources.find((item) => item.id === row.key);
    if (!sample) return false;
    if (sample.kind === "ec2") return !ec2;
    if (sample.kind === "rds") return !rds;
    return !s3;
  });
  const healthy =
    (ec2 ? inv.instances.filter((item) => item.status === "healthy").length : resources.filter((item) => item.kind === "ec2" && item.status === "healthy").length) +
    (rds ? inv.databases.filter((item) => item.statusLevel === "healthy").length : resources.filter((item) => item.kind === "rds" && item.status === "healthy").length) +
    (s3 ? inv.buckets.filter((item) => item.statusLevel === "healthy").length : resources.filter((item) => item.kind === "s3" && item.status === "healthy").length);
  const total =
    (ec2 ? inv.instances.length : resources.filter((item) => item.kind === "ec2").length) +
    (rds ? inv.databases.length : resources.filter((item) => item.kind === "rds").length) +
    (s3 ? inv.buckets.length : resources.filter((item) => item.kind === "s3").length);
  const rows = [...live.rows, ...demoRows].slice(0, 6);
  const flagged = Math.max(0, total - healthy);
  return {
    stats: [ec2 ? live.stats[0] : demo.stats[0], rds ? live.stats[1] : demo.stats[1], s3 ? live.stats[2] : demo.stats[2]],
    gauge: {
      pct: total ? Math.round((healthy / total) * 100) : 0,
      value: `${healthy}`,
      goal: `of ${total}`,
      caption: `${healthy} of ${total}`,
    },
    plan: {
      pct: total ? Math.round((Math.min(flagged, total) / total) * 100) : 0,
      left: "0 flagged",
      right: `${total} resources`,
      caption: rows[0]?.title ?? (flagged ? `${flagged} still need a decision.` : "Nothing is flagged right now."),
    },
    rows,
  };
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

function userStat(data: UsersPayload): Stat {
  const ssm = data.ssm.length;
  const sso = data.sso.length;
  const total = ssm + sso;
  const inactive =
    data.ssm.filter((row) => row.inactive).length + data.sso.filter((row) => row.inactive).length;
  return {
    label: "Users",
    value: `${total}`,
    caption: `${ssm} SSM · ${sso} SSO`,
    pct: total ? ((total - inactive) / total) * 100 : 0,
    tone: "slate",
  };
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
