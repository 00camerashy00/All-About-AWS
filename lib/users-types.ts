export type Population = "ssm" | "sso" | "iam";
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
  /** Newest event used for this row. Absent on older demo rows. */
  kind?: "signin" | "session" | null;
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
  /** IAM users omit this. Identity Center rows stay in this list and are not merged into an IAM user. */
  origin?: "iam" | "identity-center";
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

export type IamPolicyType = "AWS managed" | "Customer managed" | "Inline";

export interface IamPolicyAttachment {
  name: string;
  arn: string | null;
  type: IamPolicyType;
  /** "Directly", or the group name the policy comes through. */
  attachedVia: string;
}

export interface IamGroupMembership {
  name: string;
  arn: string;
  createdAt: string | null;
  policies: string[];
}

export interface IamTag {
  key: string;
  value: string;
}

export interface IamAccessKey {
  id: string;
  status: "Active" | "Inactive";
  createdAt: string | null;
  lastUsedAt: string | null;
  lastUsedRegion: string | null;
  lastUsedService: string | null;
}

export interface IamServiceAccess {
  service: string;
  lastAccessed: string | null;
  region: string | null;
}

export interface IamUserRow {
  population: "iam";
  id: string;
  userName: string;
  arn: string;
  activity: Activity;
  groups: IamGroupMembership[];
  policies: IamPolicyAttachment[];
  permissionsBoundary: string | null;
  tags: IamTag[];
  passwordEnabled: boolean | null;
  passwordLastUsed: string | null;
  mfaDevices: string[];
  accessKeys: IamAccessKey[];
  lastAccessed: IamServiceAccess[];
  lastAccessedStatus: ActivityStatus;
  inactive: boolean;
}

export interface IamRoleRow {
  population: "role";
  id: string;
  roleName: string;
  arn: string;
  trustedEntities: string[];
  lastUsedAt: string | null;
  createdAt: string | null;
}

export interface IamPolicyRow {
  population: "policy";
  id: string;
  name: string;
  arn: string;
  type: "AWS managed" | "Customer managed";
  attachmentCount: number;
  description: string | null;
}

export interface UsersPayload {
  live: boolean;
  asOf: string;
  warnings: string[];
  scpNote: string;
  ssm: SsmUserRow[];
  sso: SsoUserRow[];
  iam: IamUserRow[];
  roles: IamRoleRow[];
  policies: IamPolicyRow[];
  instances: InstanceGrant[];
}

export const SCP_NOTE =
  "Service control policies are not evaluated. Effective access can be narrower than this page shows.";
