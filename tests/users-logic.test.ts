import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyActions,
  describeAccess,
  evaluateSsmAccess,
  highestLevel,
  isInactive,
  levelForManagedPolicy,
  linkPopulations,
  matchesLoginFilter,
  previewServices,
  servicesFromActions,
  type EvalInstance,
  type NamedPolicy,
} from "../lib/users-logic";
import type { Activity, SsmUserRow, SsoUserRow } from "../lib/users-types";

const now = Date.parse("2026-10-15T00:00:00Z");

function instance(partial: Partial<EvalInstance> & Pick<EvalInstance, "id">): EvalInstance {
  return {
    name: partial.name ?? partial.id,
    region: partial.region ?? "ap-south-1",
    accountId: partial.accountId ?? "123456789012",
    tags: partial.tags ?? {},
    id: partial.id,
  };
}

function policy(name: string, statement: NamedPolicy["document"]["Statement"]): NamedPolicy {
  return { name, sourceType: "inline", document: { Statement: statement } };
}

const web = instance({ id: "i-web", name: "web-prod-1", tags: { Team: "web" } });
const worker = instance({ id: "i-worker", name: "worker-batch-1", tags: { Team: "data" } });

function activity(at: string | null, status: Activity["status"] = "known"): Activity {
  return {
    at,
    status,
    targetInstanceId: null,
    targetName: null,
    forwardedHost: null,
    source: status === "unavailable" ? "unavailable" : at ? "ssm" : "none",
    note: null,
  };
}

test("wildcard StartSession is all instances", () => {
  const result = evaluateSsmAccess(
    [policy("admin", { Effect: "Allow", Action: "ssm:StartSession", Resource: "*" })],
    null,
    [web, worker]
  );
  assert.equal(result.unrestricted, true);
  assert.equal(result.instances, "all");
});

test("specific instance ARN does not include other instances", () => {
  const result = evaluateSsmAccess(
    [
      policy("one", {
        Effect: "Allow",
        Action: "ssm:StartSession",
        Resource: [
          "arn:aws:ec2:ap-south-1:123456789012:instance/i-web",
          "arn:aws:ssm:*:*:document/SSM-SessionManagerRunShell",
        ],
      }),
    ],
    null,
    [web, worker]
  );
  assert.equal(result.unrestricted, false);
  assert.deepEqual(
    (result.instances as { id: string }[]).map((item) => item.id),
    ["i-web"]
  );
});

test("tag condition grants only matching instances", () => {
  const result = evaluateSsmAccess(
    [
      policy("tagged", {
        Effect: "Allow",
        Action: "ssm:*",
        Resource: "arn:aws:ec2:*:*:instance/*",
        Condition: { StringEquals: { "aws:ResourceTag/Team": "data" } },
      }),
    ],
    null,
    [web, worker]
  );
  assert.equal(result.unrestricted, false);
  assert.deepEqual(
    (result.instances as { id: string }[]).map((item) => item.id),
    ["i-worker"]
  );
});

test("explicit deny removes an otherwise allowed instance", () => {
  const result = evaluateSsmAccess(
    [
      policy("allow", { Effect: "Allow", Action: "ssm:StartSession", Resource: "*" }),
      policy("deny", {
        Effect: "Deny",
        Action: "ssm:StartSession",
        Resource: "arn:aws:ec2:ap-south-1:123456789012:instance/i-worker",
      }),
    ],
    null,
    [web, worker]
  );
  assert.equal(result.unrestricted, false);
  assert.deepEqual(
    (result.instances as { id: string }[]).map((item) => item.id),
    ["i-web"]
  );
});

test("permissions boundary blocks StartSession", () => {
  const boundary: NamedPolicy = {
    name: "OpsBoundary",
    sourceType: "boundary",
    document: { Statement: { Effect: "Allow", Action: "s3:GetObject", Resource: "*" } },
  };
  const result = evaluateSsmAccess(
    [policy("allow", { Effect: "Allow", Action: "ssm:StartSession", Resource: "*" })],
    boundary,
    [web]
  );
  assert.deepEqual(result.instances, []);
  assert.equal(result.unrestricted, false);
});

test("unknown condition is not treated as all instances", () => {
  const result = evaluateSsmAccess(
    [
      policy("odd", {
        Effect: "Allow",
        Action: "ssm:StartSession",
        Resource: "*",
        Condition: { Bool: { "aws:MultiFactorAuthPresent": "true" } },
      }),
    ],
    null,
    [web]
  );
  assert.notEqual(result.instances, "all");
  assert.equal(result.unrestricted, false);
  assert.ok(
    result.notes.some((note) => note.toLowerCase().includes("could not")) ||
      result.evidence.some((item) => item.detail.toLowerCase().includes("could not")),
    JSON.stringify({ notes: result.notes, instances: result.instances, evidence: result.evidence })
  );
});

test("document-only statement does not grant instances", () => {
  const result = evaluateSsmAccess(
    [
      policy("doc", {
        Effect: "Allow",
        Action: "ssm:StartSession",
        Resource: "arn:aws:ssm:*:*:document/SSM-SessionManagerRunShell",
      }),
    ],
    null,
    [web]
  );
  assert.deepEqual(result.instances, []);
});

test("read verbs stay read-only and any write action is read/write", () => {
  assert.equal(classifyActions(["ec2:DescribeInstances", "s3:GetObject", "s3:ListBucket"]), "read-only");
  assert.equal(classifyActions(["s3:GetObject", "s3:PutObject"]), "read-write");
  assert.equal(classifyActions(["ec2:*"]), "read-write");
  assert.equal(classifyActions(["*"]), "read-write");
  assert.equal(classifyActions([]), "none");
  assert.equal(classifyActions(["cognito-idp:AdminGet*", "apigateway:GET", "iam:Generate*", "s3express:CreateSession"]), "read-only");
  const proof = describeAccess(["s3:GetObject", "s3:PutObject", "iam:Generate*", "ec2:Describe*"]);
  assert.equal(proof.level, "read-write");
  assert.deepEqual(proof.writeActions, ["s3:PutObject"]);
  assert.deepEqual(proof.notableActions, []);
  const s3 = proof.grants === "all" ? null : proof.grants.find((item) => item.name === "S3");
  assert.deepEqual(s3, { name: "S3", read: true, write: true });
  const ssm = describeAccess(["ssm:*", "ec2:DescribeInstances"]);
  assert.equal(ssm.level, "read-write");
  assert.notEqual(ssm.grants, "all");
  assert.equal(describeAccess(["*"]).grants, "all");
});

test("unresolved managed policy is not understated", () => {
  assert.equal(levelForManagedPolicy("ReadOnlyAccess", null).level, "read-only");
  assert.equal(levelForManagedPolicy("CustomMystery", null).unresolved, true);
  assert.equal(levelForManagedPolicy("CustomMystery", null).level, "read-write");
});

test("highest assignment wins and services collapse", () => {
  assert.equal(highestLevel(["read-only", "none", "read-write"]), "read-write");
  assert.deepEqual(servicesFromActions(["ec2:Describe*", "s3:GetObject"]), ["EC2", "S3"]);
  assert.equal(previewServices(["EC2", "S3"]), "EC2, S3");
  assert.equal(previewServices(["EC2", "IAM", "RDS", "S3", "SSM"]), "EC2, IAM, RDS +2 more");
  assert.equal(previewServices("all"), "All services");
  assert.equal(servicesFromActions(["*"]), "all");
});

test("inactive flags never and 90 days, not unavailable", () => {
  assert.equal(isInactive(activity(null), now), true);
  assert.equal(isInactive(activity(new Date(now - 91 * 86_400_000).toISOString()), now), true);
  assert.equal(isInactive(activity(new Date(now - 10 * 86_400_000).toISOString()), now), false);
  assert.equal(isInactive(activity(null, "unavailable"), now), false);
  assert.equal(matchesLoginFilter(activity(null), "never", now), true);
  assert.equal(matchesLoginFilter(activity(null, "unavailable"), "never", now), false);
});

test("the same person is cross-linked and not merged", () => {
  const ssm: SsmUserRow[] = [
    {
      population: "ssm",
      id: "ashish.ops",
      userName: "ashish.ops",
      arn: "arn:aws:iam::1:user/ashish.ops",
      activity: activity(null),
      instances: [],
      unrestricted: false,
      inactive: true,
      evidence: [],
      notes: [],
      crossLink: null,
    },
  ];
  const sso: SsoUserRow[] = [
    {
      population: "sso",
      id: "sso-1",
      userName: "ashish.ops",
      displayName: "Ashish",
      email: "ashish.ops@example.com",
      activity: activity(null),
      accessLevel: "read-only",
      services: ["EC2"],
      servicePreview: "EC2",
      assignments: [],
      inactive: true,
      orphaned: false,
      evidence: [],
      notes: [],
      crossLink: null,
    },
    {
      population: "sso",
      id: "orphan",
      userName: "Unknown principal p-1",
      displayName: "Unknown principal",
      email: "",
      activity: activity(null, "unavailable"),
      accessLevel: "read-write",
      services: "all",
      servicePreview: "All services",
      assignments: [],
      inactive: false,
      orphaned: true,
      evidence: [],
      notes: ["Orphaned assignment"],
      crossLink: null,
    },
  ];
  linkPopulations(ssm, sso);
  assert.equal(ssm.length, 1);
  assert.equal(sso.length, 2);
  assert.equal(ssm[0].crossLink?.population, "sso");
  assert.equal(sso[0].crossLink?.label, "ashish.ops");
  assert.equal(sso[1].crossLink, null);
});
