import assert from "node:assert/strict";
import test from "node:test";
import { explainCredentialFailure } from "../lib/credential-errors";
import { accountCredentials, clearAccount, getAccount, saveAccount } from "../lib/account-store";

test("temporary keys ask for the session token instead of saying the secret is wrong", () => {
  const message = explainCredentialFailure("InvalidClientTokenId", "ASIAEXAMPLEKEY000000", false);
  assert.match(message, /session token/);
  assert.equal(message.includes("rejected those keys"), false);
});

test("a permission denial is not reported as a bad secret", () => {
  const message = explainCredentialFailure("AccessDeniedException", "AKIAEXAMPLEKEY000000", false);
  assert.match(message, /accepted the keys/);
  assert.match(message, /sts:GetCallerIdentity/);
});

test("a mismatched secret is named directly", () => {
  assert.match(explainCredentialFailure("SignatureDoesNotMatch", "AKIAEXAMPLEKEY000000", false), /does not match/);
});

test("stored temporary keys keep the session token on later AWS calls", () => {
  const saved = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    AWS_REGION: process.env.AWS_REGION,
  };
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_REGION;
  try {
    clearAccount();
    saveAccount({
      accessKeyId: "ASIAEXAMPLEKEY000000",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      region: "us-west-2",
    });
    const stored = getAccount();
    assert.ok(stored);
    assert.equal(accountCredentials(stored).sessionToken, "session-token");
    clearAccount();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
