import { NextResponse } from "next/server";
import { getAccount } from "@/lib/account-store";
import { IngressInputError, buildIngressLink, ingressSettings } from "@/lib/ingress-link";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const account = getAccount();
  if (!account) {
    return NextResponse.json(
      { error: "missing_keys", detail: "Add AWS keys before generating a link." },
      { status: 401 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    customer?: unknown;
    expiresIn?: unknown;
    ip?: unknown;
  } | null;

  try {
    const settings = ingressSettings();
    const link = buildIngressLink({
      accessKeyId: account.accessKeyId,
      secretAccessKey: account.secretAccessKey,
      sessionToken: account.sessionToken,
      customer: body?.customer,
      expiresIn: body?.expiresIn,
      ip: body?.ip,
      now: new Date(),
      bucket: settings.bucket,
      region: settings.region,
    });
    return NextResponse.json(link);
  } catch (error) {
    if (error instanceof IngressInputError) {
      return NextResponse.json({ error: "invalid_input", detail: error.message }, { status: 400 });
    }
    const name = (error as { name?: string })?.name ?? "error";
    console.error("ingress link failed:", name);
    return NextResponse.json(
      { error: "link_failed", detail: "The link could not be signed." },
      { status: 500 }
    );
  }
}
