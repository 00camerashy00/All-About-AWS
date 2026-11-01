import { accountCredentials, requireAccount } from "@/lib/account-store";

// Server-only helpers. Credentials come from the process environment and never leave the server.

export function accountClientConfig(region?: string) {
  const account = requireAccount();
  return {
    region: region || account.region,
    credentials: accountCredentials(account),
  };
}

const CREDS_ERRORS = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "UnauthorizedException",
  "AccessDenied",
  "AccessDeniedException",
]);

export function isCredsError(e: unknown) {
  const name = (e as { name?: string })?.name ?? "";
  return CREDS_ERRORS.has(name) || name === "SignatureDoesNotMatch";
}
