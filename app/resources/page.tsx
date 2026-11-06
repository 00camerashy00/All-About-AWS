"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Database, HardDrive, RefreshCw, Server, TriangleAlert } from "lucide-react";
import type { Health, Inventory, LiveBucket, LiveDatabase, LiveEFS, LiveSnapshot, LiveVolume } from "@/lib/aws-resources";
import { resources as mockResources, type AwsResource } from "@/lib/mock-data";
import { useAccount } from "@/components/account-provider";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { InsightBanner } from "@/components/insight-banner";
import { HealthTip } from "@/components/health-tip";
import { FilterTable, type FilterColumn } from "@/components/filter-table";
import { detailScanned, scopeScanned } from "@/lib/inventory-merge";
import {
  PROVISION_CHOICES,
  ec2Provision,
  ec2ProvisionDetail,
  rdsProvision,
  rdsProvisionDetail,
  unknownProvision,
  type ProvisionLabel,
} from "@/lib/provision";

type Tab = "servers" | "databases" | "storage" | "attention";

function Fold({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
      >
        <span>
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-xs text-gray-500">{detail}</span>
        </span>
        <ChevronDown size={16} className={`shrink-0 text-gray-400 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && children}
    </section>
  );
}

function healthName(status: string): string {
  if (status === "healthy") return "Healthy";
  if (status === "attention") return "Needs attention";
  if (status === "critical") return "Critical";
  return status;
}

function ProvisionCell({ label, detail }: { label: ProvisionLabel; detail: string }) {
  const tone =
    label === "Under-provisioned"
      ? "bg-red-50 text-red-700 ring-red-200"
      : label === "Over-provisioned"
        ? "bg-amber-50 text-amber-800 ring-amber-200"
        : label === "Right-sized"
          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
          : "bg-gray-100 text-gray-500 ring-gray-200";
  return (
    <span title={detail} className={`pill ring-1 ${tone}`}>
      {label}
    </span>
  );
}

type ServerRow = {
  id: string;
  name: string;
  type: string;
  region: string;
  state: string;
  cpuAvg7d: number | null;
  status: Health;
  flags: string[];
};

type SnapGroup = {
  key: string;
  source: string;
  store: "ebs" | "rds";
  region: string;
  count: number;
  oldest: number;
  items: LiveSnapshot[];
};

const serverColumns: FilterColumn<ServerRow>[] = [
  {
    id: "server",
    label: "Server",
    kind: "text",
    text: (row) => `${row.name} ${row.id}`,
    render: (row) => (
      <>
        <Link href={`/resources/${row.id}`} className="font-medium text-gray-900 hover:underline">
          {row.name || row.id}
        </Link>
        <p className="font-mono text-xs text-gray-400">{row.id}</p>
      </>
    ),
  },
  { id: "type", label: "Type", kind: "text", text: (row) => row.type, render: (row) => row.type },
  { id: "region", label: "Region", kind: "text", text: (row) => row.region, render: (row) => row.region },
  {
    id: "state",
    label: "State · CPU (7d)",
    kind: "choice",
    text: (row) => row.state,
    render: (row) => (
      <>
        {row.state}
        {row.cpuAvg7d !== null ? ` · ${row.cpuAvg7d}%` : ""}
      </>
    ),
  },
  {
    id: "health",
    label: "Health",
    kind: "choice",
    text: (row) => healthName(row.status),
    render: (row) => <HealthTip status={row.status} flags={row.flags} />,
  },
  {
    id: "provision",
    label: "Provision",
    kind: "choice",
    choices: [...PROVISION_CHOICES],
    text: (row) => ec2Provision(row.state, row.cpuAvg7d),
    render: (row) => (
      <ProvisionCell label={ec2Provision(row.state, row.cpuAvg7d)} detail={ec2ProvisionDetail(row.state, row.cpuAvg7d)} />
    ),
  },
];

function liveDbProvision(row: LiveDatabase): ProvisionLabel {
  return rdsProvision({
    available: row.status === "available",
    cpu: row.cpuAvg7d ?? null,
    storageUsedPct: row.storageUsedPct,
    connectionPct: row.connectionPct ?? null,
  });
}

function storageUsedText(row: LiveDatabase): string {
  if (row.storageUsedPct !== null && row.storageGb !== null) return `${row.storageUsedPct}% of ${row.storageGb} GB`;
  if (row.storageGb !== null) return `${row.storageGb} GB allocated`;
  return "—";
}

function backupText(row: LiveDatabase): string {
  const base = row.backupRetentionDays !== null ? `${row.backupRetentionDays}d retention` : "—";
  return row.manualSnapshots > 0 ? `${base} ${row.manualSnapshots} manual snapshots` : base;
}

const databaseColumns: FilterColumn<LiveDatabase>[] = [
  {
    id: "database",
    label: "Database",
    kind: "text",
    text: (row) => `${row.id} ${row.status}`,
    render: (row) => (
      <>
        <Link href={`/resources/${row.id}`} className="font-medium text-gray-900 hover:underline">
          {row.id}
        </Link>
        <p className="text-xs text-gray-400">{row.status}</p>
      </>
    ),
  },
  {
    id: "engine",
    label: "Engine / Size",
    kind: "text",
    text: (row) => `${row.engine} ${row.class}${row.multiAz ? " Multi-AZ" : ""}`,
    render: (row) => (
      <>
        {row.engine}
        <p className="text-xs text-gray-400">
          {row.class}
          {row.multiAz ? " · Multi-AZ" : ""}
        </p>
      </>
    ),
  },
  { id: "region", label: "Region", kind: "text", text: (row) => row.region, render: (row) => row.region },
  { id: "storage", label: "Storage used", kind: "text", text: storageUsedText, render: storageUsedText },
  {
    id: "backups",
    label: "Backups",
    kind: "text",
    text: backupText,
    render: (row) => (
      <>
        {row.backupRetentionDays !== null ? `${row.backupRetentionDays}d retention` : "—"}
        {row.manualSnapshots > 0 && <p className="text-xs text-gray-400">{row.manualSnapshots} manual snapshots</p>}
      </>
    ),
  },
  {
    id: "health",
    label: "Health",
    kind: "choice",
    text: (row) => healthName(row.statusLevel),
    render: (row) => <HealthTip status={row.statusLevel} flags={row.flags} />,
  },
  {
    id: "provision",
    label: "Provision",
    kind: "choice",
    choices: [...PROVISION_CHOICES],
    text: liveDbProvision,
    render: (row) => (
      <ProvisionCell
        label={liveDbProvision(row)}
        detail={rdsProvisionDetail({
          available: row.status === "available",
          cpu: row.cpuAvg7d ?? null,
          storageUsedPct: row.storageUsedPct,
          connectionPct: row.connectionPct ?? null,
        })}
      />
    ),
  },
];

function demoDbProvision(row: AwsResource): ProvisionLabel {
  return rdsProvision({ available: true, cpu: row.cpu, storageUsedPct: row.storage, connectionPct: null });
}

const demoDatabaseColumns: FilterColumn<AwsResource>[] = [
  {
    id: "database",
    label: "Database",
    kind: "text",
    text: (row) => `${row.name} ${row.id} ${row.insight}`,
    render: (row) => (
      <>
        <Link href={`/resources/${row.id}`} className="font-medium text-gray-900 hover:underline">
          {row.name}
        </Link>
        <p className="text-xs text-gray-400">{row.insight}</p>
      </>
    ),
  },
  { id: "region", label: "Region", kind: "text", text: (row) => row.region, render: (row) => row.region },
  {
    id: "storage",
    label: "Storage used",
    kind: "text",
    text: (row) => `${row.storage}%`,
    render: (row) => `${row.storage}%`,
  },
  {
    id: "health",
    label: "Health",
    kind: "choice",
    text: (row) => healthName(row.status),
    render: (row) => <HealthTip status={row.status} flags={[row.insight]} />,
  },
  {
    id: "provision",
    label: "Provision",
    kind: "choice",
    choices: [...PROVISION_CHOICES],
    text: demoDbProvision,
    render: (row) => (
      <ProvisionCell
        label={demoDbProvision(row)}
        detail={rdsProvisionDetail({
          available: true,
          cpu: row.cpu,
          storageUsedPct: row.storage,
          connectionPct: null,
        })}
      />
    ),
  },
];

const BUCKET_PROVISION_DETAIL =
  "No configured capacity limit was returned, so this bucket is not marked over- or under-provisioned.";

const bucketColumns: FilterColumn<LiveBucket>[] = [
  {
    id: "bucket",
    label: "Bucket",
    kind: "text",
    text: (row) => `${row.name} versioning ${row.versioning}`,
    render: (row) => (
      <>
        <Link href={`/resources/${row.name}`} className="font-medium text-gray-900 hover:underline">
          {row.name}
        </Link>
        <p className="text-xs text-gray-400">versioning {row.versioning}</p>
      </>
    ),
  },
  { id: "region", label: "Region", kind: "text", text: (row) => row.region, render: (row) => row.region },
  {
    id: "size",
    label: "Size / Objects",
    kind: "text",
    text: (row) => `${row.sizeGb} GB ${row.objects} objects${row.estimated ? " estimated" : ""}`,
    render: (row) => (
      <>
        {row.sizeGb} GB · {row.objects.toLocaleString()} objects{row.estimated ? " (20k+ counted)" : ""}
      </>
    ),
  },
  {
    id: "cleanup",
    label: "Cleanup rules",
    kind: "choice",
    text: (row) => (row.lifecycle ? "Rules on" : "No rules"),
    render: (row) =>
      row.lifecycle ? (
        <span className="pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Rules on</span>
      ) : (
        <span className="pill bg-amber-50 text-amber-800 ring-1 ring-amber-200">No rules</span>
      ),
  },
  {
    id: "health",
    label: "Health",
    kind: "choice",
    text: (row) => healthName(row.statusLevel),
    render: (row) => <HealthTip status={row.statusLevel} flags={row.flags} />,
  },
  {
    id: "provision",
    label: "Provision",
    kind: "choice",
    choices: [...PROVISION_CHOICES],
    text: () => unknownProvision(),
    render: () => <ProvisionCell label={unknownProvision()} detail={BUCKET_PROVISION_DETAIL} />,
  },
];

const demoBucketColumns: FilterColumn<AwsResource>[] = [
  {
    id: "bucket",
    label: "Bucket",
    kind: "text",
    text: (row) => `${row.name} ${row.id} ${row.insight}`,
    render: (row) => (
      <>
        <Link href={`/resources/${row.id}`} className="font-medium text-gray-900 hover:underline">
          {row.name}
        </Link>
        <p className="text-xs text-gray-400">{row.insight}</p>
      </>
    ),
  },
  { id: "region", label: "Region", kind: "text", text: (row) => row.region, render: (row) => row.region },
  {
    id: "health",
    label: "Health",
    kind: "choice",
    text: (row) => healthName(row.status),
    render: (row) => <HealthTip status={row.status} flags={[row.insight]} />,
  },
  {
    id: "provision",
    label: "Provision",
    kind: "choice",
    choices: [...PROVISION_CHOICES],
    text: () => unknownProvision(),
    render: () => <ProvisionCell label={unknownProvision()} detail={BUCKET_PROVISION_DETAIL} />,
  },
];

const fileSystemColumns: FilterColumn<LiveEFS>[] = [
  {
    id: "name",
    label: "File system",
    kind: "text",
    text: (row) => `${row.name} ${row.id}`,
    render: (row) => (
      <>
        <span className="block font-medium text-gray-900">{row.name}</span>
        <span className="block font-mono text-xs text-gray-400">{row.id}</span>
      </>
    ),
  },
  { id: "region", label: "Region", kind: "text", text: (row) => row.region, render: (row) => row.region },
  { id: "size", label: "Size", kind: "text", text: (row) => `${row.sizeGb} GB`, render: (row) => `${row.sizeGb} GB` },
];

function diskColumns(instances: { id: string; name: string }[]): FilterColumn<LiveVolume>[] {
  const attached = (row: LiveVolume) => {
    if (!row.attachedTo) return "Not attached";
    return instances.find((instance) => instance.id === row.attachedTo)?.name || row.attachedTo;
  };
  return [
    {
      id: "disk",
      label: "Disk",
      kind: "text",
      text: (row) => `${row.id} ${row.type}`,
      render: (row) => (
        <>
          <span className="font-mono text-xs text-gray-900">{row.id}</span>
          <p className="font-sans text-xs text-gray-400">{row.type}</p>
        </>
      ),
    },
    { id: "size", label: "Size", kind: "text", text: (row) => `${row.sizeGb} GB`, render: (row) => `${row.sizeGb} GB` },
    { id: "region", label: "Region", kind: "text", text: (row) => row.region, render: (row) => row.region },
    {
      id: "attached",
      label: "Attached to",
      kind: "text",
      text: attached,
      render: (row) =>
        row.attachedTo ? attached(row) : <span className="font-medium text-amber-700">Not attached</span>,
    },
    { id: "age", label: "Age", kind: "text", text: (row) => `${row.ageDays}d`, render: (row) => `${row.ageDays}d` },
  ];
}

const snapshotItemColumns: FilterColumn<LiveSnapshot>[] = [
  { id: "id", label: "Snapshot", kind: "text", text: (row) => row.id, render: (row) => <span className="font-mono text-xs">{row.id}</span> },
  { id: "size", label: "Size", kind: "text", text: (row) => `${row.sizeGb} GB`, render: (row) => `${row.sizeGb} GB` },
  { id: "age", label: "Age", kind: "text", text: (row) => `${row.ageDays}d`, render: (row) => `${row.ageDays}d old` },
];

function snapshotColumns(
  openSnap: string | null,
  setOpenSnap: (value: string | null) => void
): FilterColumn<SnapGroup>[] {
  return [
    {
      id: "source",
      label: "Source",
      kind: "text",
      text: (row) => row.source,
      render: (row) => {
        const open = openSnap === row.key;
        return (
          <button
            type="button"
            onClick={() => setOpenSnap(open ? null : row.key)}
            aria-expanded={open}
            className="text-left font-medium text-gray-900 hover:underline"
          >
            {row.source || "Unknown source"}
          </button>
        );
      },
    },
    {
      id: "kind",
      label: "Kind",
      kind: "choice",
      text: (row) => (row.store === "ebs" ? "Disk backup" : "Database backup"),
      render: (row) => (row.store === "ebs" ? "Disk backup" : "Database backup"),
    },
    { id: "region", label: "Region", kind: "text", text: (row) => row.region, render: (row) => row.region },
    { id: "oldest", label: "Oldest", kind: "text", text: (row) => `${row.oldest}d`, render: (row) => `${row.oldest}d` },
    {
      id: "count",
      label: "Count",
      kind: "text",
      text: (row) => String(row.count),
      render: (row) => <span className="font-semibold text-gray-900">{row.count}</span>,
    },
  ];
}

export default function ResourcesPage() {
  const { account, revision } = useAccount();
  const [tab, setTab] = useState<Tab | null>(null);
  const [openSnap, setOpenSnap] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inv, setInv] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  const openTab = (next: Tab) => setTab((current) => (current === next ? null : next));

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setLoading(true);
    setLiveError(null);
    try {
      const res = await fetch(refresh ? "/api/resources?refresh=1" : "/api/resources");
      const json = await res.json();
      if (res.ok && json.live) setInv(json as Inventory);
      else if (json.error === "not_scanned" || json.error === "sync_disabled") setInv(null);
      else
        setLiveError(
          json.detail ||
            (json.error === "credentials_expired_or_denied"
              ? "AWS rejected the keys in the user menu. Showing demo data."
              : "Couldn't read the live inventory. Showing demo data.")
        );
    } catch {
      setLiveError("Couldn't read the live inventory. Showing demo data.");
    } finally {
      if (refresh) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (!q) return;
    setQuery(q);
    const hit = mockResources.find((item) => `${item.name} ${item.id}`.toLowerCase().includes(q.toLowerCase()));
    if (!hit) return;
    setTab(hit.status !== "healthy" ? "attention" : hit.kind === "ec2" ? "servers" : hit.kind === "rds" ? "databases" : "storage");
  }, []);

  useEffect(() => {
    if (!account.configured) {
      setInv(null);
      setLoading(false);
      setLiveError(null);
      return;
    }
    load(false);
  }, [account.configured, revision, load]);

  const q = query.toLowerCase();
  const match = (s: string) => s.toLowerCase().includes(q);

  const serversLive = scopeScanned(inv, "ec2");
  const databasesLive = scopeScanned(inv, "rds");
  const bucketsLive = scopeScanned(inv, "s3");
  const extrasLive = detailScanned(inv);

  const servers = useMemo(() => {
    const base = serversLive && inv
      ? inv.instances.filter((r) =>
          match(`${r.name} ${r.id} ${r.type} ${r.region} ${r.state}`)
        )
      : mockResources
          .filter((r) => r.kind === "ec2")
          .map((r) => ({
            kind: "ec2" as const,
            id: r.id,
            name: r.name,
            state: "running",
            type: "demo",
            region: r.region,
            az: r.region,
            launchDays: 0,
            cpuAvg7d: r.cpu,
            diskGb: 0,
            status: r.status,
            flags: [r.insight],
          }))
          .filter((r) => match(`${r.name} ${r.id} ${r.region}`));
    return base;
  }, [inv, query, serversLive]);

  const databases = useMemo(() => {
    if (!databasesLive || !inv) return [];
    return inv.databases.filter((d) => match(`${d.id} ${d.engine} ${d.class} ${d.region}`));
  }, [inv, query, databasesLive]);

  const buckets = useMemo(() => {
    if (!bucketsLive || !inv) return [];
    return inv.buckets.filter((b) => match(`${b.name} ${b.region}`));
  }, [inv, query, bucketsLive]);

  const disks = useMemo(() => {
    if (!extrasLive || !inv) return [];
    return inv.volumes
      .filter((volume) => match(`${volume.id} ${volume.region} ${volume.attachedTo ?? ""} ${volume.type}`))
      .slice()
      .sort((a, b) => Number(Boolean(a.attachedTo)) - Number(Boolean(b.attachedTo)) || b.sizeGb - a.sizeGb);
  }, [extrasLive, inv, query]);

  const snapshotGroups = useMemo(() => {
    const groups = new Map<string, Inventory["snapshots"]>();
    if (!extrasLive) return [];
    for (const snap of inv?.snapshots ?? []) {
      if (!match(`${snap.id} ${snap.source} ${snap.region}`)) continue;
      const key = `${snap.store}/${snap.region}/${snap.source || snap.id}`;
      const list = groups.get(key);
      if (list) list.push(snap);
      else groups.set(key, [snap]);
    }
    const rows: { key: string; source: string; store: "ebs" | "rds"; region: string; count: number; oldest: number; items: Inventory["snapshots"] }[] = [];
    groups.forEach((items, key) => {
      let oldest = 0;
      items.forEach((item) => {
        if (item.ageDays > oldest) oldest = item.ageDays;
      });
      rows.push({
        key,
        source: items[0].source || "Unknown source",
        store: items[0].store,
        region: items[0].region,
        count: items.length,
        oldest,
        items: items.slice().sort((a, b) => b.ageDays - a.ageDays),
      });
    });
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }, [extrasLive, inv, query]);

  const fileSystems = useMemo(() => {
    if (!extrasLive || !inv) return [];
    return inv.efs.filter((file) => match(`${file.name} ${file.id} ${file.region}`));
  }, [inv, query, extrasLive]);

  const demoFlagged = mockResources.filter((item) => item.status !== "healthy" && match(`${item.name} ${item.id} ${item.insight}`));
  const demoDatabases = mockResources.filter((item) => item.kind === "rds" && match(`${item.name} ${item.id}`));
  const demoBuckets = mockResources.filter((item) => item.kind === "s3" && match(`${item.name} ${item.id}`));
  const pendingDemo = demoFlagged.filter((item) =>
    item.kind === "ec2" ? !serversLive : item.kind === "rds" ? !databasesLive : !bucketsLive
  );
  const liveFlagged = (inv?.waste ?? []).filter((item) => item.severity !== "healthy");

  const wasteCount = inv
    ? liveFlagged.length + pendingDemo.length
    : mockResources.filter((r) => r.status !== "healthy").length;
  const serverTotal = serversLive && inv ? inv.instances.length : mockResources.filter((r) => r.kind === "ec2").length;
  const serverOk = serversLive && inv
    ? inv.instances.filter((i) => i.state === "running").length
    : mockResources.filter((r) => r.kind === "ec2" && r.status === "healthy").length;
  const dbTotal = databasesLive && inv ? inv.databases.length : mockResources.filter((r) => r.kind === "rds").length;
  const dbOk = databasesLive && inv
    ? inv.databases.filter((d) => d.status === "available").length
    : mockResources.filter((r) => r.kind === "rds" && r.status === "healthy").length;
  const bucketTotal = bucketsLive && inv ? inv.buckets.length : mockResources.filter((r) => r.kind === "s3").length;
  const serverCaption =
    serversLive && inv
      ? extrasLive
        ? `${serverOk} running · ${inv.lbs.length} load balancers`
        : `${serverOk} running`
      : `${serverOk} running normally`;
  const bucketCaption =
    bucketsLive && inv
      ? inv.buckets.filter((bucket) => !bucket.lifecycle).length
        ? `${inv.buckets.filter((bucket) => !bucket.lifecycle).length} without cleanup rules`
        : "Cleanup rules are on"
      : "File storage in this sample";

  return (
    <div>
      <PageHeader
        title="Resources"
        subtitle="Every server, database, bucket and hanger-on across all regions — with waste flagged in plain words. Read-only: nothing here can change your AWS."
        action={
          <span className="flex items-center gap-2">
            {account.configured && (
              <button
                type="button"
                onClick={() => load(true)}
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

      {loading && (
        <div className="card p-4 text-sm text-gray-500">
          Scanning all regions for servers, databases, buckets and leftovers… (up to ~2 min first time)
        </div>
      )}
      {!loading && liveError && (
        <div className="mb-3">
          <InsightBanner tone="warn" title="Live data unavailable" body={liveError} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Servers" value={`${serverTotal}`} caption={serverCaption} tone="slate" icon={Server} active={tab === "servers"} onClick={() => openTab("servers")} />
        <StatCard label="Databases" value={`${dbTotal}`} caption={`${dbOk} ${databasesLive && inv ? "available" : "need no decision"}`} tone="amber" icon={Database} active={tab === "databases"} onClick={() => openTab("databases")} />
        <StatCard label="Buckets" value={`${bucketTotal}`} caption={bucketCaption} tone="yellow" icon={HardDrive} active={tab === "storage"} onClick={() => openTab("storage")} />
        <StatCard label="Needs attention" value={`${wasteCount}`} caption={wasteCount ? "Open this card for the reason" : "Nothing flagged"} tone="red" icon={TriangleAlert} active={tab === "attention"} onClick={() => openTab("attention")} />
      </div>

      {tab === "servers" && (
        <div className="card mt-3 overflow-hidden">
          <FilterTable
            rows={servers}
            rowKey={(row) => row.id}
            minWidth={980}
            empty={loading ? "Scanning…" : "No servers match."}
            columns={serverColumns}
          />
        </div>
      )}

      {tab === "databases" && (
        <div className="card mt-3 overflow-hidden">
          {!(databasesLive && inv) ? (
            <FilterTable
              rows={demoDatabases}
              rowKey={(row) => row.id}
              minWidth={860}
              empty="No databases match."
              columns={demoDatabaseColumns}
            />
          ) : (
            <FilterTable
              rows={databases}
              rowKey={(row) => `${row.region}/${row.id}`}
              minWidth={1040}
              empty="No databases match."
              columns={databaseColumns}
            />
          )}
        </div>
      )}

      {tab === "storage" && (
        <div className="mt-3 space-y-3">
          {!(bucketsLive && inv) ? (
            <div className="card overflow-hidden">
              <FilterTable
                rows={demoBuckets}
                rowKey={(row) => row.id}
                minWidth={860}
                empty="No buckets match."
                columns={demoBucketColumns}
              />
            </div>
          ) : (
            <>
              <section className="card overflow-hidden">
                <div className="border-b border-gray-100 px-4 py-3">
                  <p className="text-sm font-semibold">Buckets ({buckets.length})</p>
                  <p className="text-xs text-gray-500">S3 file buckets only. The count matches this list.</p>
                </div>
                <FilterTable
                  rows={buckets}
                  rowKey={(row) => row.name}
                  minWidth={980}
                  empty="No buckets match."
                  columns={bucketColumns}
                />
              </section>

              {extrasLive ? (
              <>
              {fileSystems.length > 0 && (
                <Fold
                  title={`File systems (${fileSystems.length})`}
                  detail="Shared drives. These are not buckets, so they are not included in the count above."
                >
                  <div className="border-t border-gray-100">
                    <FilterTable
                      rows={fileSystems}
                      rowKey={(row) => row.id}
                      minWidth={640}
                      empty="No file systems match."
                      columns={fileSystemColumns}
                    />
                  </div>
                </Fold>
              )}

              <Fold title={`Disks (${disks.length})`} detail="Server disks. A disk belongs to a server, not to a bucket. Unattached disks are listed first.">
                <div className="border-t border-gray-100">
                  <FilterTable
                    rows={disks}
                    rowKey={(row) => `${row.region}/${row.id}`}
                    minWidth={760}
                    empty="No disks match."
                    columns={diskColumns(inv.instances)}
                  />
                </div>
              </Fold>

              <Fold
                title={`Snapshots (${snapshotGroups.reduce((total, group) => total + group.count, 0)})`}
                detail={`${snapshotGroups.filter((group) => group.store === "ebs").reduce((total, group) => total + group.count, 0)} disk backups · ${snapshotGroups.filter((group) => group.store === "rds").reduce((total, group) => total + group.count, 0)} database backups. Open this section, then a row, to see each snapshot.`}
              >
                <div className="border-t border-gray-100">
                  <FilterTable
                    rows={snapshotGroups}
                    rowKey={(row) => row.key}
                    minWidth={760}
                    empty="No snapshots match."
                    columns={snapshotColumns(openSnap, setOpenSnap)}
                    detail={(group) =>
                      openSnap === group.key ? (
                        <FilterTable
                          rows={group.items}
                          rowKey={(snap) => `${snap.region}/${snap.id}`}
                          minWidth={480}
                          empty="No snapshots in this group."
                          columns={snapshotItemColumns}
                        />
                      ) : null
                    }
                  />
                </div>
              </Fold>
              </>
              ) : (
                <p className="card px-4 py-3 text-sm text-gray-500">
                  Disks, snapshots, and file systems have not been scanned.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {tab === "attention" && (
        <div className="card mt-3 overflow-hidden">
          {inv ? (
            <ul className="divide-y divide-gray-100">
              {liveFlagged.map((item, index) => (
                <li key={`${item.title}-${index}`} className="px-4 py-3">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-gray-500">{item.detail}</p>
                </li>
              ))}
              {pendingDemo.map((item) => (
                <li key={item.id}>
                  <Link href={`/resources/${item.id}`} className="block px-4 py-3 hover:bg-gray-50">
                    <span className="block text-sm font-medium">{item.name}</span>
                    <span className="block text-xs text-gray-500">{item.insight}</span>
                  </Link>
                </li>
              ))}
              {liveFlagged.length + pendingDemo.length === 0 && (
                <li className="muted p-8 text-center text-sm">Nothing is flagged.</li>
              )}
            </ul>
          ) : (
            <ul className="divide-y divide-gray-100">
              {demoFlagged.map((item) => (
                <li key={item.id}>
                  <Link href={`/resources/${item.id}`} className="block px-4 py-3 hover:bg-gray-50">
                    <span className="block text-sm font-medium">{item.name}</span>
                    <span className="block text-xs text-gray-500">{item.insight}</span>
                  </Link>
                </li>
              ))}
              {demoFlagged.length === 0 && <li className="muted p-8 text-center text-sm">Nothing is flagged.</li>}
            </ul>
          )}
        </div>
      )}

      <p className="muted mt-3 text-xs leading-relaxed">
        Read-only inventory: {inv ? `swept ${inv.scannedRegions} regions, deep-scanned ${inv.deepRegions} with activity · home: ${inv.homeRegions.join(", ")}` : "demo mode"}. Memory (RAM) per
        server needs a monitoring agent and isn&apos;t reported.
      </p>
    </div>
  );
}
