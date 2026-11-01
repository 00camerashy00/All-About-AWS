import { NextResponse } from "next/server";
import { getAccount } from "@/lib/account-store";
import { isCredsError } from "@/lib/aws";
import { buildMonitoring } from "@/lib/aws-monitoring";
import { DEFAULT_WINDOW, WINDOWS, type WindowId } from "@/lib/monitoring-config";
import type { ServiceId } from "@/lib/monitoring-types";
import { readMonitoringCache, resetMonitoringCache, writeMonitoringCache } from "@/app/api/monitoring/cache";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SERVICES = new Set<ServiceId>(["ec2", "rds", "s3"]);

export async function GET(request: Request) {
  const account = getAccount();
  if (!account) {
    return NextResponse.json({ live: false, error: "sync_disabled" });
  }
  const url = new URL(request.url);
  const service = url.searchParams.get("service") as ServiceId;
  const window = (url.searchParams.get("window") ?? DEFAULT_WINDOW) as WindowId;
  if (!SERVICES.has(service) || !WINDOWS[window]) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }
  const key = `${service}:${window}`;
  const refresh = url.searchParams.get("refresh") === "1";
  if (!refresh) {
    const cached = readMonitoringCache(key);
    if (cached) return NextResponse.json(cached.data);
    return NextResponse.json({ live: false, error: "not_scanned" });
  }
  try {
    const data = await buildMonitoring(service, window);
    writeMonitoringCache(key, data);
    return NextResponse.json(data);
  } catch (error) {
    resetMonitoringCache();
    const name = (error as { name?: string }).name ?? "Unknown";
    return NextResponse.json(
      {
        live: false,
        error: isCredsError(error) ? "credentials_expired_or_denied" : "aws_error",
        detail: name,
      },
      { status: isCredsError(error) ? 401 : 502 }
    );
  }
}
