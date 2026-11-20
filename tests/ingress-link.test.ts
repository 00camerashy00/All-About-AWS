import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { IngressInputError, buildIngressLink } from "../lib/ingress-link";

const NOW = new Date("2026-11-20T09:30:00.000Z");

function link(partial: Partial<Parameters<typeof buildIngressLink>[0]> = {}) {
  return buildIngressLink({
    accessKeyId: "AKIAEXAMPLEKEY000000",
    secretAccessKey: "example-secret",
    customer: "uva",
    expiresIn: 86_400,
    now: NOW,
    bucket: "krishagni-client-ingress",
    region: "us-west-2",
    ...partial,
  });
}

function policyOf(command: string): { expiration: string; conditions: unknown[] } {
  const match = command.match(/-F 'policy=([^']+)'/);
  assert.ok(match);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

test("a client link targets that day's ingress folder", () => {
  const result = link();
  assert.equal(result.prefix, "ingress/uva/20261120-1/");
  assert.equal(result.folder, "s3://krishagni-client-ingress/ingress/uva/20261120-1/");
  assert.equal(result.url, "https://krishagni-client-ingress.s3.us-west-2.amazonaws.com/");
  assert.equal(result.expiresAt, "2026-11-21T09:30:00Z");
  assert.equal(result.ip, null);
  assert.equal(result.sessionBound, false);

  const policy = policyOf(result.command);
  assert.equal(policy.expiration, "2026-11-21T09:30:00Z");
  assert.deepEqual(policy.conditions[0], { bucket: "krishagni-client-ingress" });
  assert.deepEqual(policy.conditions[1], ["starts-with", "$key", "ingress/uva/20261120-1/"]);
  assert.match(result.command, /key=ingress\/uva\/20261120-1\/\$\{filename\}/);
  assert.match(result.command, /-F "file=@\$FILE_PATH"/);
});

test("the signature matches an independent SigV4 POST calculation", () => {
  const result = link();
  const policy = result.command.match(/-F 'policy=([^']+)'/)?.[1] ?? "";
  const dateKey = createHmac("sha256", "AWS4example-secret").update("20261120").digest();
  const regionKey = createHmac("sha256", dateKey).update("us-west-2").digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  const expected = createHmac("sha256", signingKey).update(policy).digest("hex");
  assert.match(result.command, new RegExp(`x-amz-signature=${expected}`));
});

test("a session token is included and marks the link session-bound", () => {
  const result = link({ sessionToken: "session-token" });
  assert.equal(result.sessionBound, true);
  const policy = policyOf(result.command);
  assert.deepEqual(policy.conditions[policy.conditions.length - 1], {
    "x-amz-security-token": "session-token",
  });
  assert.match(result.command, /-F 'x-amz-security-token=session-token'/);
});

test("an optional IP is recorded and is not part of the upload policy", () => {
  const result = link({ ip: " 203.0.113.10/32 " });
  assert.equal(result.ip, "203.0.113.10/32");
  const policy = policyOf(result.command);
  assert.equal(JSON.stringify(policy).includes("203.0.113.10"), false);
});

test("client name, validity, and IP are rejected when they cannot be used", () => {
  assert.throws(() => link({ customer: " ../uva " }), IngressInputError);
  assert.throws(() => link({ customer: "" }), IngressInputError);
  assert.throws(() => link({ expiresIn: 30 }), IngressInputError);
  assert.throws(() => link({ expiresIn: 8 * 86_400 }), IngressInputError);
  assert.throws(() => link({ ip: "999.1.1.1" }), IngressInputError);
  assert.equal(link({ ip: "" }).ip, null);
  assert.equal(link({ ip: "2001:db8::1" }).ip, "2001:db8::1");
});
