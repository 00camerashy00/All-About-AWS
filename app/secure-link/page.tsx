"use client";

import { FormEvent, useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { useAccount } from "@/components/account-provider";
import type { IngressLink } from "@/lib/ingress-link";

type Unit = "hours" | "days";

export default function SecureLinkPage() {
  const { account } = useAccount();
  const [customer, setCustomer] = useState("");
  const [amount, setAmount] = useState("24");
  const [unit, setUnit] = useState<Unit>("hours");
  const [ip, setIp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<IngressLink | null>(null);
  const [copied, setCopied] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setCopied(false);
    const count = Number(amount);
    if (!Number.isInteger(count) || count < 1) {
      setError("Enter how long the link should stay valid.");
      return;
    }
    const expiresIn = unit === "days" ? count * 86_400 : count * 3_600;
    setBusy(true);
    try {
      const response = await fetch("/api/ingress-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customer,
          expiresIn,
          ip: ip.trim() ? ip.trim() : null,
        }),
      });
      const json = (await response.json().catch(() => null)) as
        | (IngressLink & { detail?: string })
        | { detail?: string }
        | null;
      if (!response.ok || !json || !("command" in json)) {
        setLink(null);
        setError(json?.detail || "The link could not be generated.");
        return;
      }
      setLink(json);
    } catch {
      setLink(null);
      setError("The link could not be generated.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Secure Link Generator"
        subtitle="Create a one-folder upload command for a client. They run it, choose a file, and it lands in that day's ingress folder."
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <form onSubmit={onSubmit} className="card space-y-4 p-5">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">Client name</span>
            <input
              value={customer}
              onChange={(event) => setCustomer(event.target.value)}
              placeholder="uva"
              aria-label="Client name"
              autoComplete="off"
              className="mt-1.5 w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-gray-900"
            />
          </label>
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">Validity</span>
            <div className="mt-1.5 flex gap-2">
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
                aria-label="Link validity"
                className="w-28 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none ring-1 ring-gray-200 focus:ring-gray-900"
              />
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value as Unit)}
                aria-label="Validity unit"
                className="rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none ring-1 ring-gray-200 focus:ring-gray-900"
              >
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">Default is 24 hours. The longest link is 7 days.</p>
          </div>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">IP address</span>
            <input
              value={ip}
              onChange={(event) => setIp(event.target.value)}
              placeholder="Optional, for example 203.0.113.10"
              aria-label="IP address"
              autoComplete="off"
              className="mt-1.5 w-full rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-gray-900"
            />
            <p className="mt-1.5 text-xs text-gray-500">
              Optional. Recorded on the result so you know who the link was issued for. The upload address itself is not limited to that network.
            </p>
          </label>
          {error && <p className="text-sm text-rose-700">{error}</p>}
          {!account.configured && (
            <p className="text-sm text-gray-500">Add AWS keys before generating a link.</p>
          )}
          <button
            type="submit"
            disabled={busy || !account.configured}
            className="inline-flex items-center gap-2 rounded-full bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Link2 size={15} />
            {busy ? "Generating…" : "Generate link"}
          </button>
        </form>

        <section className="card p-5">
          {!link ? (
            <p className="text-sm text-gray-500">The client command appears here.</p>
          ) : (
            <div className="space-y-4">
              <dl className="space-y-2 text-sm">
                <Row label="Folder" value={link.folder} />
                <Row label="Upload URL" value={link.url} />
                <Row label="Expires" value={formatExpiry(link.expiresAt, link.expiresIn)} />
                {link.ip && <Row label="Issued for" value={link.ip} />}
              </dl>
              {link.sessionBound && (
                <p className="text-xs leading-relaxed text-gray-500">
                  This link also stops working when the AWS session in the environment expires, which can be sooner than the validity above.
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Client command</p>
                <button
                  type="button"
                  onClick={copy}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-xl bg-gray-50 p-3 text-xs leading-relaxed text-gray-800 ring-1 ring-gray-200">
                {link.command}
              </pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className="break-all font-medium text-gray-900">{value}</dd>
    </div>
  );
}

function formatExpiry(expiresAt: string, expiresIn: number): string {
  const hours = Math.round(expiresIn / 3600);
  const span = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"}`;
  const when = expiresAt.replace("T", " ").replace(/Z$/, " UTC");
  return `${span} · ${when}`;
}
