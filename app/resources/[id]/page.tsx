"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { resources as mockResources } from "@/lib/mock-data";
import type { Inventory } from "@/lib/aws-resources";
import { StatusPill } from "@/components/status-pill";
import { InsightBanner } from "@/components/insight-banner";
import { useAccount } from "@/components/account-provider";

function Meter({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  if (value === null)
    return (
      <div className="card p-4">
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight text-gray-300">—</p>
        <p className="muted mt-2 text-xs">{hint}</p>
      </div>
    );
  const color = value >= 80 ? "bg-red-500" : value >= 60 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="card p-4">
      <p className="text-sm font-semibold">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}<span className="text-base font-normal text-gray-400">%</span></p>
      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <p className="muted mt-2 text-xs">{hint}</p>
    </div>
  );
}

export default function ResourceDetailPage({ params }: { params: { id: string } }) {
  const { account, revision } = useAccount();
  const [inv, setInv] = useState<Inventory | null>(null);
  useEffect(() => {
    if (!account.configured) {
      setInv(null);
      return;
    }
    let cancelled = false;
    fetch("/api/resources")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j.live) setInv(j as Inventory);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [account.configured, revision]);

  const id = decodeURIComponent(params.id);
  const inst = inv?.instances.find((i) => i.id === id || i.name === id);
  const db = inv?.databases.find((d) => d.id === id);
  const bucket = inv?.buckets.find((b) => b.name === id);
  const mock = mockResources.find((x) => x.id === id);

  if (inst) {
    return (
      <div>
        <Link href="/resources" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900">
          <ArrowLeft size={16} /> All resources
        </Link>
        <div className="card mt-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{inst.name || inst.id}</h1>
            <StatusPill status={inst.status} />
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">Live</span>
          </div>
          <p className="muted mt-1 text-sm">
            Virtual server ({inst.type}) · {inst.region} · {inst.state} · running {inst.launchDays} days · {inst.diskGb} GB disks
          </p>
        </div>
        {inst.flags.length > 0 && (
          <div className="mt-4">
            <InsightBanner tone={inst.status === "healthy" ? "good" : "warn"} title="What needs your decision" body={inst.flags.join(" ")} />
          </div>
        )}
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Meter label="CPU — processing power (7-day average)" value={inst.cpuAvg7d} hint={inst.cpuAvg7d === null ? "No data — server likely stopped." : inst.cpuAvg7d >= 80 ? "High — apps may slow down." : inst.cpuAvg7d <= 10 ? "Low CPU. The server is healthy." : "Comfortable range."} />
          <Meter label="RAM — working memory" value={null} hint="Not reported — needs a monitoring agent on the server." />
          <Meter label="Disks attached" value={null} hint={`${inst.diskGb} GB of disk attached. Per-disk fill % needs an agent.`} />
        </div>
        <p className="muted mt-3 text-xs">Read-only view. Start/stop needs write permission your SSO role doesn&apos;t have.</p>
      </div>
    );
  }

  if (db) {
    return (
      <div>
        <Link href="/resources" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900">
          <ArrowLeft size={16} /> All resources
        </Link>
        <div className="card mt-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{db.id}</h1>
            <StatusPill status={db.statusLevel} />
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">Live</span>
          </div>
          <p className="muted mt-1 text-sm">
            Database ({db.engine} · {db.class}) · {db.region} · {db.status}
            {db.multiAz ? " · Multi-AZ" : ""} · {db.manualSnapshots} manual snapshots
          </p>
        </div>
        {db.flags.length > 0 && (
          <div className="mt-4">
            <InsightBanner tone={db.statusLevel === "healthy" ? "good" : "warn"} title="What needs your decision" body={db.flags.join(" ")} />
          </div>
        )}
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Meter label="Storage used" value={db.storageUsedPct} hint={db.storageUsedPct === null ? "No metric yet — check again shortly." : db.storageUsedPct >= 85 ? "Almost full — act this week." : "Comfortable."} />
          <Meter label="Backup retention" value={null} hint={`${db.backupRetentionDays ?? "?"} days of automated backups kept. Over ~14 days usually bills extra.`} />
          <Meter label="Snapshots kept" value={null} hint={`${db.manualSnapshots} manual snapshots. Old ones are silent cost.`} />
        </div>
      </div>
    );
  }

  if (bucket) {
    return (
      <div>
        <Link href="/resources" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900">
          <ArrowLeft size={16} /> All resources
        </Link>
        <div className="card mt-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{bucket.name}</h1>
            <StatusPill status={bucket.statusLevel} />
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">Live</span>
          </div>
          <p className="muted mt-1 text-sm">
            File storage · {bucket.region} · {bucket.sizeGb} GB · {bucket.objects.toLocaleString()} objects{bucket.estimated ? " (20k+ counted)" : ""} · versioning {bucket.versioning}
          </p>
        </div>
        <div className="mt-4">
          <InsightBanner
            tone={bucket.lifecycle ? "good" : "warn"}
            title={bucket.lifecycle ? "Cleanup rules are on" : "No cleanup rules"}
            body={bucket.lifecycle ? "This bucket has lifecycle rules managing old files." : "Nothing ever expires or archives here — add a lifecycle rule for temp files and old versions."}
          />
        </div>
      </div>
    );
  }

  if (mock) {
    return (
      <div>
        <Link href="/resources" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900">
          <ArrowLeft size={16} /> All resources
        </Link>
        <div className="card mt-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{mock.name}</h1>
            <StatusPill status={mock.status} />
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500">Demo</span>
          </div>
          <p className="muted mt-1 text-sm">{mock.plainType} · {mock.region} · {mock.insight}</p>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Meter label="CPU" value={mock.cpu} hint="Demo figure." />
          <Meter label="RAM" value={mock.ram} hint="Demo figure." />
          <Meter label="Storage" value={mock.storage} hint="Demo figure." />
        </div>
      </div>
    );
  }

  return (
    <div>
      <Link href="/resources" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900">
        <ArrowLeft size={16} /> All resources
      </Link>
      <div className="card mt-3 p-8 text-center">
        <p className="font-semibold">Couldn&apos;t find “{id}” in the live inventory</p>
        <p className="muted mt-1 text-sm">It may be deleted, in an unscanned region, or the scan is still running.</p>
      </div>
    </div>
  );
}
