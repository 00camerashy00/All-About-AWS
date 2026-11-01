// Credentials come from .env.local (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// optional AWS_SESSION_TOKEN, AWS_REGION). Next.js loads that file into
// process.env. The secret is never returned to the browser. A pasted session
// is only used when the file has no access key.

export interface StoredAccount {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  liveSync: boolean;
}

export interface PublicAccount {
  configured: boolean;
  liveSync: boolean;
  region: string;
  keyHint: string;
  source: "env" | "session" | "none";
}

const globalStore = globalThis as typeof globalThis & {
  __awsDashAccount?: StoredAccount | null;
};

function readAccount() {
  return globalStore.__awsDashAccount ?? null;
}

function writeAccount(value: StoredAccount | null) {
  globalStore.__awsDashAccount = value;
}

function cleanEnv(value: string | undefined): string {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

export function accountFromEnv(): StoredAccount | null {
  const accessKeyId = cleanEnv(process.env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = cleanEnv(process.env.AWS_SECRET_ACCESS_KEY);
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = cleanEnv(process.env.AWS_SESSION_TOKEN);
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    region: cleanEnv(process.env.AWS_REGION) || "ap-south-1",
    liveSync: false,
  };
}

export function getAccount(): StoredAccount | null {
  return accountFromEnv() ?? readAccount();
}

export function requireAccount(): StoredAccount {
  const account = getAccount();
  if (!account) throw new Error("no_account");
  return account;
}

export function accountCredentials(account: StoredAccount) {
  return {
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    ...(account.sessionToken ? { sessionToken: account.sessionToken } : {}),
  };
}

export function toPublic(value: StoredAccount | null = getAccount()): PublicAccount {
  if (!value) {
    return { configured: false, liveSync: false, region: "ap-south-1", keyHint: "", source: "none" };
  }
  const id = value.accessKeyId;
  const fromEnv = accountFromEnv();
  const source = fromEnv && fromEnv.accessKeyId === value.accessKeyId ? "env" : "session";
  return {
    configured: true,
    liveSync: value.liveSync,
    region: value.region,
    keyHint: id.length > 4 ? id.slice(-4) : id,
    source,
  };
}

export function saveAccount(input: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}): PublicAccount {
  const sessionToken = input.sessionToken?.trim() || undefined;
  writeAccount({
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKey: input.secretAccessKey.trim(),
    ...(sessionToken ? { sessionToken } : {}),
    region: input.region.trim() || "ap-south-1",
    liveSync: false,
  });
  return toPublic();
}

export function setLiveSync(liveSync: boolean): PublicAccount {
  const account = readAccount();
  if (!account) throw new Error("no_account");
  writeAccount({ ...account, liveSync });
  return toPublic();
}

export function clearAccount(): PublicAccount {
  writeAccount(null);
  return toPublic();
}
