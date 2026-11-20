import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export const DEFAULT_INGRESS_BUCKET = "krishagni-client-ingress";
export const DEFAULT_INGRESS_REGION = "us-west-2";
export const DEFAULT_EXPIRES_IN = 86_400;
export const MIN_EXPIRES_IN = 60;
export const MAX_EXPIRES_IN = 7 * 24 * 60 * 60;

const CUSTOMER_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}$/;

export class IngressInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngressInputError";
  }
}

export interface IngressLink {
  bucket: string;
  region: string;
  prefix: string;
  folder: string;
  url: string;
  expiresIn: number;
  expiresAt: string;
  command: string;
  ip: string | null;
  sessionBound: boolean;
}

export interface IngressLinkInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  customer: unknown;
  expiresIn: unknown;
  ip?: unknown;
  now: Date;
  bucket: string;
  region: string;
}

export function ingressSettings(): { bucket: string; region: string } {
  const bucket = (process.env.INGRESS_BUCKET ?? "").trim() || DEFAULT_INGRESS_BUCKET;
  const region = (process.env.INGRESS_REGION ?? "").trim() || DEFAULT_INGRESS_REGION;
  return { bucket, region };
}

export function buildIngressLink(input: IngressLinkInput): IngressLink {
  const customer = cleanCustomer(input.customer);
  const expiresIn = cleanExpires(input.expiresIn);
  const ip = cleanIp(input.ip);
  const bucket = input.bucket.trim();
  const region = input.region.trim();
  if (!bucket || !region) {
    throw new IngressInputError("The ingress bucket is not configured.");
  }

  const now = input.now;
  const day = utcDay(now);
  const amzDate = utcAmz(now);
  const prefix = `ingress/${customer}/${day}-1/`;
  const credential = `${input.accessKeyId}/${day}/${region}/s3/aws4_request`;
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sessionToken = (input.sessionToken ?? "").trim();

  const conditions: Array<Record<string, string> | [string, string, string]> = [
    { bucket },
    ["starts-with", "$key", prefix],
    { success_action_status: "200" },
    { "x-amz-credential": credential },
    { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
    { "x-amz-date": amzDate },
  ];
  if (sessionToken) conditions.push({ "x-amz-security-token": sessionToken });

  const policy = Buffer.from(
    JSON.stringify({ expiration: expiresAt, conditions }),
    "utf8"
  ).toString("base64");
  const signature = createHmac("sha256", signatureKey(input.secretAccessKey, day, region))
    .update(policy, "utf8")
    .digest("hex");

  const fields: Array<[string, string]> = [
    ["success_action_status", "200"],
    ["key", `${prefix}\${filename}`],
    ["x-amz-algorithm", "AWS4-HMAC-SHA256"],
    ["x-amz-credential", credential],
    ["x-amz-date", amzDate],
    ["policy", policy],
    ["x-amz-signature", signature],
  ];
  if (sessionToken) fields.push(["x-amz-security-token", sessionToken]);

  const url = `https://${bucket}.s3.${region}.amazonaws.com/`;
  const formFlags = fields.map(([key, value]) => `-F '${key}=${escapeSingle(value)}'`).join(" \\\n  ");
  const command = [
    'read -p "Enter file path to upload: " FILE_PATH && \\',
    'curl -# --fail-with-body -w "\\nUpload Status: HTTP %{http_code}\\n" \\',
    `  ${formFlags} \\`,
    `  -F "file=@\$FILE_PATH" "${url}"`,
  ].join("\n");

  return {
    bucket,
    region,
    prefix,
    folder: `s3://${bucket}/${prefix}`,
    url,
    expiresIn,
    expiresAt,
    command,
    ip,
    sessionBound: Boolean(sessionToken),
  };
}

function signatureKey(secret: string, dateStamp: string, region: string): Buffer {
  const dateKey = createHmac("sha256", `AWS4${secret}`).update(dateStamp, "utf8").digest();
  const regionKey = createHmac("sha256", dateKey).update(region, "utf8").digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3", "utf8").digest();
  return createHmac("sha256", serviceKey).update("aws4_request", "utf8").digest();
}

function cleanCustomer(value: unknown): string {
  if (typeof value !== "string") throw new IngressInputError("Enter a client name.");
  const customer = value.trim().replace(/^\/+|\/+$/g, "");
  if (!customer) throw new IngressInputError("Enter a client name.");
  if (!CUSTOMER_NAME.test(customer)) {
    throw new IngressInputError(
      "Client name can use letters, numbers, spaces, dots, underscores, and hyphens."
    );
  }
  return customer;
}

function cleanExpires(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_EXPIRES_IN || value > MAX_EXPIRES_IN) {
    throw new IngressInputError("Validity must be between 1 minute and 7 days.");
  }
  return value;
}

function cleanIp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new IngressInputError("Enter a valid IP address or CIDR.");
  const raw = value.trim();
  if (!raw) return null;
  const slash = raw.lastIndexOf("/");
  if (slash === -1) {
    if (!isIP(raw)) throw new IngressInputError("Enter a valid IP address or CIDR.");
    return raw;
  }
  const address = raw.slice(0, slash);
  const prefix = raw.slice(slash + 1);
  const kind = isIP(address);
  const bits = Number(prefix);
  const max = kind === 4 ? 32 : kind === 6 ? 128 : -1;
  if (!kind || !Number.isInteger(bits) || String(bits) !== prefix || bits < 0 || bits > max) {
    throw new IngressInputError("Enter a valid IP address or CIDR.");
  }
  return `${address}/${bits}`;
}

function escapeSingle(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function utcDay(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function utcAmz(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${utcDay(date)}T${hours}${minutes}${seconds}Z`;
}
