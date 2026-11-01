import { NextResponse } from "next/server";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  clearAccount,
  getAccount,
  saveAccount,
  setLiveSync,
  toPublic,
} from "@/lib/account-store";
import { isCredsError } from "@/lib/aws";
import { explainCredentialFailure } from "@/lib/credential-errors";
import { resetInventoryCache } from "@/app/api/resources/cache";
import { resetUsersCache } from "@/app/api/users/cache";
import { resetMonitoringCache } from "@/app/api/monitoring/cache";
import { resetAlarmsCache } from "@/app/api/alarms/cache";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(toPublic());
}

export async function DELETE() {
  resetInventoryCache();
  resetUsersCache();
  resetMonitoringCache();
  resetAlarmsCache();
  return NextResponse.json(clearAccount());
}

export async function PATCH(request: Request) {
  if (!getAccount()) {
    return NextResponse.json({ error: "missing_keys" }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as { liveSync?: boolean } | null;
  if (typeof body?.liveSync !== "boolean") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  resetInventoryCache();
  resetUsersCache();
  resetMonitoringCache();
  resetAlarmsCache();
  return NextResponse.json(setLiveSync(body.liveSync));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    region?: string;
  } | null;

  const accessKeyId = cleanCredential(body?.accessKeyId);
  const secretAccessKey = cleanCredential(body?.secretAccessKey);
  const sessionToken = cleanCredential(body?.sessionToken);
  const region = body?.region?.trim() || "ap-south-1";

  if (!accessKeyId || !secretAccessKey) {
    return NextResponse.json({ error: "missing_keys" }, { status: 400 });
  }
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
    return NextResponse.json(
      { error: "invalid_region", detail: "Use a region code such as ap-south-1 or us-west-2, not the display name." },
      { status: 400 }
    );
  }
  if (accessKeyId.startsWith("ASIA") && !sessionToken) {
    return NextResponse.json(
      { error: "session_token_required", detail: explainCredentialFailure("", accessKeyId, false) },
      { status: 400 }
    );
  }

  try {
    const sts = new STSClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      },
    });
    await sts.send(new GetCallerIdentityCommand({}));
  } catch (e) {
    const name = (e as { name?: string }).name ?? "";
    const rejected = isCredsError(e);
    return NextResponse.json(
      {
        error: rejected ? "invalid_credentials" : "aws_error",
        detail: explainCredentialFailure(name, accessKeyId, Boolean(sessionToken)),
      },
      { status: rejected ? 401 : 502 }
    );
  }

  resetInventoryCache();
  resetUsersCache();
  resetMonitoringCache();
  resetAlarmsCache();
  const saved = saveAccount({ accessKeyId, secretAccessKey, sessionToken, region });
  return NextResponse.json(saved);
}

function cleanCredential(value: string | undefined): string {
  return (value ?? "").replace(/[\s"']/g, "");
}
