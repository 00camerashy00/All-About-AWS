"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Database, HardDrive, RefreshCw, Server, TriangleAlert } from "lucide-react";
import type { Inventory } from "@/lib/aws-resources";
import { resources as mockResources } from "@/lib/mock-data";
import { useAccount } from "@/components/account-provider";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { InsightBanner } from "@/components/insight-banner";
import { HealthTip } from "@/components/health-tip";

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

  const servers = useMemo(() => {
    const base = inv
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
  }, [inv, query]);

  const databases = useMemo(() => {
    if (!inv) return [];
    return inv.databases.filter((d) => match(`${d.id} ${d.engine} ${d.class} ${d.region}`));
  }, [inv, query]);

  const buckets = useMemo(() => {
    if (!inv) return [];
    return inv.buckets.filter((b) => match(`${b.name} ${b.region}`));
  }, [inv, query]);

  const disks = useMemo(() => {
    if (!inv) return [];
    return inv.volumes
      .filter((volume) => match(`${volume.id} ${volume.region} ${volume.attachedTo ?? ""} ${volume.type}`))
      .slice()
      .sort((a, b) => Number(Boolean(a.attachedTo)) - Number(Boolean(b.attachedTo)) || b.sizeGb - a.sizeGb);
  }, [inv, query]);

  const snapshotGroups = useMemo(() => {
    const groups = new Map<string, Inventory["snapshots"]>();
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
  }, [inv, query]);

  const demoFlagged = mockResources.filter((item) => item.status !== "healthy" && match(`${item.name} ${item.id} ${item.insight}`));
  const demoDatabases = mockResources.filter((item) => item.kind === "rds" && match(`${item.name} ${item.id}`));
  const demoBuckets = mockResources.filter((item) => item.kind === "s3" && match(`${item.name} ${item.id}`));

  const wasteCount = inv?.waste.length ?? mockResources.filter((r) => r.status !== "healthy").length;
  const serverTotal = inv ? inv.instances.length : mockResources.filter((r) => r.kind === "ec2").length;
  const serverOk = inv
    ? inv.instances.filter((i) => i.state === "running").length
    : mockResources.filter((r) => r.kind === "ec2" && r.status === "healthy").length;
  const dbTotal = inv ? inv.databases.length : mockResources.filter((r) => r.kind === "rds").length;
  const dbOk = inv
    ? inv.databases.filter((d) => d.status === "available").length
    : mockResources.filter((r) => r.kind === "rds" && r.status === "healthy").length;
  const bucketTotal = inv ? inv.buckets.length : mockResources.filter((r) => r.kind === "s3").length;
  const catalog = Math.max(1, serverTotal + dbTotal + bucketTotal);

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
            {inv ? (
              <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                Live AWS data
              </span>
            ) : (
              <span className="rounded-full bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-500 ring-1 ring-gray-200">
                Demo data
              </span>
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
        <StatCard label="Servers" value={`${serverTotal}`} caption={inv ? `${serverOk} running · ${inv.lbs.length} load balancers` : `${serverOk} running normally`} pct={serverTotal ? (serverOk / serverTotal) * 100 : 0} tone="slate" icon={Server} active={tab === "servers"} onClick={() => openTab("servers")} />
        <StatCard label="Databases" value={`${dbTotal}`} caption={`${dbOk} ${inv ? "available" : "need no decision"}`} pct={dbTotal ? (dbOk / dbTotal) * 100 : 0} tone="amber" icon={Database} active={tab === "databases"} onClick={() => openTab("databases")} />
        <StatCard label="Buckets" value={`${bucketTotal}`} caption={inv ? (inv.buckets.filter((bucket) => !bucket.lifecycle).length ? `${inv.buckets.filter((bucket) => !bucket.lifecycle).length} without cleanup rules` : "Cleanup rules are on") : "File storage in this sample"} pct={bucketTotal ? 100 : 0} tone="yellow" icon={HardDrive} active={tab === "storage"} onClick={() => openTab("storage")} />
        <StatCard label="Needs attention" value={`${wasteCount}`} caption={wasteCount ? "Open this card for the reason" : "Nothing flagged"} pct={(wasteCount / catalog) * 100} tone="red" icon={TriangleAlert} active={tab === "attention"} onClick={() => openTab("attention")} />
      </div>

      {tab === "servers" && (
        <div className="card mt-3 overflow-hidden lg:overflow-visible">
          <div className="overflow-x-auto lg:overflow-visible">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-4 py-3 font-medium">Server</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Region</th>
                  <th className="px-4 py-3 font-medium">State · CPU (7d)</th>
                  <th className="px-4 py-3 font-medium">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {servers.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/70">
                    <td className="px-4 py-3">
                      <Link href={`/resources/${r.id}`} className="font-medium hover:underline">
                        {r.name || r.id}
                      </Link>
                      <p className="font-mono text-xs text-gray-400">{r.id}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.type}</td>
                    <td className="px-4 py-3 text-gray-600">{r.region}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {r.state}{r.cpuAvg7d !== null ? ` · ${r.cpuAvg7d}%` : ""}
                    </td>
                    <td className="px-4 py-3"><HealthTip status={r.status} flags={r.flags} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {servers.length === 0 && !loading && (
            <p className="muted p-8 text-center text-sm">No servers match.</p>
          )}
        </div>
      )}

      {tab === "databases" && (
        <div className="card mt-3 overflow-hidden lg:overflow-visible">
          {!inv ? (
            <ul className="divide-y divide-gray-100">
              {demoDatabases.map((item) => (
                <li key={item.id}>
                  <Link href={`/resources/${item.id}`} className="block px-4 py-3 hover:bg-gray-50">
                    <span className="block text-sm font-medium">{item.name}</span>
                    <span className="block text-xs text-gray-500">{item.insight}</span>
                  </Link>
                </li>
              ))}
              {demoDatabases.length === 0 && <li className="muted p-8 text-center text-sm">No databases match.</li>}
            </ul>
          ) : (
            <div className="overflow-x-auto lg:overflow-visible">
              <table className="w-full min-w-[840px] text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                    <th className="px-4 py-3 font-medium">Database</th>
                    <th className="px-4 py-3 font-medium">Engine / Size</th>
                    <th className="px-4 py-3 font-medium">Region</th>
                    <th className="px-4 py-3 font-medium">Storage used</th>
                    <th className="px-4 py-3 font-medium">Backups</th>
                    <th className="px-4 py-3 font-medium">Health</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {databases.map((d) => (
                    <tr key={`${d.region}/${d.id}`} className="hover:bg-gray-50/70">
                      <td className="px-4 py-3">
                        <Link href={`/resources/${d.id}`} className="font-medium hover:underline">{d.id}</Link>
                        <p className="text-xs text-gray-400">{d.status}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{d.engine}<p className="text-xs text-gray-400">{d.class}{d.multiAz ? " · Multi-AZ" : ""}</p></td>
                      <td className="px-4 py-3 text-gray-600">{d.region}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {d.storageUsedPct !== null ? `${d.storageUsedPct}% of ${d.storageGb} GB` : d.storageGb !== null ? `${d.storageGb} GB allocated` : "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {d.backupRetentionDays !== null ? `${d.backupRetentionDays}d retention` : "—"}
                        {d.manualSnapshots > 0 && <p className="text-xs text-gray-400">{d.manualSnapshots} manual snapshots</p>}
                      </td>
                      <td className="px-4 py-3"><HealthTip status={d.statusLevel} flags={d.flags} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {inv && databases.length === 0 && (
            <p className="muted p-8 text-center text-sm">No databases match.</p>
          )}
        </div>
      )}

      {tab === "storage" && (
        <div className="mt-3 space-y-3">
          {!inv ? (
            <div className="card overflow-hidden">
              <ul className="divide-y divide-gray-100">
                {demoBuckets.map((item) => (
                  <li key={item.id}>
                    <Link href={`/resources/${item.id}`} className="block px-4 py-3 hover:bg-gray-50">
                      <span className="block text-sm font-medium">{item.name}</span>
                      <span className="block text-xs text-gray-500">{item.insight}</span>
                    </Link>
                  </li>
                ))}
                {demoBuckets.length === 0 && <li className="muted p-8 text-center text-sm">No buckets match.</li>}
              </ul>
            </div>
          ) : (
            <>
              <section className="card overflow-hidden lg:overflow-visible">
                <div className="border-b border-gray-100 px-4 py-3">
                  <p className="text-sm font-semibold">Buckets ({buckets.length})</p>
                  <p className="text-xs text-gray-500">S3 file buckets only. The count matches this list.</p>
                </div>
                <div className="overflow-x-auto lg:overflow-visible">
                  <table className="w-full min-w-[800px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                        <th className="px-4 py-3 font-medium">Bucket</th>
                        <th className="px-4 py-3 font-medium">Region</th>
                        <th className="px-4 py-3 font-medium">Size / Objects</th>
                        <th className="px-4 py-3 font-medium">Cleanup rules</th>
                        <th className="px-4 py-3 font-medium">Health</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {buckets.map((b) => (
                        <tr key={b.name} className="hover:bg-gray-50/70">
                          <td className="px-4 py-3">
                            <Link href={`/resources/${b.name}`} className="font-medium hover:underline">{b.name}</Link>
                            <p className="text-xs text-gray-400">versioning {b.versioning}</p>
                          </td>
                          <td className="px-4 py-3 text-gray-600">{b.region}</td>
                          <td className="px-4 py-3 text-gray-600">
                            {b.sizeGb} GB · {b.objects.toLocaleString()} objects{b.estimated ? " (20k+ counted)" : ""}
                          </td>
                          <td className="px-4 py-3">
                            {b.lifecycle ? (
                              <span className="pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Rules on</span>
                            ) : (
                              <span className="pill bg-amber-50 text-amber-800 ring-1 ring-amber-200">No rules</span>
                            )}
                          </td>
                          <td className="px-4 py-3"><HealthTip status={b.statusLevel} flags={b.flags} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {buckets.length === 0 && <p className="muted p-8 text-center text-sm">No buckets match.</p>}
              </section>

              {inv.efs.filter((file) => match(`${file.name} ${file.region}`)).length > 0 && (
                <Fold
                  title={`File systems (${inv.efs.filter((file) => match(`${file.name} ${file.region}`)).length})`}
                  detail="Shared drives. These are not buckets, so they are not included in the count above."
                >
                  <ul className="divide-y divide-gray-100 border-t border-gray-100">
                    {inv.efs.filter((file) => match(`${file.name} ${file.region}`)).map((file) => (
                      <li key={file.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                        <span>
                          <span className="block font-medium">{file.name}</span>
                          <span className="block text-xs text-gray-500">{file.region}</span>
                        </span>
                        <span className="text-gray-600">{file.sizeGb} GB</span>
                      </li>
                    ))}
                  </ul>
                </Fold>
              )}

              <Fold title={`Disks (${disks.length})`} detail="Server disks. A disk belongs to a server, not to a bucket. Unattached disks are listed first.">
                <div className="overflow-x-auto border-t border-gray-100">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                        <th className="px-4 py-3 font-medium">Disk</th>
                        <th className="px-4 py-3 font-medium">Size</th>
                        <th className="px-4 py-3 font-medium">Region</th>
                        <th className="px-4 py-3 font-medium">Attached to</th>
                        <th className="px-4 py-3 font-medium">Age</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {disks.map((volume) => {
                        const server = volume.attachedTo ? inv.instances.find((instance) => instance.id === volume.attachedTo) : null;
                        return (
                          <tr key={`${volume.region}/${volume.id}`}>
                            <td className="px-4 py-3 font-mono text-xs">{volume.id}<p className="font-sans text-xs text-gray-400">{volume.type}</p></td>
                            <td className="px-4 py-3">{volume.sizeGb} GB</td>
                            <td className="px-4 py-3 text-gray-600">{volume.region}</td>
                            <td className="px-4 py-3 text-gray-600">
                              {volume.attachedTo ? (server?.name || volume.attachedTo) : <span className="font-medium text-amber-700">Not attached</span>}
                            </td>
                            <td className="px-4 py-3 text-gray-600">{volume.ageDays}d</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {disks.length === 0 && <p className="muted p-8 text-center text-sm">No disks match.</p>}
              </Fold>

              <Fold
                title={`Snapshots (${snapshotGroups.reduce((total, group) => total + group.count, 0)})`}
                detail={`${snapshotGroups.filter((group) => group.store === "ebs").reduce((total, group) => total + group.count, 0)} disk backups · ${snapshotGroups.filter((group) => group.store === "rds").reduce((total, group) => total + group.count, 0)} database backups. Open this section, then a row, to see each snapshot.`}
              >
                <ul className="divide-y divide-gray-100 border-t border-gray-100">
                  {snapshotGroups.map((group) => {
                    const open = openSnap === group.key;
                    return (
                      <li key={group.key}>
                        <button
                          type="button"
                          onClick={() => setOpenSnap(open ? null : group.key)}
                          aria-expanded={open}
                          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
                        >
                          <span>
                            <span className="block text-sm font-medium">{group.source || "Unknown source"}</span>
                            <span className="block text-xs text-gray-500">
                              {group.store === "ebs" ? "Disk backup" : "Database backup"} · {group.region} · oldest {group.oldest}d
                            </span>
                          </span>
                          <span className="shrink-0 text-sm font-semibold text-gray-700">{group.count}</span>
                        </button>
                        {open && (
                          <ul className="border-t border-gray-100 bg-gray-50/70">
                            {group.items.map((snap) => (
                              <li key={`${snap.region}/${snap.id}`} className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-gray-600">
                                <span className="font-mono">{snap.id}</span>
                                <span>{snap.sizeGb} GB · {snap.ageDays}d old</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {snapshotGroups.length === 0 && <p className="muted p-8 text-center text-sm">No snapshots match.</p>}
              </Fold>
            </>
          )}
        </div>
      )}

      {tab === "attention" && (
        <div className="card mt-3 overflow-hidden">
          {inv ? (
            <ul className="divide-y divide-gray-100">
              {inv.waste.filter((item) => item.severity !== "healthy").map((item, index) => (
                <li key={`${item.title}-${index}`} className="px-4 py-3">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-gray-500">{item.detail}</p>
                </li>
              ))}
              {inv.waste.filter((item) => item.severity !== "healthy").length === 0 && (
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
