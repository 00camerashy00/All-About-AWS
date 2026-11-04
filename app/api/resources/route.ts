import { NextResponse } from "next/server";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { accountClientConfig, isCredsError } from "@/lib/aws";
import { getAccount } from "@/lib/account-store";
import { explainCredentialFailure } from "@/lib/credential-errors";
import { buildInventory, type InventoryScope } from "@/lib/aws-resources";
import { asInventory, mergeInventory } from "@/lib/inventory-merge";
import { readInventoryCache, updateInventoryCache } from "@/app/api/resources/cache";

export const dynamic = "force-dynamic";
// Inventory scan can take a while across all regions
export const maxDuration = 120;

export async function GET(request: Request) {
  const account = getAccount();
  // Keys alone do not scan AWS. A page asks for a scan with ?refresh=1.
  if (!account) {
    return NextResponse.json({ live: false, error: "sync_disabled" });
  }

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  if (!refresh) {
    const cache = readInventoryCache();
    if (cache) return NextResponse.json(cache.data);
    return NextResponse.json({ live: false, error: "not_scanned" });
  }
  const scope = parseScope(url.searchParams.get("scope"));
  if (scope === "invalid") {
    return NextResponse.json(
      { live: false, error: "bad_scope", detail: "scope must be ec2, rds, or s3." },
      { status: 400 }
    );
  }
  try {
    const sts = new STSClient(accountClientConfig(account.region));
    await sts.send(new GetCallerIdentityCommand({}));
    const inv = await buildInventory(scope ?? undefined);
    const stored = await updateInventoryCache((current) =>
      scope ? mergeInventory(asInventory(current), inv, scope) : inv
    );
    return NextResponse.json(stored);
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "Unknown";
    console.error("resources scan failed:", name);
    return NextResponse.json(
      {
        live: false,
        error: isCredsError(e) ? "credentials_expired_or_denied" : "aws_error",
        detail: isCredsError(e)
          ? explainCredentialFailure(name, account.accessKeyId, Boolean(account.sessionToken))
          : "The inventory scan failed before it could finish.",
      },
      { status: isCredsError(e) ? 401 : 502 }
    );
  }
}

function parseScope(value: string | null): InventoryScope | null | "invalid" {
  if (!value) return null;
  if (value === "ec2" || value === "rds" || value === "s3") return value;
  return "invalid";
}
