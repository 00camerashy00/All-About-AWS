import { isInactive, linkPopulations, previewServices } from "@/lib/users-logic";
import type { Activity, IamPolicyRow, IamRoleRow, IamUserRow, InstanceGrant, SsmUserRow, SsoUserRow, UsersPayload } from "@/lib/users-types";
import { SCP_NOTE } from "@/lib/users-types";

const INSTANCES: InstanceGrant[] = [
  { id: "i-webprod1", name: "web-prod-1", region: "ap-south-1" },
  { id: "i-webprod2", name: "web-prod-2", region: "ap-south-1" },
  { id: "i-worker1", name: "worker-batch-1", region: "ap-south-1" },
  { id: "i-staging1", name: "api-staging-1", region: "us-east-1" },
];

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function activity(partial: Partial<Activity> & Pick<Activity, "at" | "status">): Activity {
  return {
    targetInstanceId: null,
    targetName: null,
    forwardedHost: null,
    source: partial.status === "unavailable" ? "unavailable" : partial.at ? "ssm" : "none",
    note: null,
    ...partial,
  };
}

function demoSsm(): SsmUserRow[] {
  const rows: SsmUserRow[] = [
    {
      population: "ssm",
      id: "ashish.ops",
      userName: "ashish.ops",
      arn: "arn:aws:iam::123456789012:user/ashish.ops",
      activity: activity({
        at: hoursAgo(2),
        status: "known",
        targetInstanceId: "i-webprod1",
        targetName: "web-prod-1",
        source: "both",
      }),
      instances: [INSTANCES[0], INSTANCES[1]],
      unrestricted: false,
      inactive: false,
      evidence: [
        {
          sourceType: "group-managed",
          name: "ssm-web-operators",
          effect: "Allow",
          detail: "Allows ssm:StartSession on web-prod-1 and web-prod-2.",
        },
      ],
      notes: [],
      crossLink: null,
    },
    {
      population: "ssm",
      id: "neha.session",
      userName: "neha.session",
      arn: "arn:aws:iam::123456789012:user/neha.session",
      activity: activity({
        at: daysAgo(5),
        status: "known",
        targetInstanceId: "i-staging1",
        targetName: "api-staging-1",
        source: "ssm",
      }),
      instances: "all",
      unrestricted: true,
      inactive: false,
      evidence: [
        {
          sourceType: "managed",
          name: "AmazonSSMFullAccess",
          effect: "Allow",
          detail: "ssm:StartSession is allowed on every instance, with no tag condition.",
        },
      ],
      notes: [],
      crossLink: null,
    },
    {
      population: "ssm",
      id: "rahul.bastion",
      userName: "rahul.bastion",
      arn: "arn:aws:iam::123456789012:user/rahul.bastion",
      activity: activity({
        at: daysAgo(40),
        status: "known",
        targetInstanceId: "i-worker1",
        targetName: "worker-batch-1",
        forwardedHost: "orders-db.cluster-xxxx.ap-south-1.rds.amazonaws.com",
        source: "cloudtrail",
        note: "Last session used port forwarding. RDS is not an SSM session target; the remote host is taken from CloudTrail when the document was AWS-StartPortForwardingSessionToRemoteHost.",
      }),
      instances: [INSTANCES[2]],
      unrestricted: false,
      inactive: false,
      evidence: [
        {
          sourceType: "inline",
          name: "data-team-sessions",
          effect: "Allow",
          detail: "Allows ssm:StartSession when aws:ResourceTag/Team is data.",
        },
      ],
      notes: ["Tag condition Team=data."],
      crossLink: null,
    },
    {
      population: "ssm",
      id: "old-contractor",
      userName: "old-contractor",
      arn: "arn:aws:iam::123456789012:user/old-contractor",
      activity: activity({
        at: daysAgo(120),
        status: "known",
        targetInstanceId: "i-webprod1",
        targetName: "web-prod-1",
        source: "cloudtrail",
      }),
      instances: [],
      unrestricted: false,
      inactive: true,
      evidence: [
        {
          sourceType: "managed",
          name: "AmazonSSMFullAccess",
          effect: "Allow",
          detail: "Managed policy would allow every instance.",
        },
        {
          sourceType: "deny",
          name: "deny-sessions",
          effect: "Deny",
          detail: "Explicit deny of ssm:StartSession on every instance.",
        },
      ],
      notes: ["Still listed because a policy mentions ssm:StartSession. Effective access is none."],
      crossLink: null,
    },
    {
      population: "ssm",
      id: "ops-bot",
      userName: "ops-bot",
      arn: "arn:aws:iam::123456789012:user/ops-bot",
      activity: activity({ at: null, status: "known", source: "none" }),
      instances: [INSTANCES[3]],
      unrestricted: false,
      inactive: true,
      evidence: [
        {
          sourceType: "inline",
          name: "staging-only",
          effect: "Allow",
          detail: "Allows ssm:StartSession on api-staging-1.",
        },
      ],
      notes: [],
      crossLink: null,
    },
  ];
  for (const row of rows) row.inactive = isInactive(row.activity);
  return rows;
}

function demoSso(): SsoUserRow[] {
  const rows: SsoUserRow[] = [
    {
      population: "sso",
      id: "u-ashish",
      userName: "ashish.ops",
      displayName: "Ashish Ops",
      email: "ashish.ops@example.com",
      activity: activity({ at: hoursAgo(6), status: "known", source: "cloudtrail" }),
      accessLevel: "read-write",
      services: ["EC2", "RDS", "S3"],
      servicePreview: previewServices(["EC2", "RDS", "S3"]),
      assignments: [
        {
          accountId: "123456789012",
          accountName: "Production",
          permissionSetName: "PlatformAdmin",
          accessLevel: "read-write",
          services: ["EC2", "RDS", "S3"],
          via: "user",
          groupName: null,
          unresolved: false,
        },
      ],
      inactive: false,
      orphaned: false,
      evidence: [
        {
          sourceType: "permission-set",
          name: "PlatformAdmin",
          effect: "Allow",
          detail: "Production · direct assignment · includes s3:PutObject.",
        },
      ],
      notes: [],
      crossLink: null,
    },
    {
      population: "sso",
      id: "u-sara",
      userName: "sara.audit",
      displayName: "Sara Audit",
      email: "sara.audit@example.com",
      activity: activity({ at: daysAgo(12), status: "known", source: "cloudtrail" }),
      accessLevel: "read-only",
      services: ["CloudTrail", "CloudWatch", "EC2", "IAM", "RDS", "S3", "SSM"],
      servicePreview: previewServices(["CloudTrail", "CloudWatch", "EC2", "IAM", "RDS", "S3", "SSM"]),
      assignments: [
        {
          accountId: "123456789012",
          accountName: "Production",
          permissionSetName: "SecurityAudit",
          accessLevel: "read-only",
          services: ["CloudTrail", "CloudWatch", "EC2", "IAM", "RDS", "S3", "SSM"],
          via: "group",
          groupName: "auditors",
          unresolved: false,
        },
      ],
      inactive: false,
      orphaned: false,
      evidence: [
        {
          sourceType: "permission-set",
          name: "SecurityAudit",
          effect: "Allow",
          detail: "Production · group auditors · AWS-managed SecurityAudit (read-only).",
        },
      ],
      notes: [],
      crossLink: null,
    },
    {
      population: "sso",
      id: "u-priya",
      userName: "priya.admin",
      displayName: "Priya Admin",
      email: "priya.admin@example.com",
      activity: activity({ at: daysAgo(2), status: "known", source: "cloudtrail" }),
      accessLevel: "read-write",
      services: "all",
      servicePreview: "All services",
      assignments: [
        {
          accountId: "123456789012",
          accountName: "Production",
          permissionSetName: "AdministratorAccess",
          accessLevel: "read-write",
          services: "all",
          via: "group",
          groupName: "admins",
          unresolved: false,
        },
        {
          accountId: "210987654321",
          accountName: "Audit",
          permissionSetName: "ViewOnlyAccess",
          accessLevel: "read-only",
          services: "all",
          via: "user",
          groupName: null,
          unresolved: false,
        },
      ],
      inactive: false,
      orphaned: false,
      evidence: [
        {
          sourceType: "permission-set",
          name: "AdministratorAccess",
          effect: "Allow",
          detail: "Production · group admins · highest level is Read/Write.",
        },
        {
          sourceType: "permission-set",
          name: "ViewOnlyAccess",
          effect: "Allow",
          detail: "Audit · direct assignment · Read-only.",
        },
      ],
      notes: ["Multiple assignments. The table shows the highest level."],
      crossLink: null,
    },
    {
      population: "sso",
      id: "u-never",
      userName: "new.viewer",
      displayName: "New Viewer",
      email: "new.viewer@example.com",
      activity: activity({ at: null, status: "known", source: "none" }),
      accessLevel: "read-only",
      services: ["S3"],
      servicePreview: "S3",
      assignments: [
        {
          accountId: "210987654321",
          accountName: "Audit",
          permissionSetName: "S3ReadOnly",
          accessLevel: "read-only",
          services: ["S3"],
          via: "user",
          groupName: null,
          unresolved: false,
        },
      ],
      inactive: true,
      orphaned: false,
      evidence: [
        {
          sourceType: "permission-set",
          name: "S3ReadOnly",
          effect: "Allow",
          detail: "Audit · s3:Get* and s3:List* only.",
        },
      ],
      notes: [],
      crossLink: null,
    },
    {
      population: "sso",
      id: "principal-missing",
      userName: "Unknown principal 11112222-3333-4444-5555-666677778888",
      displayName: "Unknown principal",
      email: "",
      activity: activity({ at: null, status: "unavailable", source: "unavailable" }),
      accessLevel: "read-write",
      services: ["EC2"],
      servicePreview: "EC2",
      assignments: [
        {
          accountId: "123456789012",
          accountName: "Production",
          permissionSetName: "BrokenCustom",
          accessLevel: "read-write",
          services: ["EC2"],
          via: "user",
          groupName: null,
          unresolved: true,
        },
      ],
      inactive: false,
      orphaned: true,
      evidence: [
        {
          sourceType: "permission-set",
          name: "BrokenCustom",
          effect: "Allow",
          detail: "Assignment remains, but the Identity Center user no longer exists.",
        },
      ],
      notes: ["Orphaned assignment kept so it is not silently dropped."],
      crossLink: null,
    },
  ];
  for (const row of rows) row.inactive = isInactive(row.activity);
  return rows;
}

export function demoUsers(): UsersPayload {
  const ssm = demoSsm();
  const sso = demoSso();
  linkPopulations(ssm, sso);
  return {
    live: false,
    asOf: new Date().toISOString(),
    warnings: [
      "Demo data. Add keys to .env.local, then press Rescan on this page to read IAM and Identity Center.",
    ],
    scpNote: SCP_NOTE,
    ssm,
    sso,
    iam: demoIam(),
    roles: demoRoles(),
    policies: demoPolicies(),
    instances: INSTANCES,
  };
}

function demoIam(): IamUserRow[] {
  const rows: IamUserRow[] = [
    {
      population: "iam",
      id: "dashboard-bot",
      userName: "dashboard-bot",
      arn: "arn:aws:iam::123456789012:user/dashboard-bot",
      groups: [],
      policies: [
        { name: "DashboardRead", arn: "arn:aws:iam::123456789012:policy/DashboardRead", type: "Customer managed", attachedVia: "Directly" },
      ],
      permissionsBoundary: null,
      tags: [{ key: "app", value: "dashboard" }],
      passwordEnabled: false,
      passwordLastUsed: null,
      mfaDevices: [],
      accessKeys: [
        {
          id: "AKIAEXAMPLEBOT0001",
          status: "Active",
          createdAt: daysAgo(40),
          lastUsedAt: hoursAgo(1),
          lastUsedRegion: "us-west-2",
          lastUsedService: "iam",
        },
      ],
      lastAccessed: [
        { service: "AWS Identity and Access Management", lastAccessed: hoursAgo(1), region: "us-west-2" },
        { service: "Amazon S3", lastAccessed: null, region: null },
      ],
      lastAccessedStatus: "known",
      activity: activity({
        at: hoursAgo(1),
        status: "known",
        source: "none",
        note: "An access key was used. This is the IAM user record, not a Session Manager session.",
      }),
      inactive: false,
    },
    {
      population: "iam",
      id: "svc-mail",
      userName: "svc-mail",
      arn: "arn:aws:iam::123456789012:user/svc-mail",
      groups: [
        {
          name: "mail",
          arn: "arn:aws:iam::123456789012:group/mail",
          createdAt: daysAgo(200),
          policies: ["AmazonSESFullAccess"],
        },
      ],
      policies: [
        {
          name: "AmazonSESFullAccess",
          arn: "arn:aws:iam::aws:policy/AmazonSESFullAccess",
          type: "AWS managed",
          attachedVia: "mail",
        },
      ],
      permissionsBoundary: null,
      tags: [],
      passwordEnabled: true,
      passwordLastUsed: daysAgo(120),
      mfaDevices: ["arn:aws:iam::123456789012:mfa/svc-mail"],
      accessKeys: [
        {
          id: "AKIAEXAMPLEMAIL001",
          status: "Active",
          createdAt: daysAgo(80),
          lastUsedAt: daysAgo(15),
          lastUsedRegion: "us-west-2",
          lastUsedService: "ses",
        },
      ],
      lastAccessed: [{ service: "Amazon Simple Email Service", lastAccessed: daysAgo(15), region: "us-west-2" }],
      lastAccessedStatus: "known",
      activity: activity({
        at: daysAgo(15),
        status: "known",
        source: "none",
        note: "An access key was used. This is the IAM user record, not a Session Manager session.",
      }),
      inactive: false,
    },
  ];
  for (const row of rows) row.inactive = isInactive(row.activity);
  return rows;
}

function demoRoles(): IamRoleRow[] {
  return [
    {
      population: "role",
      id: "arn:aws:iam::123456789012:role/app-runtime",
      roleName: "app-runtime",
      arn: "arn:aws:iam::123456789012:role/app-runtime",
      trustedEntities: ["ec2.amazonaws.com"],
      lastUsedAt: hoursAgo(3),
      createdAt: daysAgo(300),
    },
  ];
}

function demoPolicies(): IamPolicyRow[] {
  return [
    {
      population: "policy",
      id: "arn:aws:iam::123456789012:policy/DashboardRead",
      name: "DashboardRead",
      arn: "arn:aws:iam::123456789012:policy/DashboardRead",
      type: "Customer managed",
      attachmentCount: 1,
      description: "Read IAM users for the dashboard.",
    },
    {
      population: "policy",
      id: "arn:aws:iam::aws:policy/AmazonSESFullAccess",
      name: "AmazonSESFullAccess",
      arn: "arn:aws:iam::aws:policy/AmazonSESFullAccess",
      type: "AWS managed",
      attachmentCount: 1,
      description: null,
    },
  ];
}
