"use client";

import { useState } from "react";
import type { IamUserRow } from "@/lib/users-types";

type Tab = "permissions" | "groups" | "tags" | "credentials" | "accessed";

function formatWhen(at: string | null): string {
  if (!at) return "—";
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function IamUserDetail({ user, onClose }: { user: IamUserRow; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("permissions");
  const accessed = user.lastAccessed.filter((item) => item.lastAccessed);
  const quiet = user.lastAccessed.length - accessed.length;
  const tabs: { id: Tab; label: string }[] = [
    { id: "permissions", label: "Permissions" },
    { id: "groups", label: `Groups (${user.groups.length})` },
    { id: "tags", label: `Tags (${user.tags.length})` },
    { id: "credentials", label: "Security credentials" },
    { id: "accessed", label: "Last accessed" },
  ];

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-gray-900/30">
      <button className="absolute inset-0" aria-label="Close details" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-5xl flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">IAM user</p>
            <h2 className="mt-1 text-lg font-semibold">{user.userName}</h2>
            <p className="mt-1 break-all text-xs text-gray-500">{user.arn}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-gray-500 hover:bg-gray-100">
            Close
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-gray-100 px-3">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium ${
                tab === item.id ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {tab === "permissions" && <Permissions user={user} />}
          {tab === "groups" && <Groups user={user} />}
          {tab === "tags" && <Tags user={user} />}
          {tab === "credentials" && <Credentials user={user} />}
          {tab === "accessed" && <LastAccessed user={user} accessed={accessed.length} quiet={quiet} />}
        </div>
      </aside>
    </div>
  );
}

function Permissions({ user }: { user: IamUserRow }) {
  return (
    <div>
      <p className="text-sm text-gray-700">
        Permissions boundary: {user.permissionsBoundary ?? "None"}
      </p>
      <h3 className="mt-4 text-sm font-semibold">Permissions policies</h3>
      <DataTable
        headers={["Policy name", "Type", "Attached via"]}
        empty="No permissions policies are attached."
        rows={user.policies.map((policy) => [policy.name, policy.type, policy.attachedVia === "Directly" ? "Directly" : policy.attachedVia])}
      />
    </div>
  );
}

function Groups({ user }: { user: IamUserRow }) {
  return (
    <DataTable
      headers={["Group name", "Attached policies"]}
      empty="This user is not in any group."
      rows={user.groups.map((group) => [group.name, group.policies.length ? group.policies.join(", ") : "None"])}
    />
  );
}

function Tags({ user }: { user: IamUserRow }) {
  return (
    <DataTable
      headers={["Key", "Value"]}
      empty="No tags."
      rows={user.tags.map((tag) => [tag.key, tag.value || "—"])}
    />
  );
}

function Credentials({ user }: { user: IamUserRow }) {
  const password =
    user.passwordEnabled == null ? "Could not be read" : user.passwordEnabled ? "Enabled" : "Disabled";
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold">Console sign-in</h3>
        <DataTable
          headers={["Console password", "Password last used", "MFA"]}
          rows={[[
            password,
            formatWhen(user.passwordLastUsed),
            user.mfaDevices.length ? user.mfaDevices.join(", ") : "Not assigned",
          ]]}
        />
      </section>
      <section>
        <h3 className="text-sm font-semibold">Access keys</h3>
        <DataTable
          headers={["Access key ID", "Status", "Created", "Last used", "Service", "Region"]}
          empty="No access keys."
          rows={user.accessKeys.map((key) => [
            key.id,
            key.status,
            formatWhen(key.createdAt),
            formatWhen(key.lastUsedAt),
            key.lastUsedService ?? "—",
            key.lastUsedRegion ?? "—",
          ])}
        />
      </section>
    </div>
  );
}

function LastAccessed({ user, accessed, quiet }: { user: IamUserRow; accessed: number; quiet: number }) {
  const rows = user.lastAccessed
    .filter((item) => item.lastAccessed)
    .slice()
    .sort((a, b) => (b.lastAccessed ?? "").localeCompare(a.lastAccessed ?? ""));
  return (
    <div>
      {user.lastAccessedStatus === "unavailable" ? (
        <p className="text-sm text-gray-500">Service last accessed could not be read.</p>
      ) : (
        <>
          <DataTable
            headers={["Service", "Last accessed", "Region"]}
            empty="No service was accessed in the tracking period."
            rows={rows.map((item) => [item.service, formatWhen(item.lastAccessed), item.region ?? "—"])}
          />
          {quiet > 0 && (
            <p className="mt-3 text-xs text-gray-500">
              {quiet} other {quiet === 1 ? "service was" : "services were"} not accessed in the tracking period.
            </p>
          )}
          {accessed === 0 && quiet === 0 && user.lastAccessed.length === 0 && (
            <p className="mt-3 text-xs text-gray-500">AWS tracks this for about the last 400 days.</p>
          )}
        </>
      )}
    </div>
  );
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: string[][]; empty?: string }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
            {headers.map((header) => (
              <th key={header} className="px-3 py-2 font-medium">{header}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row, index) => (
            <tr key={`${row[0]}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 text-gray-800">{cell}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && empty && (
            <tr>
              <td colSpan={headers.length} className="px-3 py-6 text-center text-sm text-gray-500">{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
