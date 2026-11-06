"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, ScrollText, Shield, Users } from "lucide-react";
import { IamUserDetail } from "@/components/iam-user-detail";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { useAccount } from "@/components/account-provider";
import { demoUsers } from "@/lib/users-demo";
import type { IamPolicyRow, IamRoleRow, IamUserRow, InstanceGrant, ServiceGrant, SsmUserRow, SsoAssignment, SsoUserRow, UsersPayload } from "@/lib/users-types";

const PAGE_SIZE = 4;

type SortKey = "user" | "login" | "access" | "scope";
type UserView = "ssm" | "sso" | "iam" | "roles" | "policies";
type DirectoryKind = "ssm" | "sso" | "iam" | "role" | "policy";
type DirectoryRow = SsmUserRow | SsoUserRow | IamUserRow | IamRoleRow | IamPolicyRow;

function formatWhen(at: string | null, status: "known" | "unavailable"): string {
  if (status === "unavailable") return "Unavailable";
  if (!at) return "Never";
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function loginValue(at: string | null, status: "known" | "unavailable"): number {
  if (status === "unavailable") return -1;
  if (!at) return 0;
  return new Date(at).getTime();
}

function instanceLabel(user: SsmUserRow): string {
  if (user.unrestricted || user.instances === "all") return "All instances";
  if (!user.instances.length) return "None";
  return user.instances.map((item) => item.name).join(", ");
}

function grantsOf(item: SsoAssignment): ServiceGrant[] | "all" {
  if (item.serviceGrants) return item.serviceGrants;
  if (item.services === "all") return "all";
  const write = item.accessLevel === "read-write";
  return item.services.map((name) => ({ name, read: item.accessLevel !== "none", write }));
}

function mergedGrants(user: SsoUserRow): ServiceGrant[] | "all" {
  const map = new Map<string, ServiceGrant>();
  for (const item of user.assignments) {
    const grants = grantsOf(item);
    if (grants === "all") return "all";
    for (const grant of grants) {
      const current = map.get(grant.name) ?? { name: grant.name, read: false, write: false };
      current.read = current.read || grant.read;
      current.write = current.write || grant.write;
      map.set(grant.name, current);
    }
  }
  const rows: ServiceGrant[] = [];
  map.forEach((value) => rows.push(value));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function grantSummary(user: SsoUserRow): string {
  const grants = mergedGrants(user);
  if (grants === "all") return "All services · read and write";
  if (!grants.length) return "No services";
  const write = grants.filter((item) => item.write).map((item) => item.name);
  if (!write.length) return `${grants.length} services · read-only`;
  if (write.length <= 2) return `Write on ${write.join(" and ")}`;
  return `Write on ${write.slice(0, 2).join(", ")} +${write.length - 2}`;
}

function uniqueActions(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export default function UsersPage() {
  const { account, revision } = useAccount();
  const [payload, setPayload] = useState<UsersPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<UserView | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("user");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshNow = useRef(false);

  useEffect(() => {
    if (!account.configured) {
      setPayload(demoUsers());
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const refresh = refreshNow.current;
    refreshNow.current = false;
    if (refresh) setLoading(true);
    setError(null);
    fetch(refresh ? "/api/users?refresh=1" : "/api/users")
      .then(async (response) => {
        const json = await response.json();
        if (cancelled) return;
        if (response.ok && json.live) {
          setPayload(json as UsersPayload);
          return;
        }
        setPayload(demoUsers());
        if (json.error !== "not_scanned" && json.error !== "sync_disabled") {
          setError("Live user scan failed. Showing the sample directory.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPayload(demoUsers());
          setError("Live user scan failed. Showing the sample directory.");
        }
      })
      .finally(() => {
        if (!cancelled && refresh) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account.configured, revision, refreshTick]);

  const data = payload ?? demoUsers();
  const kind: DirectoryKind =
    view === "sso" ? "sso" : view === "iam" ? "iam" : view === "roles" ? "role" : view === "policies" ? "policy" : "ssm";
  const rows = useMemo(() => {
    if (view === "ssm") return data.ssm;
    if (view === "sso") return data.sso;
    if (view === "iam") return data.iam ?? [];
    if (view === "roles") return data.roles ?? [];
    if (view === "policies") return data.policies ?? [];
    return [];
  }, [data, view]);

  const openView = (next: UserView) => {
    setView((current) => (current === next ? null : next));
    setPage(0);
    setSelectedId(null);
  };

  const filtered = useMemo(() => {
    const list = rows.slice();
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const value = (row: DirectoryRow) => {
        if (sortKey === "login") {
          if (row.population === "role") return loginValue(row.lastUsedAt, "known");
          if (row.population === "policy") return row.attachmentCount;
          return loginValue(row.activity.at, row.activity.status);
        }
        if (sortKey === "access") {
          if (row.population === "sso") return row.accessLevel;
          if (row.population === "iam") return row.groups.map((group) => group.name).join(", ");
          if (row.population === "policy") return row.type;
          if (row.population === "role") return row.trustedEntities.join(", ");
          return instanceLabel(row);
        }
        if (sortKey === "scope") {
          if (row.population === "sso") return row.servicePreview;
          if (row.population === "iam") return row.groups.length;
          if (row.population === "role") return row.trustedEntities.length;
          if (row.population === "policy") return row.attachmentCount;
          if (row.instances === "all") return 1_000_000;
          return row.instances.length;
        }
        if (row.population === "sso") return row.displayName;
        if (row.population === "role") return row.roleName;
        if (row.population === "policy") return row.name;
        return row.userName;
      };
      const left = value(a);
      const right = value(b);
      if (typeof left === "number" && typeof right === "number") return (left - right) * dir;
      return String(left).localeCompare(String(right)) * dir;
    });
    return list;
  }, [rows, sortKey, sortDir, kind]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const selected = filtered.find((row) => row.id === selectedId) ?? rows.find((row) => row.id === selectedId) ?? null;

  const toggleSort = (key: SortKey) => {
    setPage(0);
    if (sortKey === key) setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const exportCsv = () => {
    const header =
      kind === "role"
        ? ["Role", "ARN", "Trusted entities", "Last activity"]
        : kind === "policy"
          ? ["Policy", "ARN", "Type", "Attachments", "Description"]
        : kind === "iam"
          ? ["User", "ARN", "Last activity", "How it was used", "Groups", "Inactive"]
          : kind === "ssm"
            ? ["User", "ARN", "Last login", "Target", "Permitted instances", "Inactive"]
            : ["User", "Email", "Display name", "Last login", "Access level", "Services", "Accounts", "Inactive"];
    const lines = filtered.map((row) => {
      if (row.population === "role") {
        return [row.roleName, row.arn, row.trustedEntities.join("; "), formatWhen(row.lastUsedAt, "known")];
      }
      if (row.population === "policy") {
        return [row.name, row.arn, row.type, String(row.attachmentCount), row.description ?? ""];
      }
      if (row.population === "iam") {
        return [
          row.userName,
          row.arn,
          formatWhen(row.activity.at, row.activity.status),
          row.activity.note ?? "",
          row.groups.map((group) => group.name).join("; "),
          row.inactive ? "yes" : "no",
        ];
      }
      if (row.population === "ssm") {
        return [
          row.userName,
          row.arn,
          formatWhen(row.activity.at, row.activity.status),
          row.activity.targetName ?? "",
          instanceLabel(row),
          row.inactive ? "yes" : "no",
        ];
      }
      return [
        row.userName,
        row.email,
        row.displayName,
        formatWhen(row.activity.at, row.activity.status),
        row.accessLevel,
        grantSummary(row),
        row.assignments.map((item) => `${item.accountName}:${item.permissionSetName}`).join("; "),
        row.inactive ? "yes" : "no",
      ];
    });
    const csv = [header, ...lines].map((line) => line.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      kind === "role" ? "iam-roles.csv" : kind === "policy" ? "iam-policies.csv" : kind === "iam" ? "iam-users.csv" : kind === "ssm" ? "ssm-users.csv" : "sso-users.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const ssmRows = data.ssm;
  const wide = ssmRows.filter((row) => row.unrestricted).length;
  const roleCount = (data.roles ?? []).length;
  const policyCount = (data.policies ?? []).length;

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="IAM users, roles, and policies are the IAM directory. Session Manager still lists only people who can start a session. The SSO directory stays separate."
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="SSM users" value={`${data.ssm.length}`} caption={`${wide} unrestricted`} tone="slate" icon={Users} active={view === "ssm"} onClick={() => openView("ssm")} />
        <StatCard label="SSO users" value={`${data.sso.length}`} caption="Identity Center, including orphans" tone="yellow" icon={Users} active={view === "sso"} onClick={() => openView("sso")} />
        <StatCard label="IAM users" value={`${(data.iam ?? []).length}`} caption="Every IAM user in this account" tone="slate" icon={Users} active={view === "iam"} onClick={() => openView("iam")} />
        <StatCard label="Roles" value={`${roleCount}`} caption="IAM roles in this account" tone="yellow" icon={Shield} active={view === "roles"} onClick={() => openView("roles")} />
        <StatCard label="Policies" value={`${policyCount}`} caption="Customer managed, and AWS managed policies in use" tone="amber" icon={ScrollText} active={view === "policies"} onClick={() => openView("policies")} />
      </div>

      {(error || data.warnings.length > 0) && (
        <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          {error ? `${error} ` : ""}
          {data.warnings[0]} {data.scpNote}
        </p>
      )}

      {loading && <p className="mt-4 text-sm text-gray-500">Reading IAM and Identity Center… this can take a few minutes.</p>}

      {view && (
      <div className="card mt-3 overflow-hidden">
        <div className="flex justify-end border-b border-gray-100 px-4 py-2">
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                <SortHeader label={kind === "role" ? "Role" : kind === "policy" ? "Policy" : "User"} active={sortKey === "user"} dir={sortDir} onClick={() => toggleSort("user")} />
                {kind === "role" ? (
                  <SortHeader label="Trusted entities" active={sortKey === "scope"} dir={sortDir} onClick={() => toggleSort("scope")} />
                ) : kind === "policy" ? (
                  <SortHeader label="Type" active={sortKey === "access"} dir={sortDir} onClick={() => toggleSort("access")} />
                ) : (
                  <SortHeader label={kind === "iam" ? "Last activity" : "Last login activity"} active={sortKey === "login"} dir={sortDir} onClick={() => toggleSort("login")} />
                )}
                {kind === "ssm" ? (
                  <SortHeader label="Permitted instances" active={sortKey === "scope"} dir={sortDir} onClick={() => toggleSort("scope")} />
                ) : kind === "iam" ? (
                  <SortHeader label="Groups" active={sortKey === "scope"} dir={sortDir} onClick={() => toggleSort("scope")} />
                ) : kind === "role" ? (
                  <SortHeader label="Last activity" active={sortKey === "login"} dir={sortDir} onClick={() => toggleSort("login")} />
                ) : kind === "policy" ? (
                  <SortHeader label="Attachments" active={sortKey === "scope"} dir={sortDir} onClick={() => toggleSort("scope")} />
                ) : (
                  <>
                    <SortHeader label="Access level" active={sortKey === "access"} dir={sortDir} onClick={() => toggleSort("access")} />
                    <SortHeader label="Services" active={sortKey === "scope"} dir={sortDir} onClick={() => toggleSort("scope")} />
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => {
                    if (row.population === "role" || row.population === "policy") return;
                    setSelectedId(row.id);
                  }}
                  className={row.population === "role" || row.population === "policy" ? "" : "cursor-pointer hover:bg-gray-50/80"}
                >
                  {row.population === "ssm" ? (
                    <SsmCells user={row} />
                  ) : row.population === "iam" ? (
                    <IamCells user={row} />
                  ) : row.population === "role" ? (
                    <RoleCells role={row} />
                  ) : row.population === "policy" ? (
                    <PolicyCells policy={row} />
                  ) : (
                    <SsoCells user={row} />
                  )}
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={kind === "sso" ? 4 : 3} className="px-4 py-8 text-center text-sm text-gray-500">
                    {kind === "role" ? "No roles in this account." : kind === "policy" ? "No policies in this account." : "No users in this group."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
          <span>
            {filtered.length === 0
              ? `0 ${kind === "role" ? "roles" : kind === "policy" ? "policies" : "users"}`
              : `${safePage * PAGE_SIZE + 1}–${Math.min(filtered.length, safePage * PAGE_SIZE + PAGE_SIZE)} of ${filtered.length}`}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
              className="rounded-lg px-2 py-1 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((value) => value + 1)}
              className="rounded-lg px-2 py-1 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40"
            >
              Next
            </button>
          </span>
        </div>
      </div>
      )}

      {selected && view && selected.population === "iam" && (
        <IamUserDetail user={selected} onClose={() => setSelectedId(null)} />
      )}
      {selected && view && (selected.population === "ssm" || selected.population === "sso") && (
        <Detail row={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th className="px-4 py-3 font-medium">
      <button type="button" onClick={onClick} className="inline-flex items-center gap-1 uppercase tracking-wide">
        {label}
        <span className="text-[10px] text-gray-400">{active ? (dir === "asc" ? "↑" : "↓") : ""}</span>
      </button>
    </th>
  );
}

function SsmCells({ user }: { user: SsmUserRow }) {
  return (
    <>
      <td className="px-4 py-3">
        <p className="font-medium" title={user.arn}>
          {user.userName}
        </p>
        <p className="text-xs text-gray-500">
          {user.inactive && <Badge tone="amber">Inactive</Badge>}
          {user.origin === "identity-center" && <Badge tone="gray">Identity Center</Badge>}
          {user.crossLink && <span className="ml-1">Also SSO · {user.crossLink.label}</span>}
        </p>
      </td>
      <td className="px-4 py-3 text-gray-700">
        <p>{formatWhen(user.activity.at, user.activity.status)}</p>
        <p className="text-xs text-gray-500">
          {user.activity.targetName
            ? `Session on ${user.activity.targetName}`
            : user.activity.status === "known" && !user.activity.at
              ? "No SSM session found"
              : user.activity.note ?? ""}
          {user.activity.forwardedHost ? ` · forwarded to ${user.activity.forwardedHost}` : ""}
        </p>
      </td>
      <td className="px-4 py-3">
        {user.unrestricted || user.instances === "all" ? (
          <Badge tone="amber">All instances</Badge>
        ) : user.instances.length === 0 ? (
          <span className="text-gray-500">None</span>
        ) : (
          <span className="text-gray-700">{user.instances.map((item) => item.name).join(", ")}</span>
        )}
      </td>
    </>
  );
}

function RoleCells({ role }: { role: IamRoleRow }) {
  return (
    <>
      <td className="px-4 py-3">
        <p className="font-medium" title={role.arn}>{role.roleName}</p>
        <p className="text-xs text-gray-500">IAM role</p>
      </td>
      <td className="px-4 py-3 text-gray-700">{role.trustedEntities.length ? role.trustedEntities.join(", ") : "None"}</td>
      <td className="px-4 py-3 text-gray-700">{formatWhen(role.lastUsedAt, "known")}</td>
    </>
  );
}

function PolicyCells({ policy }: { policy: IamPolicyRow }) {
  return (
    <>
      <td className="px-4 py-3">
        <p className="font-medium" title={policy.arn}>{policy.name}</p>
        {policy.description && <p className="text-xs text-gray-500">{policy.description}</p>}
      </td>
      <td className="px-4 py-3 text-gray-700">{policy.type}</td>
      <td className="px-4 py-3 text-gray-700">{policy.attachmentCount}</td>
    </>
  );
}

function IamCells({ user }: { user: IamUserRow }) {
  const used =
    user.activity.status === "unavailable"
      ? "Access key history could not be read"
      : user.activity.kind === "signin"
        ? "Console password"
        : user.activity.at
          ? "Access key"
          : "No password or access key use recorded";
  return (
    <>
      <td className="px-4 py-3">
        <p className="font-medium" title={user.arn}>{user.userName}</p>
        <p className="text-xs text-gray-500">
          IAM user
          {user.inactive && <Badge tone="amber">Inactive</Badge>}
        </p>
      </td>
      <td className="px-4 py-3 text-gray-700">
        <p>{formatWhen(user.activity.at, user.activity.status)}</p>
        <p className="text-xs text-gray-500">{used}</p>
      </td>
      <td className="px-4 py-3 text-gray-700">{user.groups.length ? user.groups.map((group) => group.name).join(", ") : "None"}</td>
    </>
  );
}

function ssoActivityLine(user: SsoUserRow): string {
  if (user.activity.status === "unavailable") return "Sign-in history could not be read";
  if (user.activity.kind === "session" && user.activity.at) return "Session Manager";
  if (user.activity.at) return "Console sign-in";
  return "No console sign-in or Session Manager session in the last 90 days";
}

function SsoCells({ user }: { user: SsoUserRow }) {
  const signIn = ssoActivityLine(user);
  return (
    <>
      <td className="px-4 py-3">
        <p className="font-medium">{user.displayName || user.userName}</p>
        <p className="text-xs text-gray-500">
          {user.email || user.userName}
          {user.inactive && <Badge tone="amber">Inactive</Badge>}
          {user.orphaned && <Badge tone="red">Orphaned</Badge>}
          {user.crossLink && <span className="ml-1">Also SSM · {user.crossLink.label}</span>}
        </p>
      </td>
      <td className="px-4 py-3 text-gray-700">
        <p>{formatWhen(user.activity.at, user.activity.status)}</p>
        <p className="text-xs text-gray-500">{signIn}</p>
      </td>
      <td className="px-4 py-3">
        <AccessPill level={user.accessLevel} />
        {user.assignments.length > 1 && (
          <p className="mt-1 text-xs text-gray-500">{user.assignments.length} attachments</p>
        )}
      </td>
      <td className="px-4 py-3 text-gray-700">{grantSummary(user)}</td>
    </>
  );
}

function AccessPill({ level }: { level: SsoUserRow["accessLevel"] }) {
  if (level === "read-write") return <Badge tone="amber">Read/Write</Badge>;
  if (level === "read-only") return <Badge tone="green">Read-only</Badge>;
  return <Badge tone="gray">No access</Badge>;
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "amber" | "green" | "red" | "gray" }) {
  const toneClass = {
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    red: "bg-red-50 text-red-700 ring-red-200",
    gray: "bg-gray-100 text-gray-600 ring-gray-200",
  }[tone];
  return <span className={`pill mr-1 ring-1 ${toneClass}`}>{children}</span>;
}

function Detail({ row, onClose }: { row: SsmUserRow | SsoUserRow; onClose: () => void }) {
  const sso = row.population === "sso" ? row : null;
  const writeActions = sso ? uniqueActions(sso.assignments.flatMap((item) => item.writeActions ?? [])) : [];
  const notableActions = sso ? uniqueActions(sso.assignments.flatMap((item) => item.notableActions ?? [])) : [];
  const activityDetail = row.population === "sso"
    ? row.activity.status === "unavailable"
      ? row.activity.note ?? "Sign-in history could not be read."
      : row.activity.kind === "session" && row.activity.at
        ? row.activity.targetName
          ? `Session Manager session on ${row.activity.targetName}. This is not a console sign-in.`
          : "Session Manager session. This is not a console sign-in."
        : row.activity.at
          ? "Console sign-in recorded by CloudTrail. This is not a shell session."
          : "No console sign-in or Session Manager session in the last 90 days."
    : row.population === "ssm" && row.origin === "identity-center" && row.activity.targetName
      ? `Session Manager session on ${row.activity.targetName}. This row is the Identity Center user, kept separate from any IAM user.`
    : row.activity.targetName
      ? `Session Manager session on ${row.activity.targetName}.`
      : row.activity.status === "known" && !row.activity.at
        ? "No Session Manager session in the history that was read."
        : row.activity.note ?? "";
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-gray-900/30">
      <button className="absolute inset-0" aria-label="Close details" onClick={onClose} />
      <aside className="relative h-full w-full max-w-3xl overflow-y-auto bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              {row.population === "sso" || (row.population === "ssm" && row.origin === "identity-center") ? "Identity Center" : "IAM user"}
            </p>
            <h2 className="mt-1 text-lg font-semibold">{row.population === "sso" ? row.displayName : row.userName}</h2>
            <p className="mt-1 break-all text-xs text-gray-500">{row.population === "sso" ? row.email || row.userName : row.arn}</p>
            <div className="mt-2">
              {sso ? <AccessPill level={sso.accessLevel} /> : row.inactive ? <Badge tone="amber">Inactive</Badge> : <Badge tone="green">Active</Badge>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-gray-500 hover:bg-gray-100">
            Close
          </button>
        </div>
        <p className="mt-4 text-sm text-gray-800">{formatWhen(row.activity.at, row.activity.status)}</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">{activityDetail}</p>
        {row.crossLink && (
          <p className="mt-3 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-600">
            Same person also has {row.crossLink.population === "sso" ? "an SSO identity" : "an IAM user"}: {row.crossLink.label}. The two rows stay separate.
          </p>
        )}
        {sso && (
          <>
            <h3 className="mt-5 text-sm font-semibold">How this access is attached</h3>
            <ul className="mt-2 space-y-2">
              {sso.assignments.length === 0 && <li className="text-sm text-gray-500">No account assignment.</li>}
              {sso.assignments.map((item, index) => (
                <li key={`${item.accountId}-${item.permissionSetName}-${item.via}-${index}`} className="rounded-xl bg-gray-50 px-3 py-2 text-sm">
                  <p className="font-medium">{item.permissionSetName}</p>
                  <p className="text-xs text-gray-600">
                    {item.via === "group" ? `Through group ${item.groupName}` : "Assigned directly to this user"}
                    {" · "}
                    {item.accountName}
                    {item.unresolved ? " · one policy could not be read" : ""}
                  </p>
                  {(item.policies ?? []).length > 0 && (
                    <p className="mt-1 text-xs text-gray-500">Policies: {item.policies?.join(", ")}</p>
                  )}
                </li>
              ))}
            </ul>
            <ServiceTable grants={mergedGrants(sso)} />
            {writeActions.length > 0 && (
              <ActionProof
                title="Write is checked because of these actions"
                body="Each line is an allow action that can create, change, or delete something, or a wildcard such as *."
                actions={writeActions}
              />
            )}
            {writeActions.length === 0 && notableActions.length > 0 && (
              <ActionProof
                title="Read-only, with the actions that are not Get, List, or Describe"
                body="Write stays unchecked. These names sit in the attached policy and do not create, change, or delete a resource."
                actions={notableActions}
              />
            )}
          </>
        )}
        {row.population === "ssm" && row.instances !== "all" && <InstanceList instances={row.instances} />}
        {row.population === "ssm" && (row.unrestricted || row.instances === "all") && (
          <p className="mt-4 text-sm text-gray-700">StartSession is allowed on every instance.</p>
        )}
        {row.notes.length > 0 && (
          <ul className="mt-4 space-y-1 text-xs leading-relaxed text-gray-500">
            {row.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function ServiceTable({ grants }: { grants: ServiceGrant[] | "all" }) {
  const [query, setQuery] = useState("");
  const rows = grants === "all"
    ? [{ name: "All services", read: true, write: true }]
    : grants.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));
  const writeCount = grants === "all" ? 1 : grants.filter((item) => item.write).length;
  return (
    <div className="mt-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Services</h3>
          <p className="mt-1 text-xs text-gray-500">
            {grants === "all"
              ? "Every service. Read and write are both allowed."
              : `${grants.length} services. Write is checked on ${writeCount}.`}
          </p>
        </div>
        {grants !== "all" && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a service"
            aria-label="Find a service"
            className="w-40 rounded-lg border border-gray-200 px-2 py-1 text-xs outline-none focus:border-gray-400"
          />
        )}
      </div>
      <div className="mt-2 max-h-80 overflow-auto rounded-xl border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="w-20 px-3 py-2 font-medium">Read</th>
              <th className="w-20 px-3 py-2 font-medium">Write</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-3 text-xs text-gray-500">No service matches.</td>
              </tr>
            )}
            {rows.map((item) => (
              <tr key={item.name} className="border-t border-gray-100">
                <td className="px-3 py-1.5 text-gray-800">{item.name}</td>
                <td className="px-3 py-1.5">
                  <input type="checkbox" checked={item.read} onChange={() => undefined} aria-label={`${item.name} read`} className="h-4 w-4 accent-gray-900" />
                </td>
                <td className="px-3 py-1.5">
                  <input type="checkbox" checked={item.write} onChange={() => undefined} aria-label={`${item.name} write`} className="h-4 w-4 accent-gray-900" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActionProof({ title, body, actions }: { title: string; body: string; actions: string[] }) {
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">{body} {actions.length} listed.</p>
      <ul className="mt-2 max-h-48 overflow-auto rounded-xl bg-gray-50 px-3 py-2 font-mono text-xs leading-6 text-gray-700">
        {actions.map((action) => (
          <li key={action}>{action}</li>
        ))}
      </ul>
    </div>
  );
}

function InstanceList({ instances }: { instances: InstanceGrant[] }) {
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold">Instances this user can open</h3>
      {instances.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">No instance grant. A policy mentioning * is not enough.</p>
      ) : (
        <div className="mt-2 overflow-auto rounded-xl border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Instance</th>
                <th className="px-3 py-2 font-medium">Region</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((item) => (
                <tr key={item.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5">{item.name}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-600">{item.id}</td>
                  <td className="px-3 py-1.5 text-gray-600">{item.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
