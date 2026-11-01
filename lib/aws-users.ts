import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  GetGroupPolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetUserCommand,
  GetUserPolicyCommand,
  IAMClient,
  ListAttachedGroupPoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupPoliciesCommand,
  ListGroupsForUserCommand,
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
  previewServices,
  type NamedPolicy,
  type PolicyDocument,
} from "@/lib/users-logic";
import type { Activity, SsmUserRow, SsoAssignment, SsoUserRow, UsersPayload } from "@/lib/users-types";
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
  const ssoResult = await listSso(iam, accountId, trailResult.hits, trailResult.ok, warnings).catch((error: unknown) => {
    warnings.push(`SSO scan failed: ${(error as { name?: string }).name ?? "error"}. No SSO users were invented to fill the gap.`);
    return { users: [] as SsoUserRow[] };
  });

  const ssm = await listSsmUsers(iam, instances, sessionResult.hits, trailResult.hits, historyOk, warnings);
  linkPopulations(ssm, ssoResult.users);
  ssm.sort((a, b) => a.userName.localeCompare(b.userName));
  ssoResult.users.sort((a, b) => a.userName.localeCompare(b.userName));

  return {
    live: true,
    asOf: new Date().toISOString(),
    warnings,
    scpNote: SCP_NOTE,
    ssm,
    sso: ssoResult.users,
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

async function listTrailHits(warnings: string[]): Promise<{ hits: Map<string, SessionHit>; ok: boolean }> {
  const hits = new Map<string, SessionHit>();
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
          for (const event of result.Events ?? []) rememberTrail(hits, event);
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
    return { hits, ok: false };
  }
  return { hits, ok: true };
}

function rememberTrail(hits: Map<string, SessionHit>, event: Event) {
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
  if (event.EventName !== "StartSession") {
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
    kind: event.EventName === "StartSession" ? "session" : "signin",
  };
  for (const key of ownerKeys(event.Username)) {
    const prev = hits.get(key);
    if (!prev || prev.at < hit.at) hits.set(key, hit);
  }
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
  user: { userName: string; arn: string },
  sessions: Map<string, SessionHit>,
  trail: Map<string, SessionHit>,
  instances: LiveInstance[],
  historyOk: boolean
): Activity {
  const keys = [user.userName.toLowerCase(), user.arn.toLowerCase()];
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
    note: latest.forwardedHost
      ? `Port forwarding to ${latest.forwardedHost}. DescribeSessions does not return the remote host; this came from CloudTrail.`
      : null,
  };
}

async function listSso(
  iam: IAMClient,
  callerAccount: string,
  trail: Map<string, SessionHit>,
  trailOk: boolean,
  warnings: string[]
): Promise<{ users: SsoUserRow[] }> {
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
    return { users: [] };
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
  }>();

  for (const arn of permissionSets) {
    const described = await withBackoff(() =>
      admin.send(new DescribePermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn }))
    );
    const name = described.PermissionSet?.Name ?? arn;
    const inlineRaw = await withBackoff(() =>
      admin.send(new GetInlinePolicyForPermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn }))
    );
    const actions = actionsFromDocument(parsePolicy(inlineRaw.InlinePolicy));
    const policies: string[] = [];
    if (actions.length) policies.push("Inline policy");
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
      if (document) actions.push(...actionsFromDocument(document));
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
      evidence: unresolved
        ? "One attached policy could not be read and is treated as Read/Write."
        : access.writeActions.length
          ? `${access.writeActions.length} actions can change a resource.`
          : "No action creates, changes, or deletes a resource.",
    });
  }

  const byUser = new Map<string, SsoUserRow>();
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

  const users = Array.from(byUser.values());
  for (const user of users) {
    const hit = [user.userName, user.email]
      .map((key) => trail.get(key.toLowerCase()))
      .find((item) => item?.kind === "signin");
    if (user.orphaned) {
      user.activity = { ...emptyActivity(), status: "unavailable", source: "unavailable" };
    } else if (!trailOk) {
      user.activity = {
        at: null,
        status: "unavailable",
        targetInstanceId: null,
        targetName: null,
        forwardedHost: null,
        source: "unavailable",
        note: "CloudTrail could not be searched, so this is not recorded as Never.",
      };
    } else if (hit) {
      user.activity = {
        at: hit.at,
        status: "known",
        targetInstanceId: null,
        targetName: null,
        forwardedHost: null,
        source: "cloudtrail",
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
  return { users };
}

function emptyActivity(): Activity {
  return {
    at: null,
    status: "known",
    targetInstanceId: null,
    targetName: null,
    forwardedHost: null,
    source: "none",
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
