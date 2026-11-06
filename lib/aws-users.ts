import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  GenerateServiceLastAccessedDetailsCommand,
  GetAccessKeyLastUsedCommand,
  GetGroupPolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetServiceLastAccessedDetailsCommand,
  GetUserCommand,
  GetUserPolicyCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListAttachedGroupPoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupPoliciesCommand,
  ListGroupsForUserCommand,
  ListPoliciesCommand,
  ListRolesCommand,
  ListUserPoliciesCommand,
  ListUsersCommand,
} from "@aws-sdk/client-iam";
import {
  DescribeSessionsCommand,
  SSMClient,
  type Session,
} from "@aws-sdk/client-ssm";
import {
  ListGroupMembershipsCommand,
  ListGroupsCommand,
  ListUsersCommand as ListIdentityUsersCommand,
  IdentitystoreClient,
} from "@aws-sdk/client-identitystore";
import {
  DescribePermissionSetCommand,
  GetInlinePolicyForPermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListCustomerManagedPolicyReferencesInPermissionSetCommand,
  ListInstancesCommand,
  ListManagedPoliciesInPermissionSetCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import {
  ListAccountsCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  LookupEventsCommand,
  CloudTrailClient,
  type Event,
} from "@aws-sdk/client-cloudtrail";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { accountClientConfig } from "@/lib/aws";
import { requireAccount } from "@/lib/account-store";
import {
  actionsFromDocument,
  allowsStartSession,
  describeAccess,
  evaluateSsmAccess,
  highestLevel,
  isInactive,
  levelForManagedPolicy,
  linkPopulations,
  pickActivity,
  previewServices,
  type NamedPolicy,
  type PolicyDocument,
} from "@/lib/users-logic";
import type {
  Activity,
  IamGroupMembership,
  IamPolicyAttachment,
  IamPolicyRow,
  IamRoleRow,
  IamServiceAccess,
  IamUserRow,
  InstanceGrant,
  SsmUserRow,
  SsoAssignment,
  SsoUserRow,
  UsersPayload,
} from "@/lib/users-types";
import { SCP_NOTE } from "@/lib/users-types";

const PORT_FORWARD = "AWS-StartPortForwardingSessionToRemoteHost";

async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let wait = 300;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      const retry = /Throttl|TooManyRequests|RequestLimitExceeded|SlowDown|ServiceUnavailable/.test(name);
      if (!retry || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait *= 2;
    }
  }
  throw new Error("retry exhausted");
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function parsePolicy(raw: string | undefined): PolicyDocument | null {
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw)) as PolicyDocument;
  } catch {
    try {
      return JSON.parse(raw) as PolicyDocument;
    } catch {
      return null;
    }
  }
}

interface LiveInstance {
  id: string;
  name: string;
  region: string;
  accountId: string;
  tags: Record<string, string>;
}

interface SessionHit {
  at: string;
  instanceId: string;
  documentName: string | null;
  forwardedHost: string | null;
  source: "ssm" | "cloudtrail";
  kind: "session" | "signin";
}

export async function buildUsers(): Promise<UsersPayload> {
  const warnings: string[] = [
    "SSM session history and CloudTrail lookup cover recent events only. CloudTrail can lag about 15 minutes and LookupEvents searches the last 90 days.",
    "RDS is not an SSM session target. A port-forward host is shown only when CloudTrail recorded AWS-StartPortForwardingSessionToRemoteHost.",
  ];
  const account = requireAccount();
  const sts = new STSClient(accountClientConfig(account.region));
  const identity = await withBackoff(() => sts.send(new GetCallerIdentityCommand({})));
  const accountId = identity.Account ?? "";
  const iam = new IAMClient(accountClientConfig("us-east-1"));

  const [instances, sessionResult, trailResult] = await Promise.all([
    listInstances(accountId, warnings),
    listSessions(warnings),
    listTrailHits(warnings),
  ]);
  const historyOk = sessionResult.ok || trailResult.ok;
  const ssoResult = await listSso(
    iam,
    accountId,
    instances,
    sessionResult.hits,
    trailResult.sessions,
    trailResult.signins,
    trailResult.ok,
    sessionResult.ok,
    warnings
  ).catch((error: unknown) => {
    warnings.push(`SSO scan failed: ${(error as { name?: string }).name ?? "error"}. No SSO users were invented to fill the gap.`);
    return { users: [] as SsoUserRow[], sessionUsers: [] as SsmUserRow[] };
  });

  const [iamSsm, iamUsers, roles, policies] = await Promise.all([
    listSsmUsers(iam, instances, sessionResult.hits, trailResult.sessions, historyOk, warnings),
    listIamUsers(iam, warnings),
    listIamRoles(iam, warnings),
    listIamPolicies(iam, warnings),
  ]);
  linkPopulations(iamSsm, ssoResult.users);
  const ssm = [...iamSsm, ...ssoResult.sessionUsers].sort((a, b) => a.userName.localeCompare(b.userName));
  ssoResult.users.sort((a, b) => a.userName.localeCompare(b.userName));
  iamUsers.sort((a, b) => a.userName.localeCompare(b.userName));
  roles.sort((a, b) => a.roleName.localeCompare(b.roleName));
  policies.sort((a, b) => a.name.localeCompare(b.name));

  return {
    live: true,
    asOf: new Date().toISOString(),
    warnings,
    scpNote: SCP_NOTE,
    ssm,
    sso: ssoResult.users,
    iam: iamUsers,
    roles,
    policies,
    instances: instances.map(({ id, name, region }) => ({ id, name, region })),
  };
}

async function regions(): Promise<string[]> {
  const home = requireAccount().region;
  try {
    const ec2 = new EC2Client(accountClientConfig(home));
    const result = await withBackoff(() => ec2.send(new DescribeRegionsCommand({ AllRegions: false })));
    const names = (result.Regions ?? []).map((region) => region.RegionName ?? "").filter(Boolean);
    return names.length ? names : [home];
  } catch {
    return [home, "us-east-1"];
  }
}

async function listInstances(accountId: string, warnings: string[]): Promise<LiveInstance[]> {
  const found: LiveInstance[] = [];
  try {
    const regs = await regions();
    await mapPool(regs, 8, async (region) => {
      const ec2 = new EC2Client(accountClientConfig(region));
      let token: string | undefined;
      do {
        const page = await withBackoff(() =>
          ec2.send(new DescribeInstancesCommand({ NextToken: token, MaxResults: 100 }))
        );
        for (const reservation of page.Reservations ?? []) {
          for (const item of reservation.Instances ?? []) {
            if (!item.InstanceId) continue;
            const tags: Record<string, string> = {};
            for (const tag of item.Tags ?? []) {
              if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
            }
            found.push({
              id: item.InstanceId,
              name: tags.Name || item.InstanceId,
              region,
              accountId,
              tags,
            });
          }
        }
        token = page.NextToken;
      } while (token);
    });
  } catch (error) {
    warnings.push(`EC2 instance list failed (${(error as { name?: string }).name ?? "error"}). Instance names may be missing.`);
  }
  return found;
}

async function listSessions(warnings: string[]): Promise<{ hits: Map<string, SessionHit>; ok: boolean }> {
  const hits = new Map<string, SessionHit>();
  try {
    const regs = await regions();
    await mapPool(regs, 6, async (region) => {
      const ssm = new SSMClient(accountClientConfig(region));
      for (const state of ["Active", "History"] as const) {
        let token: string | undefined;
        for (let page = 0; page < 8; page++) {
          const result = await withBackoff(() =>
            ssm.send(new DescribeSessionsCommand({ State: state, NextToken: token, MaxResults: 50 }))
          );
          for (const session of result.Sessions ?? []) rememberSession(hits, session);
          token = result.NextToken;
          if (!token) break;
          if (page === 7) warnings.push(`SSM session history in ${region} was truncated at 400 sessions.`);
        }
      }
    });
  } catch (error) {
    warnings.push(`SSM DescribeSessions failed (${(error as { name?: string }).name ?? "error"}). Last session may fall back to CloudTrail.`);
    return { hits, ok: false };
  }
  return { hits, ok: true };
}

function rememberSession(hits: Map<string, SessionHit>, session: Session) {
  if (!session.Owner || !session.StartDate) return;
  const hit: SessionHit = {
    at: session.StartDate.toISOString(),
    instanceId: session.Target ?? "",
    documentName: session.DocumentName ?? null,
    forwardedHost: null,
    source: "ssm",
    kind: "session",
  };
  const keys = ownerKeys(session.Owner);
  for (const key of keys) {
    const prev = hits.get(key);
    if (!prev || prev.at < hit.at) hits.set(key, hit);
  }
}

function ownerKeys(owner: string): string[] {
  const keys = new Set<string>([owner.toLowerCase()]);
  const slash = owner.split("/").pop();
  if (slash) keys.add(slash.toLowerCase());
  return Array.from(keys);
}

async function listTrailHits(warnings: string[]): Promise<{ sessions: Map<string, SessionHit>; signins: Map<string, SessionHit>; ok: boolean }> {
  const sessions = new Map<string, SessionHit>();
  const signins = new Map<string, SessionHit>();
  const home = requireAccount().region;
  const regionsToTry = Array.from(new Set([home, "us-east-1"]));
  let any = false;
  for (const region of regionsToTry) {
    try {
      const trail = new CloudTrailClient(accountClientConfig(region));
      for (const eventName of ["StartSession", "ConsoleLogin", "UserAuthentication"]) {
        let token: string | undefined;
        for (let page = 0; page < 6; page++) {
          const result = await withBackoff(() =>
            trail.send(
              new LookupEventsCommand({
                LookupAttributes: [{ AttributeKey: "EventName", AttributeValue: eventName }],
                NextToken: token,
                MaxResults: 50,
              })
            )
          );
          any = true;
          for (const event of result.Events ?? []) rememberTrail(sessions, signins, event);
          token = result.NextToken;
          if (!token) break;
        }
      }
    } catch (error) {
      const name = (error as { name?: string }).name ?? "error";
      if (name !== "AccessDeniedException") {
        warnings.push(`CloudTrail lookup in ${region} failed (${name}).`);
      }
    }
  }
  if (!any) {
    warnings.push("CloudTrail lookup was not permitted. Last login shows SSM session history only, or Unavailable when that is missing too.");
    return { sessions, signins, ok: false };
  }
  return { sessions, signins, ok: true };
}

function rememberTrail(sessions: Map<string, SessionHit>, signins: Map<string, SessionHit>, event: Event) {
  if (!event.Username || !event.EventTime) return;
  let target = "";
  let documentName: string | null = null;
  let forwardedHost: string | null = null;
  if (event.CloudTrailEvent) {
    try {
      const body = JSON.parse(event.CloudTrailEvent) as {
        requestParameters?: { target?: string; host?: string; documentName?: string };
      };
      target = body.requestParameters?.target ?? "";
      documentName = body.requestParameters?.documentName ?? null;
      if (documentName === PORT_FORWARD) forwardedHost = body.requestParameters?.host ?? null;
    } catch {
      /* keep the timestamp */
    }
  }
  const kind = event.EventName === "StartSession" ? "session" : "signin";
  if (kind !== "session") {
    target = "";
    documentName = null;
    forwardedHost = null;
  }
  const hit: SessionHit = {
    at: event.EventTime.toISOString(),
    instanceId: target,
    documentName,
    forwardedHost,
    source: "cloudtrail",
    kind,
  };
  const bucket = kind === "session" ? sessions : signins;
  for (const key of ownerKeys(event.Username)) keepLatest(bucket, key, hit);
}

function keepLatest(hits: Map<string, SessionHit>, key: string, hit: SessionHit) {
  const prev = hits.get(key);
  if (!prev || prev.at < hit.at) hits.set(key, hit);
}

async function listIamUsers(iam: IAMClient, warnings: string[]): Promise<IamUserRow[]> {
  const users: { userName: string; arn: string }[] = [];
  let marker: string | undefined;
  do {
    const page = await withBackoff(() => iam.send(new ListUsersCommand({ Marker: marker, MaxItems: 100 })));
    for (const user of page.Users ?? []) {
      if (user.UserName && user.Arn) users.push({ userName: user.UserName, arn: user.Arn });
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);

  let keyHistoryDenied = false;
  let accessAdvisorDenied = false;
  const groupPolicies = new Map<string, IamPolicyAttachment[]>();
  const rows = await mapPool(users, 4, async (user) => {
    try {
      return await oneIamUser(iam, user, groupPolicies, () => {
        keyHistoryDenied = true;
      }, () => {
        accessAdvisorDenied = true;
      });
    } catch (error) {
      warnings.push(`IAM user ${user.userName} could not be read (${(error as { name?: string }).name ?? "error"}).`);
      return null;
    }
  });
  if (keyHistoryDenied) {
    warnings.push("Access key last-used could not be read. IAM rows still list every user. Console password time is shown when IAM returned it.");
  }
  if (accessAdvisorDenied) {
    warnings.push("Service last accessed could not be read. The Last accessed tab stays empty for those users.");
  }
  return rows.filter((row): row is IamUserRow => row !== null);
}

function policyKind(arn: string | null | undefined): IamPolicyAttachment["type"] {
  if (!arn) return "Inline";
  if (arn.startsWith("arn:aws:iam::aws:policy/")) return "AWS managed";
  return "Customer managed";
}

function arnTail(arn: string | null | undefined): string | null {
  if (!arn) return null;
  const slash = arn.lastIndexOf("/");
  return slash >= 0 ? arn.slice(slash + 1) : arn;
}

async function groupPolicyAttachments(iam: IAMClient, groupName: string, cache: Map<string, IamPolicyAttachment[]>): Promise<IamPolicyAttachment[]> {
  const cached = cache.get(groupName);
  if (cached) return cached;
  const [attached, inline] = await Promise.all([
    withBackoff(() => iam.send(new ListAttachedGroupPoliciesCommand({ GroupName: groupName }))),
    withBackoff(() => iam.send(new ListGroupPoliciesCommand({ GroupName: groupName }))),
  ]);
  const policies: IamPolicyAttachment[] = [];
  for (const policy of attached.AttachedPolicies ?? []) {
    if (!policy.PolicyName) continue;
    policies.push({
      name: policy.PolicyName,
      arn: policy.PolicyArn ?? null,
      type: policyKind(policy.PolicyArn),
      attachedVia: groupName,
    });
  }
  for (const name of inline.PolicyNames ?? []) {
    policies.push({ name, arn: null, type: "Inline", attachedVia: groupName });
  }
  cache.set(groupName, policies);
  return policies;
}

async function newestAccessKeyUse(iam: IAMClient, userName: string, onKeyDenied: () => void): Promise<{ newest: string | null; unreadable: boolean }> {
  let newest: string | null = null;
  let unreadable = false;
  try {
    const listed = await withBackoff(() => iam.send(new ListAccessKeysCommand({ UserName: userName })));
    for (const key of listed.AccessKeyMetadata ?? []) {
      if (!key.AccessKeyId) continue;
      try {
        const used = await withBackoff(() => iam.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: key.AccessKeyId })));
        const at = used.AccessKeyLastUsed?.LastUsedDate?.toISOString() ?? null;
        if (at && (!newest || newest < at)) newest = at;
      } catch {
        unreadable = true;
        onKeyDenied();
      }
    }
  } catch {
    unreadable = true;
    onKeyDenied();
  }
  return { newest, unreadable };
}

async function serviceLastAccessed(iam: IAMClient, arn: string, onDenied: () => void): Promise<{ services: IamServiceAccess[]; status: "known" | "unavailable" }> {
  let jobId: string | undefined;
  try {
    const job = await withBackoff(() => iam.send(new GenerateServiceLastAccessedDetailsCommand({ Arn: arn, Granularity: "SERVICE_LEVEL" })));
    jobId = job.JobId;
  } catch (error) {
    const name = (error as { name?: string }).name ?? "";
    if (name === "AccessDenied" || name === "AccessDeniedException") onDenied();
    return { services: [], status: "unavailable" };
  }
  if (!jobId) return { services: [], status: "unavailable" };
  const deadline = Date.now() + 20_000;
  const services: IamServiceAccess[] = [];
  let marker: string | undefined;
  while (Date.now() < deadline) {
    const page = await withBackoff(() =>
      iam.send(new GetServiceLastAccessedDetailsCommand({ JobId: jobId, Marker: marker, MaxItems: 100 }))
    );
    if (page.JobStatus === "FAILED") return { services: [], status: "unavailable" };
    if (page.JobStatus === "IN_PROGRESS") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    for (const item of page.ServicesLastAccessed ?? []) {
      services.push({
        service: item.ServiceName ?? item.ServiceNamespace ?? "Unknown service",
        lastAccessed: item.LastAuthenticated?.toISOString() ?? null,
        region: item.LastAuthenticatedRegion ?? null,
      });
    }
    if (!page.IsTruncated) return { services, status: "known" };
    marker = page.Marker;
  }
  return { services, status: services.length ? "known" : "unavailable" };
}

async function oneIamUser(
  iam: IAMClient,
  user: { userName: string; arn: string },
  groupPolicies: Map<string, IamPolicyAttachment[]>,
  onKeyDenied: () => void,
  onAccessDenied: () => void
): Promise<IamUserRow> {
  const [detail, groupPage, attached, inline, access, lastAccessed] = await Promise.all([
    withBackoff(() => iam.send(new GetUserCommand({ UserName: user.userName }))),
    withBackoff(() => iam.send(new ListGroupsForUserCommand({ UserName: user.userName, MaxItems: 100 }))),
    withBackoff(() => iam.send(new ListAttachedUserPoliciesCommand({ UserName: user.userName }))),
    withBackoff(() => iam.send(new ListUserPoliciesCommand({ UserName: user.userName }))),
    newestAccessKeyUse(iam, user.userName, onKeyDenied),
    serviceLastAccessed(iam, user.arn, onAccessDenied),
  ]);
  const passwordAt = detail.User?.PasswordLastUsed?.toISOString() ?? null;
  const groups: IamGroupMembership[] = [];
  const policies: IamPolicyAttachment[] = [];
  for (const policy of attached.AttachedPolicies ?? []) {
    if (!policy.PolicyName) continue;
    policies.push({
      name: policy.PolicyName,
      arn: policy.PolicyArn ?? null,
      type: policyKind(policy.PolicyArn),
      attachedVia: "Directly",
    });
  }
  for (const name of inline.PolicyNames ?? []) {
    policies.push({ name, arn: null, type: "Inline", attachedVia: "Directly" });
  }
  for (const group of groupPage.Groups ?? []) {
    if (!group.GroupName) continue;
    const inherited = await groupPolicyAttachments(iam, group.GroupName, groupPolicies);
    groups.push({
      name: group.GroupName,
      arn: group.Arn ?? "",
      createdAt: group.CreateDate?.toISOString() ?? null,
      policies: inherited.map((policy) => policy.name),
    });
    for (const policy of inherited) policies.push(policy);
  }
  const keyAt = access.newest;
  const passwordWins = Boolean(passwordAt && (!keyAt || passwordAt >= keyAt));
  const at = passwordWins ? passwordAt : keyAt;
  const activity: Activity = {
    at,
    status: access.unreadable && !at ? "unavailable" : "known",
    targetInstanceId: null,
    targetName: null,
    forwardedHost: null,
    source: access.unreadable && !at ? "unavailable" : "none",
    kind: passwordWins ? "signin" : null,
    note: passwordWins
      ? "Console password was used. This is the IAM user record, not a Session Manager session."
      : keyAt
        ? "An access key was used. This is the IAM user record, not a Session Manager session."
        : access.unreadable
          ? "Access key last-used could not be read, and no console password use was recorded."
          : "No console password or access key use was recorded.",
  };
  return {
    population: "iam",
    id: user.userName,
    userName: user.userName,
    arn: user.arn,
    activity,
    groups,
    policies,
    permissionsBoundary: arnTail(detail.User?.PermissionsBoundary?.PermissionsBoundaryArn),
    lastAccessed: lastAccessed.services,
    lastAccessedStatus: lastAccessed.status,
    inactive: isInactive(activity),
  };
}

function trustedEntities(raw: string | undefined): string[] {
  if (!raw) return [];
  const text = raw.trim().startsWith("{") ? raw : safeDecode(raw);
  let policy: { Statement?: unknown };
  try {
    policy = JSON.parse(text) as { Statement?: unknown };
  } catch {
    return [];
  }
  const names: string[] = [];
  const statements = Array.isArray(policy.Statement) ? policy.Statement : [];
  for (const statement of statements) {
    if (!statement || typeof statement !== "object") continue;
    collectPrincipals((statement as { Principal?: unknown }).Principal, names);
  }
  return names;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectPrincipals(principal: unknown, names: string[]) {
  if (principal == null) return;
  if (principal === "*") {
    if (!names.includes("Anyone")) names.push("Anyone");
    return;
  }
  if (typeof principal === "string") {
    if (!names.includes(principal)) names.push(principal);
    return;
  }
  if (typeof principal !== "object") return;
  const record = principal as Record<string, unknown>;
  for (const key of ["Service", "AWS", "Federated", "CanonicalUser"]) {
    const value = record[key];
    const list = Array.isArray(value) ? value : value != null ? [value] : [];
    for (const item of list) {
      const label = String(item);
      if (!names.includes(label)) names.push(label);
    }
  }
}

async function listIamRoles(iam: IAMClient, warnings: string[]): Promise<IamRoleRow[]> {
  try {
    const roles: IamRoleRow[] = [];
    let marker: string | undefined;
    do {
      const page = await withBackoff(() => iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 100 })));
      for (const role of page.Roles ?? []) {
        if (!role.RoleName || !role.Arn) continue;
        roles.push({
          population: "role",
          id: role.Arn,
          roleName: role.RoleName,
          arn: role.Arn,
          trustedEntities: trustedEntities(role.AssumeRolePolicyDocument),
          lastUsedAt: role.RoleLastUsed?.LastUsedDate?.toISOString() ?? null,
          createdAt: role.CreateDate?.toISOString() ?? null,
        });
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    return roles;
  } catch (error) {
    warnings.push(`IAM roles could not be read (${(error as { name?: string }).name ?? "error"}).`);
    return [];
  }
}

async function listIamPolicies(iam: IAMClient, warnings: string[]): Promise<IamPolicyRow[]> {
  try {
    const [customer, attachedAws] = await Promise.all([
      listPolicies(iam, "Local", false),
      listPolicies(iam, "AWS", true),
    ]);
    const seen = new Set<string>();
    const rows: IamPolicyRow[] = [];
    for (const row of [...customer, ...attachedAws]) {
      if (seen.has(row.arn)) continue;
      seen.add(row.arn);
      rows.push(row);
    }
    return rows;
  } catch (error) {
    warnings.push(`IAM policies could not be read (${(error as { name?: string }).name ?? "error"}).`);
    return [];
  }
}

async function listPolicies(iam: IAMClient, scope: "Local" | "AWS", onlyAttached: boolean): Promise<IamPolicyRow[]> {
  const rows: IamPolicyRow[] = [];
  let marker: string | undefined;
  do {
    const page = await withBackoff(() =>
      iam.send(new ListPoliciesCommand({ Scope: scope, OnlyAttached: onlyAttached, Marker: marker, MaxItems: 100 }))
    );
    for (const policy of page.Policies ?? []) {
      if (!policy.PolicyName || !policy.Arn) continue;
      rows.push({
        population: "policy",
        id: policy.Arn,
        name: policy.PolicyName,
        arn: policy.Arn,
        type: policy.Arn.startsWith("arn:aws:iam::aws:policy/") ? "AWS managed" : "Customer managed",
        attachmentCount: policy.AttachmentCount ?? 0,
        description: policy.Description ?? null,
      });
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return rows;
}

async function listSsmUsers(
  iam: IAMClient,
  instances: LiveInstance[],
  sessions: Map<string, SessionHit>,
  trail: Map<string, SessionHit>,
  historyOk: boolean,
  warnings: string[]
): Promise<SsmUserRow[]> {
  const users: { userName: string; arn: string }[] = [];
  let marker: string | undefined;
  do {
    const page = await withBackoff(() => iam.send(new ListUsersCommand({ Marker: marker, MaxItems: 100 })));
    for (const user of page.Users ?? []) {
      if (user.UserName && user.Arn) users.push({ userName: user.UserName, arn: user.Arn });
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);

  const policyCache = new Map<string, PolicyDocument | null>();
  const rows = await mapPool(users, 4, async (user) => {
    try {
      return await oneSsmUser(iam, user, instances, sessions, trail, historyOk, policyCache);
    } catch (error) {
      warnings.push(`Permissions for ${user.userName} could not be read (${(error as { name?: string }).name ?? "error"}). The user is still listed.`);
      const activity = activityFor(user, sessions, trail, instances, historyOk);
      return {
        population: "ssm" as const,
        id: user.userName,
        userName: user.userName,
        arn: user.arn,
        activity,
        instances: [],
        unrestricted: false,
        inactive: isInactive(activity),
        evidence: [],
        notes: ["Permissions could not be read. This user was not dropped."],
        crossLink: null,
      };
    }
  });

  return rows.filter((row): row is SsmUserRow => row !== null);
}

async function oneSsmUser(
  iam: IAMClient,
  user: { userName: string; arn: string },
  instances: LiveInstance[],
  sessions: Map<string, SessionHit>,
  trail: Map<string, SessionHit>,
  historyOk: boolean,
  policyCache: Map<string, PolicyDocument | null>
): Promise<SsmUserRow | null> {
  const policies: NamedPolicy[] = [];
  const inlineNames = await withBackoff(() =>
    iam.send(new ListUserPoliciesCommand({ UserName: user.userName }))
  );
  for (const name of inlineNames.PolicyNames ?? []) {
    const got = await withBackoff(() =>
      iam.send(new GetUserPolicyCommand({ UserName: user.userName, PolicyName: name }))
    );
    const document = parsePolicy(got.PolicyDocument);
    if (document) policies.push({ name, sourceType: "inline", document });
  }
  const attached = await withBackoff(() =>
    iam.send(new ListAttachedUserPoliciesCommand({ UserName: user.userName }))
  );
  for (const policy of attached.AttachedPolicies ?? []) {
    if (!policy.PolicyArn || !policy.PolicyName) continue;
    const document = await managedDocument(iam, policy.PolicyArn, policyCache);
    if (document) policies.push({ name: policy.PolicyName, sourceType: "managed", document });
  }
  const groups = await withBackoff(() =>
    iam.send(new ListGroupsForUserCommand({ UserName: user.userName }))
  );
  for (const group of groups.Groups ?? []) {
    if (!group.GroupName) continue;
    const groupInline = await withBackoff(() =>
      iam.send(new ListGroupPoliciesCommand({ GroupName: group.GroupName }))
    );
    for (const name of groupInline.PolicyNames ?? []) {
      const got = await withBackoff(() =>
        iam.send(new GetGroupPolicyCommand({ GroupName: group.GroupName, PolicyName: name }))
      );
      const document = parsePolicy(got.PolicyDocument);
      if (document) policies.push({ name: `${group.GroupName}/${name}`, sourceType: "group-inline", document });
    }
    const groupAttached = await withBackoff(() =>
      iam.send(new ListAttachedGroupPoliciesCommand({ GroupName: group.GroupName }))
    );
    for (const policy of groupAttached.AttachedPolicies ?? []) {
      if (!policy.PolicyArn || !policy.PolicyName) continue;
      const document = await managedDocument(iam, policy.PolicyArn, policyCache);
      if (document) policies.push({ name: `${group.GroupName}/${policy.PolicyName}`, sourceType: "group-managed", document });
    }
  }

  const mentionsSession = policies.some((policy) => allowsStartSession(policy.document));
  const hadSession = sessions.has(user.userName.toLowerCase()) || trail.has(user.userName.toLowerCase()) || sessions.has(user.arn.toLowerCase());
  if (!mentionsSession && !hadSession) return null;

  let boundary: NamedPolicy | null = null;
  const detail = await withBackoff(() => iam.send(new GetUserCommand({ UserName: user.userName })));
  const boundaryArn = detail.User?.PermissionsBoundary?.PermissionsBoundaryArn;
  if (boundaryArn) {
    const document = await managedDocument(iam, boundaryArn, policyCache);
    if (document) {
      boundary = {
        name: boundaryArn.split("/").pop() ?? boundaryArn,
        sourceType: "boundary",
        document,
      };
    }
  }

  const evaluated = evaluateSsmAccess(policies, boundary, instances);
  const activity = activityFor(user, sessions, trail, instances, historyOk);
  if (activity.forwardedHost) {
    evaluated.notes.push(
      "Last session used port forwarding. The remote host is not an SSM instance target."
    );
  }
  return {
    population: "ssm",
    id: user.userName,
    userName: user.userName,
    arn: user.arn,
    activity,
    instances: evaluated.instances,
    unrestricted: evaluated.unrestricted,
    inactive: isInactive(activity),
    evidence: evaluated.evidence,
    notes: evaluated.notes,
    crossLink: null,
  };
}

async function managedDocument(
  iam: IAMClient,
  arn: string,
  cache: Map<string, PolicyDocument | null>
): Promise<PolicyDocument | null> {
  if (cache.has(arn)) return cache.get(arn) ?? null;
  const meta = await withBackoff(() => iam.send(new GetPolicyCommand({ PolicyArn: arn })));
  const version = meta.Policy?.DefaultVersionId;
  if (!version) {
    cache.set(arn, null);
    return null;
  }
  const got = await withBackoff(() =>
    iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: version }))
  );
  const document = parsePolicy(got.PolicyVersion?.Document);
  cache.set(arn, document);
  return document;
}

function activityFor(
  user: { userName: string; arn: string; aliases?: string[] },
  sessions: Map<string, SessionHit>,
  trail: Map<string, SessionHit>,
  instances: LiveInstance[],
  historyOk: boolean
): Activity {
  const keys = Array.from(new Set([user.userName.toLowerCase(), user.arn.toLowerCase(), ...(user.aliases ?? [])]));
  const candidates = keys
    .flatMap((key) => [sessions.get(key), trail.get(key)].filter(Boolean) as SessionHit[])
    .filter((item) => item.kind === "session");
  if (!candidates.length) {
    return {
      at: null,
      status: historyOk ? "known" : "unavailable",
      targetInstanceId: null,
      targetName: null,
      forwardedHost: null,
      source: historyOk ? "none" : "unavailable",
      note: historyOk ? null : "Session history could not be read.",
    };
  }
  candidates.sort((a, b) => (a.at < b.at ? 1 : -1));
  const latest = candidates[0];
  const named = instances.find((item) => item.id === latest.instanceId);
  const sources = new Set(candidates.filter((item) => item.at === latest.at).map((item) => item.source));
  return {
    at: latest.at,
    status: "known",
    targetInstanceId: latest.instanceId || null,
    targetName: named?.name ?? (latest.instanceId || null),
    forwardedHost: latest.forwardedHost,
    source: sources.size > 1 ? "both" : latest.source,
    kind: "session",
    note: latest.forwardedHost
      ? `Port forwarding to ${latest.forwardedHost}. DescribeSessions does not return the remote host; this came from CloudTrail.`
      : null,
  };
}

async function listSso(
  iam: IAMClient,
  callerAccount: string,
  instances: LiveInstance[],
  ssmSessions: Map<string, SessionHit>,
  trailSessions: Map<string, SessionHit>,
  signins: Map<string, SessionHit>,
  trailOk: boolean,
  sessionsOk: boolean,
  warnings: string[]
): Promise<{ users: SsoUserRow[]; sessionUsers: SsmUserRow[] }> {
  const home = requireAccount().region;
  const tryRegions = Array.from(new Set([home, "us-east-1", "ap-south-1", "eu-west-1", "us-west-2"]));
  let instanceArn = "";
  let identityStoreId = "";
  let ssoRegion = home;
  for (const region of tryRegions) {
    try {
      const admin = new SSOAdminClient(accountClientConfig(region));
      const listed = await withBackoff(() => admin.send(new ListInstancesCommand({})));
      const instance = listed.Instances?.[0];
      if (instance?.InstanceArn && instance.IdentityStoreId) {
        instanceArn = instance.InstanceArn;
        identityStoreId = instance.IdentityStoreId;
        ssoRegion = region;
        break;
      }
    } catch {
      /* try the next region */
    }
  }
  if (!instanceArn) {
    warnings.push("No IAM Identity Center instance was found in the checked regions. The SSO list is empty because Identity Center is not enabled here, not because users were skipped.");
    return { users: [], sessionUsers: [] };
  }

  const admin = new SSOAdminClient(accountClientConfig(ssoRegion));
  const store = new IdentitystoreClient(accountClientConfig(ssoRegion));
  const people = await identityUsers(store, identityStoreId);
  const groups = await identityGroups(store, identityStoreId);
  const accounts = await orgAccounts(callerAccount, warnings);
  const permissionSets = await allPermissionSets(admin, instanceArn);
  const policyCache = new Map<string, PolicyDocument | null>();
  const setDocs = new Map<string, {
    name: string;
    level: SsoAssignment["accessLevel"];
    services: string[] | "all";
    serviceGrants: SsoAssignment["serviceGrants"];
    writeActions: string[];
    notableActions: string[];
    policies: string[];
    unresolved: boolean;
    evidence: string;
    documents: NamedPolicy[];
  }>();

  for (const arn of permissionSets) {
    const described = await withBackoff(() =>
      admin.send(new DescribePermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn }))
    );
    const name = described.PermissionSet?.Name ?? arn;
    const inlineRaw = await withBackoff(() =>
      admin.send(new GetInlinePolicyForPermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn }))
    );
    const documents: NamedPolicy[] = [];
    const inlineDoc = parsePolicy(inlineRaw.InlinePolicy);
    const actions = actionsFromDocument(inlineDoc);
    const policies: string[] = [];
    if (actions.length && inlineDoc) {
      policies.push("Inline policy");
      documents.push({ name: `${name} inline policy`, sourceType: "permission-set", document: inlineDoc });
    }
    let unresolved = false;
    const managed = await withBackoff(() =>
      admin.send(new ListManagedPoliciesInPermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn }))
    );
    for (const policy of managed.AttachedManagedPolicies ?? []) {
      if (!policy.Arn || !policy.Name) continue;
      policies.push(policy.Name);
      let document: PolicyDocument | null = null;
      try {
        document = await managedDocument(iam, policy.Arn, policyCache);
      } catch {
        document = null;
      }
      const judged = levelForManagedPolicy(policy.Name, document ? actionsFromDocument(document) : null);
      if (judged.unresolved) unresolved = true;
      if (document) {
        actions.push(...actionsFromDocument(document));
        documents.push({ name: policy.Name, sourceType: "managed", document });
      }
    }
    const customer = await withBackoff(() =>
      admin.send(
        new ListCustomerManagedPolicyReferencesInPermissionSetCommand({
          InstanceArn: instanceArn,
          PermissionSetArn: arn,
        })
      )
    );
    for (const ref of customer.CustomerManagedPolicyReferences ?? []) {
      if (!ref.Name) continue;
      policies.push(ref.Name);
      unresolved = true;
      warnings.push(`Customer managed policy ${ref.Name} on ${name} was not expanded. Access is treated as Read/Write so it is not understated.`);
    }
    const access = describeAccess(actions);
    const level = unresolved ? "read-write" : access.level;
    const services = access.grants === "all" ? "all" : access.grants.map((item) => item.name);
    setDocs.set(arn, {
      name,
      level,
      services,
      serviceGrants: access.grants,
      writeActions: access.writeActions,
      notableActions: access.notableActions,
      policies,
      unresolved,
      documents,
      evidence: unresolved
        ? "One attached policy could not be read and is treated as Read/Write."
        : access.writeActions.length
          ? `${access.writeActions.length} actions can change a resource.`
          : "No action creates, changes, or deletes a resource.",
    });
  }

  const byUser = new Map<string, SsoUserRow>();
  const docsByUser = new Map<string, NamedPolicy[]>();
  for (const person of people) {
    byUser.set(person.id, {
      population: "sso",
      id: person.id,
      userName: person.userName,
      displayName: person.displayName,
      email: person.email,
      activity: emptyActivity(),
      accessLevel: "none",
      services: [],
      servicePreview: "None",
      assignments: [],
      inactive: true,
      orphaned: false,
      evidence: [],
      notes: [],
      crossLink: null,
    });
  }

  for (const account of accounts) {
    for (const permissionSetArn of permissionSets) {
      let token: string | undefined;
      do {
        const page = await withBackoff(() =>
          admin.send(
            new ListAccountAssignmentsCommand({
              InstanceArn: instanceArn,
              AccountId: account.id,
              PermissionSetArn: permissionSetArn,
              NextToken: token,
              MaxResults: 100,
            })
          )
        );
        for (const assignment of page.AccountAssignments ?? []) {
          const doc = setDocs.get(permissionSetArn);
          if (!doc || !assignment.PrincipalId) continue;
          const principalIds =
            assignment.PrincipalType === "GROUP"
              ? groups.members.get(assignment.PrincipalId) ?? []
              : [assignment.PrincipalId];
          if (assignment.PrincipalType === "GROUP" && principalIds.length === 0) {
            warnings.push(`Group ${assignment.PrincipalId} in account ${account.id} has an assignment but no members.`);
          }
          if (assignment.PrincipalType === "USER" && !byUser.has(assignment.PrincipalId)) {
            byUser.set(assignment.PrincipalId, orphanRow(assignment.PrincipalId));
          }
          for (const principalId of principalIds) {
            const row = byUser.get(principalId) ?? orphanRow(principalId);
            byUser.set(principalId, row);
            const item: SsoAssignment = {
              accountId: account.id,
              accountName: account.name,
              permissionSetName: doc.name,
              accessLevel: doc.level,
              services: doc.services,
              serviceGrants: doc.serviceGrants,
              writeActions: doc.writeActions,
              notableActions: doc.notableActions,
              policies: doc.policies,
              via: assignment.PrincipalType === "GROUP" ? "group" : "user",
              groupName:
                    assignment.PrincipalType === "GROUP"
                      ? groups.names.get(assignment.PrincipalId) ?? assignment.PrincipalId
                      : null,
              unresolved: doc.unresolved,
            };
            row.assignments.push(item);
            const priorDocs = docsByUser.get(principalId) ?? [];
            docsByUser.set(principalId, priorDocs.concat(setDocs.get(permissionSetArn)?.documents ?? []));
            row.evidence.push({
              sourceType: "permission-set",
              name: doc.name,
              effect: "Allow",
              detail: `${account.name} (${account.id}) · ${item.via}${item.groupName ? ` ${item.groupName}` : ""} · ${doc.evidence}`,
            });
          }
        }
        token = page.NextToken;
      } while (token);
    }
  }

  const historyOk = trailOk || sessionsOk;
  const users = Array.from(byUser.values());
  for (const user of users) {
    const keys = personKeys(user.userName, user.email);
    const signin = latestHit(signins, keys);
    const session = newerHit(latestHit(ssmSessions, keys), latestHit(trailSessions, keys));
    const picked = pickActivity(
      [
        ...(signin ? [{ at: signin.at, kind: "signin" as const }] : []),
        ...(session ? [{ at: session.at, kind: "session" as const }] : []),
      ],
      historyOk
    );
    if (user.orphaned) {
      user.activity = { ...emptyActivity(), status: "unavailable", source: "unavailable" };
    } else if (!historyOk) {
      user.activity = {
        at: null,
        status: "unavailable",
        targetInstanceId: null,
        targetName: null,
        forwardedHost: null,
        source: "unavailable",
        kind: null,
        note: "Sign-in and session history could not be read, so this is not recorded as Never.",
      };
    } else if (picked.kind === "session" && session) {
      const named = instances.find((item) => item.id === session.instanceId);
      user.activity = {
        at: session.at,
        status: "known",
        targetInstanceId: session.instanceId || null,
        targetName: named?.name ?? (session.instanceId || null),
        forwardedHost: session.forwardedHost,
        source: session.source,
        kind: "session",
        note: "Session Manager session. CloudTrail can lag about 15 minutes. LookupEvents searches the last 90 days in the home region and us-east-1.",
      };
    } else if (picked.kind === "signin" && signin) {
      user.activity = {
        at: signin.at,
        status: "known",
        targetInstanceId: null,
        targetName: null,
        forwardedHost: null,
        source: "cloudtrail",
        kind: "signin",
        note: "CloudTrail ConsoleLogin or UserAuthentication. Events can lag about 15 minutes and only the last 90 days are searched.",
      };
    } else {
      user.activity = emptyActivity();
    }
    user.inactive = isInactive(user.activity);
    user.accessLevel = highestLevel(user.assignments.map((item) => item.accessLevel));
    user.services = combineServices(user.assignments.map((item) => item.services));
    user.servicePreview = previewServices(user.services);
    if (user.assignments.length === 0) user.notes.push("No account assignments.");
  }
  const sessionUsers = users
    .map((user) => identityCenterSsmRow(user, docsByUser.get(user.id) ?? [], instances, ssmSessions, trailSessions, historyOk))
    .filter((row): row is SsmUserRow => row !== null);
  return { users, sessionUsers };
}

function personKeys(...names: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    for (const key of ownerKeys(name)) keys.add(key);
    const local = name.split("@")[0]?.trim().toLowerCase();
    if (local && local.length > 2 && local !== name.toLowerCase()) keys.add(local);
  }
  return Array.from(keys);
}

function latestHit(hits: Map<string, SessionHit>, keys: string[]): SessionHit | null {
  let best: SessionHit | null = null;
  for (const key of keys) {
    const hit = hits.get(key);
    if (hit && (!best || best.at < hit.at)) best = hit;
  }
  return best;
}

function newerHit(left: SessionHit | null, right: SessionHit | null): SessionHit | null {
  if (!left) return right;
  if (!right) return left;
  return left.at >= right.at ? left : right;
}

function identityCenterSsmRow(
  user: SsoUserRow,
  documents: NamedPolicy[],
  instances: LiveInstance[],
  ssmSessions: Map<string, SessionHit>,
  trailSessions: Map<string, SessionHit>,
  historyOk: boolean
): SsmUserRow | null {
  if (user.orphaned) return null;
  const allowed = documents.some((policy) => allowsStartSession(policy.document));
  const keys = personKeys(user.userName, user.email, user.displayName);
  const session = newerHit(latestHit(ssmSessions, keys), latestHit(trailSessions, keys));
  if (!allowed && !session) return null;
  const evaluated = documents.length
    ? evaluateSsmAccess(documents, null, instances)
    : { instances: [] as InstanceGrant[], unrestricted: false, evidence: [], notes: [] as string[] };
  const activity = activityFor(
    { userName: user.email || user.userName, arn: user.id, aliases: keys },
    ssmSessions,
    trailSessions,
    instances,
    historyOk
  );
  return {
    population: "ssm",
    origin: "identity-center",
    id: `identity-center:${user.id}`,
    userName: user.email || user.displayName || user.userName,
    arn: user.email || user.userName,
    activity,
    instances: evaluated.instances,
    unrestricted: evaluated.unrestricted,
    inactive: isInactive(activity),
    evidence: evaluated.evidence,
    notes: evaluated.notes,
    crossLink: null,
  };
}

function emptyActivity(): Activity {
  return {
    at: null,
    status: "known",
    targetInstanceId: null,
    targetName: null,
    forwardedHost: null,
    source: "none",
    kind: null,
    note: null,
  };
}

function orphanRow(principalId: string): SsoUserRow {
  return {
    population: "sso",
    id: principalId,
    userName: `Unknown principal ${principalId}`,
    displayName: "Unknown principal",
    email: "",
    activity: emptyActivity(),
    accessLevel: "none",
    services: [],
    servicePreview: "None",
    assignments: [],
    inactive: false,
    orphaned: true,
    evidence: [],
    notes: ["Orphaned assignment. The principal is no longer in Identity Center, and the row was kept."],
    crossLink: null,
  };
}

function combineServices(lists: (string[] | "all")[]): string[] | "all" {
  if (lists.some((item) => item === "all")) return "all";
  return Array.from(new Set(lists.flatMap((item) => (item === "all" ? [] : item)))).sort((a, b) =>
    a.localeCompare(b)
  );
}

async function identityUsers(store: IdentitystoreClient, identityStoreId: string) {
  const users: { id: string; userName: string; displayName: string; email: string }[] = [];
  let token: string | undefined;
  do {
    const page = await withBackoff(() =>
      store.send(new ListIdentityUsersCommand({ IdentityStoreId: identityStoreId, NextToken: token, MaxResults: 100 }))
    );
    for (const user of page.Users ?? []) {
      if (!user.UserId) continue;
      const email = user.Emails?.find((item) => item.Primary)?.Value ?? user.Emails?.[0]?.Value ?? "";
      users.push({
        id: user.UserId,
        userName: user.UserName ?? email ?? user.UserId,
        displayName: user.DisplayName ?? user.UserName ?? email,
        email,
      });
    }
    token = page.NextToken;
  } while (token);
  return users;
}

async function identityGroups(store: IdentitystoreClient, identityStoreId: string) {
  const memberships = new Map<string, string[]>();
  const names = new Map<string, string>();
  let token: string | undefined;
  const groups: { id: string }[] = [];
  do {
    const page = await withBackoff(() =>
      store.send(new ListGroupsCommand({ IdentityStoreId: identityStoreId, NextToken: token, MaxResults: 100 }))
    );
    for (const group of page.Groups ?? []) {
      if (!group.GroupId) continue;
      groups.push({ id: group.GroupId });
      names.set(group.GroupId, group.DisplayName ?? group.GroupId);
    }
    token = page.NextToken;
  } while (token);
  await mapPool(groups, 4, async (group) => {
    const members: string[] = [];
    let next: string | undefined;
    do {
      const page = await withBackoff(() =>
        store.send(
          new ListGroupMembershipsCommand({
            IdentityStoreId: identityStoreId,
            GroupId: group.id,
            NextToken: next,
            MaxResults: 100,
          })
        )
      );
      for (const member of page.GroupMemberships ?? []) {
        const userId = member.MemberId?.UserId;
        if (userId) members.push(userId);
      }
      next = page.NextToken;
    } while (next);
    memberships.set(group.id, members);
  });
  return { members: memberships, names };
}

async function orgAccounts(callerAccount: string, warnings: string[]) {
  try {
    const org = new OrganizationsClient(accountClientConfig("us-east-1"));
    const accounts: { id: string; name: string }[] = [];
    let token: string | undefined;
    do {
      const page = await withBackoff(() => org.send(new ListAccountsCommand({ NextToken: token })));
      for (const account of page.Accounts ?? []) {
        if (account.Id && account.Status !== "SUSPENDED") {
          accounts.push({ id: account.Id, name: account.Name ?? account.Id });
        }
      }
      token = page.NextToken;
    } while (token);
    return accounts.length ? accounts : [{ id: callerAccount, name: "This account" }];
  } catch {
    warnings.push("Organizations ListAccounts was denied. Assignments are scanned in this account only.");
    return [{ id: callerAccount, name: "This account" }];
  }
}

async function allPermissionSets(admin: SSOAdminClient, instanceArn: string) {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const page = await withBackoff(() =>
      admin.send(new ListPermissionSetsCommand({ InstanceArn: instanceArn, NextToken: token, MaxResults: 100 }))
    );
    arns.push(...(page.PermissionSets ?? []));
    token = page.NextToken;
  } while (token);
  return arns;
}
