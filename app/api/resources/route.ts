import { NextResponse } from "next/server";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { accountClientConfig, isCredsError } from "@/lib/aws";
import { getAccount } from "@/lib/account-store";
import { explainCredentialFailure } from "@/lib/credential-errors";
import { buildInventory } from "@/lib/aws-resources";
import { readInventoryCache, writeInventoryCache } from "@/app/api/resources/cache";

export const dynamic = "force-dynamic";
// Inventory scan can take a while across all regions
export const maxDuration = 120;

export async function GET(request: Request) {
  const account = getAccount();
  // Keys alone do not scan AWS. A page asks for a scan with ?refresh=1.
  if (!account) {
    return NextResponse.json({ live: false, error: "sync_disabled" });
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!refresh) {
    const cache = readInventoryCache();
    if (cache) return NextResponse.json(cache.data);
    return NextResponse.json({ live: false, error: "not_scanned" });
  }
  try {
    const sts = new STSClient(accountClientConfig(account.region));
    await sts.send(new GetCallerIdentityCommand({}));
    const inv = await buildInventory();
    writeInventoryCache(inv);
    return NextResponse.json(inv);
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
