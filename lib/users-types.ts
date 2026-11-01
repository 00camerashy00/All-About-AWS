export type Population = "ssm" | "sso";
export type AccessLevel = "read-write" | "read-only" | "none";
export type ActivityStatus = "known" | "unavailable";

export interface Activity {
  at: string | null;
  status: ActivityStatus;
  targetInstanceId: string | null;
  targetName: string | null;
  forwardedHost: string | null;
  source: "ssm" | "cloudtrail" | "both" | "none" | "unavailable";
  note: string | null;
}

export interface InstanceGrant {
  id: string;
  name: string;
  region: string;
}

export interface Evidence {
  sourceType:
    | "inline"
    | "managed"
    | "group-inline"
    | "group-managed"
    | "boundary"
    | "permission-set"
    | "deny";
  name: string;
  effect: "Allow" | "Deny";
  detail: string;
}

export interface SsmUserRow {
  population: "ssm";
  id: string;
  userName: string;
  arn: string;
  activity: Activity;
  instances: InstanceGrant[] | "all";
  unrestricted: boolean;
  inactive: boolean;
  evidence: Evidence[];
  notes: string[];
  crossLink: { population: "sso"; label: string } | null;
}

export interface ServiceGrant {
  name: string;
  read: boolean;
  write: boolean;
}

export interface SsoAssignment {
  accountId: string;
  accountName: string;
  permissionSetName: string;
  accessLevel: AccessLevel;
  services: string[] | "all";
  serviceGrants?: ServiceGrant[] | "all";
  writeActions?: string[];
  notableActions?: string[];
  policies?: string[];
  via: "user" | "group";
  groupName: string | null;
  unresolved: boolean;
}

export interface SsoUserRow {
  population: "sso";
  id: string;
  userName: string;
  displayName: string;
  email: string;
  activity: Activity;
  accessLevel: AccessLevel;
  services: string[] | "all";
  servicePreview: string;
  assignments: SsoAssignment[];
  inactive: boolean;
  orphaned: boolean;
  evidence: Evidence[];
  notes: string[];
  crossLink: { population: "ssm"; label: string } | null;
}

export interface UsersPayload {
  live: boolean;
  asOf: string;
  warnings: string[];
  scpNote: string;
  ssm: SsmUserRow[];
  sso: SsoUserRow[];
  instances: InstanceGrant[];
}

export const SCP_NOTE =
  "Service control policies are not evaluated. Effective access can be narrower than this page shows.";
