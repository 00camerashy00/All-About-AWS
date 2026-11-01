import { NextResponse } from "next/server";
import { readAlarmsCache, resetAlarmsCache, writeAlarmsCache } from "@/app/api/alarms/cache";
import { getAccount } from "@/lib/account-store";
import { isCredsError } from "@/lib/aws";
import { buildLiveAlarms } from "@/lib/aws-alarms";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const account = getAccount();
  if (!account) {
    return NextResponse.json({ live: false, error: "sync_disabled" });
  }
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!refresh) {
    const cached = readAlarmsCache();
    if (cached) return NextResponse.json(cached.data);
    return NextResponse.json({ live: false, error: "not_scanned" });
  }
  try {
    const data = await buildLiveAlarms();
    writeAlarmsCache(data);
    return NextResponse.json(data);
  } catch (error) {
    resetAlarmsCache();
    const name = (error as { name?: string }).name ?? "Unknown";
    return NextResponse.json(
      { live: false, error: isCredsError(error) ? "credentials_expired_or_denied" : "aws_error", detail: name },
      { status: isCredsError(error) ? 401 : 502 }
    );
  }
}
