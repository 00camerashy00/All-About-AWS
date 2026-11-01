import type {
  AccessLevel,
  Activity,
  Evidence,
  InstanceGrant,
  ServiceGrant,
  SsmUserRow,
  SsoUserRow,
} from "./users-types";

export const INACTIVE_DAYS = 90;
const DAY = 86_400_000;

const READ_VERBS = [
  "Describe",
  "Get",
  "List",
  "Lookup",
  "View",
  "BatchGet",
  "Search",
  "Head",
  "Select",
  "Check",
  "Estimate",
  "Preview",
  "Query",
  "Scan",
  "Filter",
  "Download",
];

const SERVICE_NAMES: Record<string, string> = {
  ec2: "EC2",
  s3: "S3",
  rds: "RDS",
  iam: "IAM",
  ssm: "SSM",
  logs: "CloudWatch Logs",
  cloudwatch: "CloudWatch",
  cloudtrail: "CloudTrail",
  organizations: "Organizations",
  identitystore: "Identity Center",
  sso: "IAM Identity Center",
  kms: "KMS",
  lambda: "Lambda",
  sts: "STS",
};

export interface PolicyStatement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
  Statement?: PolicyStatement | PolicyStatement[];
}

export interface NamedPolicy {
  name: string;
  sourceType: Evidence["sourceType"];
  document: PolicyDocument;
}

export interface EvalInstance {
  id: string;
  name: string;
  region: string;
  accountId: string;
  tags: Record<string, string>;
}

export interface PermissionEval {
  instances: InstanceGrant[] | "all";
  unrestricted: boolean;
  evidence: Evidence[];
  notes: string[];
}

export function statementsOf(doc: PolicyDocument | null | undefined): PolicyStatement[] {
  if (!doc?.Statement) return [];
  return Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
}

function asList(value?: string | string[]): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" + pattern.toLowerCase().split("*").map(escapeRegExp).join(".*") + "$"
  );
  return re.test(value.toLowerCase());
}

function matchesStartSession(statement: PolicyStatement): boolean {
  const target = "ssm:StartSession";
  const not = asList(statement.NotAction);
  if (not.length) return !not.some((pattern) => globMatch(pattern, target));
  const actions = asList(statement.Action);
  if (!actions.length) return false;
  return actions.some((pattern) => globMatch(pattern, target));
}

function isDocumentOnly(pattern: string): boolean {
  return pattern.toLowerCase().includes(":document/");
}

function isWildcardInstance(pattern: string): boolean {
  const value = pattern.toLowerCase();
  if (value === "*") return true;
  return value.endsWith(":instance/*") || value.endsWith(":managed-instance/*");
}

function instanceArns(instance: EvalInstance): string[] {
  return [
    `arn:aws:ec2:${instance.region}:${instance.accountId}:instance/${instance.id}`,
    `arn:aws:ssm:${instance.region}:${instance.accountId}:managed-instance/${instance.id}`,
  ];
}

function resourceCovers(statement: PolicyStatement, instance: EvalInstance): boolean {
  const resources = asList(statement.Resource);
  const relevant = resources.filter((pattern) => !isDocumentOnly(pattern));
  if (!relevant.length) return false;
  const arns = instanceArns(instance);
  const covered = relevant.some(
    (pattern) => isWildcardInstance(pattern) || arns.some((arn) => globMatch(pattern, arn))
  );
  if (!covered) return false;
  const excluded = asList(statement.NotResource).some(
    (pattern) => isWildcardInstance(pattern) || arns.some((arn) => globMatch(pattern, arn))
  );
  return !excluded;
}

interface TagCond {
  key: string;
  values: string[];
  op: "eq" | "like";
}

function parseConditions(condition?: PolicyStatement["Condition"]): {
  tags: TagCond[];
  unknown: boolean;
} {
  if (!condition || Object.keys(condition).length === 0) return { tags: [], unknown: false };
  const tags: TagCond[] = [];
  let unknown = false;
  for (const [operator, pairs] of Object.entries(condition)) {
    const base = operator.split(":").pop() ?? operator;
    const op = base === "StringLike" ? "like" : base === "StringEquals" || base === "StringEqualsIgnoreCase" ? "eq" : null;
    for (const [key, raw] of Object.entries(pairs)) {
      const tagKey = key.split("/").slice(1).join("/");
      const tagLike = /resourceTag\//i.test(key);
      if (!op || !tagLike || !tagKey) {
        unknown = true;
        continue;
      }
      tags.push({ key: tagKey, values: asList(raw), op });
    }
  }
  return { tags, unknown };
}

function tagsMatch(instance: EvalInstance, tags: TagCond[]): boolean {
  return tags.every((tag) => {
    const value = instance.tags[tag.key];
    if (value == null) return false;
    if (tag.op === "eq") return tag.values.some((item) => item.toLowerCase() === value.toLowerCase());
    return tag.values.some((item) => globMatch(item, value));
  });
}

function isUnrestrictedAllow(statement: PolicyStatement): boolean {
  if ((statement.Effect ?? "Allow").toLowerCase() === "deny") return false;
  if (!matchesStartSession(statement)) return false;
  const resources = asList(statement.Resource).filter((pattern) => !isDocumentOnly(pattern));
  if (!resources.some(isWildcardInstance)) return false;
  const condition = parseConditions(statement.Condition);
  return !condition.unknown && condition.tags.length === 0;
}

function isUnrestrictedDeny(statement: PolicyStatement): boolean {
  if ((statement.Effect ?? "Allow").toLowerCase() !== "deny") return false;
  if (!matchesStartSession(statement)) return false;
  const resources = asList(statement.Resource).filter((pattern) => !isDocumentOnly(pattern));
  if (!resources.some(isWildcardInstance)) return false;
  const condition = parseConditions(statement.Condition);
  return !condition.unknown && condition.tags.length === 0;
}

type Hit = "allow" | "deny" | "unknown" | "none";

function hitOnInstance(statement: PolicyStatement, instance: EvalInstance): Hit {
  if (!matchesStartSession(statement)) return "none";
  if (!resourceCovers(statement, instance)) return "none";
  const condition = parseConditions(statement.Condition);
  if (condition.unknown) return "unknown";
  if (condition.tags.length && !tagsMatch(instance, condition.tags)) return "none";
  return (statement.Effect ?? "Allow").toLowerCase() === "deny" ? "deny" : "allow";
}

function evaluateSide(policies: NamedPolicy[], instance: EvalInstance): {
  allow: boolean;
  deny: boolean;
  unknown: boolean;
  evidence: Evidence[];
} {
  let allow = false;
  let deny = false;
  let unknown = false;
  const evidence: Evidence[] = [];
  for (const policy of policies) {
    for (const statement of statementsOf(policy.document)) {
      const hit = hitOnInstance(statement, instance);
      if (hit === "none") continue;
      if (hit === "unknown") {
        unknown = true;
        evidence.push({
          sourceType: policy.sourceType,
          name: policy.name,
          effect: "Allow",
          detail: "Condition could not be evaluated, so this instance was not granted.",
        });
        continue;
      }
      if (hit === "deny") deny = true;
      if (hit === "allow") allow = true;
      evidence.push({
        sourceType: hit === "deny" ? "deny" : policy.sourceType,
        name: policy.name,
        effect: hit === "deny" ? "Deny" : "Allow",
        detail:
          hit === "deny"
            ? `Explicit deny of ssm:StartSession on ${instance.id}.`
            : `Allows ssm:StartSession on ${instance.name || instance.id}.`,
      });
    }
  }
  return { allow, deny, unknown, evidence };
}

export function evaluateSsmAccess(
  policies: NamedPolicy[],
  boundary: NamedPolicy | null,
  instances: EvalInstance[]
): PermissionEval {
  const notes: string[] = [];
  const evidence: Evidence[] = [];
  const identityDenyAll = policies.some((policy) => statementsOf(policy.document).some(isUnrestrictedDeny));
  const boundaryDenyAll = boundary
    ? statementsOf(boundary.document).some(isUnrestrictedDeny)
    : false;
  const identityAllowAll = policies.some((policy) => statementsOf(policy.document).some(isUnrestrictedAllow));
  const boundaryAllowAll = boundary
    ? statementsOf(boundary.document).some(isUnrestrictedAllow)
    : true;

  if (identityDenyAll || boundaryDenyAll) {
    notes.push("An explicit deny blocks ssm:StartSession on every instance.");
    evidence.push({
      sourceType: "deny",
      name: boundaryDenyAll && boundary ? boundary.name : "Deny",
      effect: "Deny",
      detail: "Wildcard deny of ssm:StartSession.",
    });
    return { instances: [], unrestricted: false, evidence, notes };
  }

  const hasSessionDeny = policies.some((policy) =>
    statementsOf(policy.document).some(
      (statement) =>
        (statement.Effect ?? "Allow").toLowerCase() === "deny" && matchesStartSession(statement)
    )
  );

  if (identityAllowAll && boundaryAllowAll && !boundary && !hasSessionDeny) {
    evidence.push({
      sourceType: policies.find((policy) => statementsOf(policy.document).some(isUnrestrictedAllow))?.sourceType ?? "managed",
      name: policies.find((policy) => statementsOf(policy.document).some(isUnrestrictedAllow))?.name ?? "policy",
      effect: "Allow",
      detail: "ssm:StartSession is allowed on every instance, with no tag condition.",
    });
    return { instances: "all", unrestricted: true, evidence, notes };
  }

  if (identityAllowAll && boundaryAllowAll && boundary && !hasSessionDeny) {
    evidence.push({
      sourceType: "boundary",
      name: boundary.name,
      effect: "Allow",
      detail: "Permissions boundary also allows ssm:StartSession on every instance.",
    });
    return { instances: "all", unrestricted: true, evidence, notes };
  }

  const granted: InstanceGrant[] = [];
  let sawUnknown = false;
  for (const instance of instances) {
    const identity = evaluateSide(policies, instance);
    const limit = boundary ? evaluateSide([boundary], instance) : null;
    evidence.push(...identity.evidence);
    if (limit) evidence.push(...limit.evidence);
    const denied = identity.deny || Boolean(limit?.deny);
    const allowed = identity.allow && (limit ? limit.allow : true) && !denied;
    if (identity.unknown || limit?.unknown) sawUnknown = true;
    if (allowed) {
      granted.push({ id: instance.id, name: instance.name, region: instance.region });
    }
  }
  if (sawUnknown) {
    notes.push("Some statements use conditions this scan could not evaluate. Those instances are not listed.");
  }
  if (boundary && !boundaryAllowAll) {
    notes.push("A permissions boundary further limits which instances can be opened.");
  }
  return { instances: granted, unrestricted: false, evidence: dedupeEvidence(evidence), notes };
}

function dedupeEvidence(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourceType}|${item.name}|${item.effect}|${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const WRITE_VERBS = [
  "Create",
  "Delete",
  "Put",
  "Update",
  "Modify",
  "Terminate",
  "Attach",
  "Detach",
  "Reboot",
  "Run",
  "Write",
  "Tag",
  "Untag",
  "Publish",
  "Enable",
  "Disable",
  "Associate",
  "Disassociate",
  "Authorize",
  "Revoke",
  "Register",
  "Deregister",
  "Import",
  "Add",
  "Remove",
  "Set",
  "Reset",
  "Execute",
  "Redeem",
  "Make",
  "Invoke",
  "Call",
  "Deliver",
  "Start",
  "Stop",
  "Cancel",
  "Receive",
];

// Present in AWS managed ReadOnlyAccess. They are not Get/List/Describe, and they
// do not create, change, or delete a resource, so the write box stays unchecked.
const NOT_A_WRITE = [
  "s3express:CreateSession",
  "config:Deliver*",
  "devops-guru:StartCostEstimation",
  "logs:StartLiveTail",
  "logs:StartQuery",
  "logs:StopLiveTail",
  "logs:StopQuery",
  "servicequotas:StartQuotaUtilizationReport",
  "sqs:Receive*",
  "xray:StartTraceRetrieval",
  "xray:CancelTraceRetrieval",
  "iam:Generate*",
  "iam:Simulate*",
  "eks:AccessKubernetesApi",
  "athena:Batch*",
  "agent-registry:InvokeRegistryMcp",
  "bedrock-mantle:CallWithBearerToken",
  "bedrock:AgenticRetrieveStream",
];

function actionName(action: string): string {
  return action.includes(":") ? action.split(":").slice(1).join(":") : action;
}

function verbStem(action: string): string {
  return actionName(action).replace(/\*/g, "");
}

function startsWithVerb(stem: string, verbs: string[]): boolean {
  const value = stem.toLowerCase();
  return verbs.some((verb) => value.startsWith(verb.toLowerCase()));
}

export function isReadAction(action: string): boolean {
  if (action === "*" || action.endsWith(":*")) return false;
  const name = actionName(action);
  if (!name || name === "*" || name.startsWith("*")) return false;
  const stem = name.replace(/\*/g, "");
  if (/retrieve/i.test(stem)) return true;
  if (/^(get|head)$/i.test(stem)) return true;
  if (/^eshttp(get|head)/i.test(stem)) return true;
  if (/^(gitpull|partiqlselect)/i.test(stem)) return true;
  if (/^is/i.test(stem)) return true;
  return startsWithVerb(stem, [
    ...READ_VERBS,
    "Validate",
    "Verify",
    "Evaluate",
    "Detect",
    "Classify",
    "Contains",
    "Discover",
    "Read",
    "Test",
    "Probe",
    "Compare",
    "Recognize",
    "Resolve",
    "Count",
    "Sample",
    "Export",
    "Generate",
    "Simulate",
    "Synthesize",
    "Request",
    "AdminGet",
    "AdminList",
    "AdminDescribe",
    "BatchCheck",
    "BatchRead",
    "BatchDescribe",
    "BatchDetect",
  ]);
}

function coversEveryService(action: string): boolean {
  if (action === "*" || action === "*:*") return true;
  const prefix = action.split(":")[0];
  return !prefix || prefix === "*";
}

function isBroadWrite(action: string): boolean {
  if (coversEveryService(action)) return true;
  const name = actionName(action);
  return !name || name === "*" || name.startsWith("*") || action.endsWith(":*");
}

function isExcepted(action: string): boolean {
  return NOT_A_WRITE.some((pattern) => globMatch(pattern, action));
}

function isMutating(action: string): boolean {
  return startsWithVerb(verbStem(action), WRITE_VERBS);
}

export type ActionKind = "read" | "write" | "notable";

export function actionKind(action: string): ActionKind {
  if (isBroadWrite(action)) return "write";
  if (isReadAction(action)) return "read";
  if (isExcepted(action)) return "notable";
  if (isMutating(action)) return "write";
  return "notable";
}

function serviceName(action: string): string | "all" {
  if (coversEveryService(action)) return "all";
  const prefix = action.split(":")[0];
  return SERVICE_NAMES[prefix.toLowerCase()] ?? prefix.toUpperCase();
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

export function describeAccess(actions: string[]): {
  level: AccessLevel;
  grants: ServiceGrant[] | "all";
  writeActions: string[];
  notableActions: string[];
} {
  const concrete = actions.filter(Boolean);
  if (!concrete.length) return { level: "none", grants: [], writeActions: [], notableActions: [] };
  const writeActions: string[] = [];
  const notableActions: string[] = [];
  let all = false;
  const map = new Map<string, { read: boolean; write: boolean }>();
  for (const action of concrete) {
    const kind = actionKind(action);
    if (kind === "write") writeActions.push(action);
    if (kind === "notable") notableActions.push(action);
    const service = serviceName(action);
    if (service === "all") {
      all = true;
      continue;
    }
    const current = map.get(service) ?? { read: false, write: false };
    const name = actionName(action);
    if (kind === "write") {
      current.write = true;
      if (action.endsWith(":*") || name === "*" || name.startsWith("*")) current.read = true;
    } else current.read = true;
    map.set(service, current);
  }
  const writes = uniqueActions(writeActions);
  const notable = uniqueActions(notableActions);
  if (all) return { level: "read-write", grants: "all", writeActions: writes, notableActions: notable };
  const grants: ServiceGrant[] = [];
  map.forEach((value, name) => grants.push({ name, read: value.read, write: value.write }));
  grants.sort((a, b) => a.name.localeCompare(b.name));
  const level = writes.length ? "read-write" : grants.length ? "read-only" : "none";
  return { level, grants, writeActions: writes, notableActions: notable };
}

export function allowsStartSession(document: PolicyDocument | null | undefined): boolean {
  return statementsOf(document).some((statement) => {
    if ((statement.Effect ?? "Allow").toLowerCase() === "deny") return false;
    return matchesStartSession(statement);
  });
}

export function servicesFromActions(actions: string[]): string[] | "all" {
  if (actions.some((action) => action === "*" || action === "*:*" || action.endsWith(":*") && action.split(":")[0] === "*")) {
    return "all";
  }
  if (actions.some((action) => action === "*")) return "all";
  const names = new Set<string>();
  for (const action of actions) {
    if (action === "*") return "all";
    const prefix = action.split(":")[0];
    if (!prefix || prefix === "*") return "all";
    names.add(SERVICE_NAMES[prefix.toLowerCase()] ?? prefix.toUpperCase());
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function classifyActions(actions: string[], unresolved = false): AccessLevel {
  if (unresolved) return "read-write";
  return describeAccess(actions).level;
}

export function highestLevel(levels: AccessLevel[]): AccessLevel {
  if (levels.includes("read-write")) return "read-write";
  if (levels.includes("read-only")) return "read-only";
  return "none";
}

export function previewServices(services: string[] | "all"): string {
  if (services === "all") return "All services";
  if (!services.length) return "None";
  if (services.length <= 3) return services.join(", ");
  return `${services.slice(0, 3).join(", ")} +${services.length - 3} more`;
}

export function isInactive(activity: Activity, now = Date.now()): boolean {
  if (activity.status === "unavailable") return false;
  if (!activity.at) return true;
  return now - new Date(activity.at).getTime() > INACTIVE_DAYS * DAY;
}

export type LoginFilter = "any" | "older-30" | "older-60" | "older-90" | "never";

export function matchesLoginFilter(activity: Activity, filter: LoginFilter, now = Date.now()): boolean {
  if (filter === "any") return true;
  if (activity.status === "unavailable") return false;
  if (filter === "never") return activity.at == null;
  const days = filter === "older-30" ? 30 : filter === "older-60" ? 60 : 90;
  if (!activity.at) return false;
  return now - new Date(activity.at).getTime() > days * DAY;
}

export function linkPopulations(ssm: SsmUserRow[], sso: SsoUserRow[]): void {
  const ssoByKey = new Map<string, SsoUserRow>();
  for (const user of sso) {
    if (user.orphaned) continue;
    ssoByKey.set(user.userName.toLowerCase(), user);
    const local = user.email.split("@")[0]?.toLowerCase();
    if (local) ssoByKey.set(local, user);
  }
  for (const user of ssm) {
    const match = ssoByKey.get(user.userName.toLowerCase());
    if (!match) continue;
    user.crossLink = { population: "sso", label: match.email || match.displayName || match.userName };
    match.crossLink = { population: "ssm", label: user.userName };
  }
}

export function actionsFromDocument(document: PolicyDocument | null | undefined): string[] {
  const actions: string[] = [];
  for (const statement of statementsOf(document)) {
    if ((statement.Effect ?? "Allow").toLowerCase() === "deny") continue;
    actions.push(...asList(statement.Action));
  }
  return actions;
}

export const KNOWN_READ_ONLY_POLICIES = new Set([
  "ReadOnlyAccess",
  "ViewOnlyAccess",
  "SecurityAudit",
  "AWSBillingReadOnlyAccess",
]);

export function levelForManagedPolicy(name: string, actions: string[] | null): {
  level: AccessLevel;
  unresolved: boolean;
} {
  if (actions) return { level: classifyActions(actions), unresolved: false };
  if (KNOWN_READ_ONLY_POLICIES.has(name)) return { level: "read-only", unresolved: false };
  if (/FullAccess$|Administrator|PowerUser/i.test(name)) return { level: "read-write", unresolved: false };
  return { level: "read-write", unresolved: true };
}
