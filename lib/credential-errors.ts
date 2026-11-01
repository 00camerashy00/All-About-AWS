/** Why a key check failed. Does not include the secret or the token. */
export function explainCredentialFailure(name: string, accessKeyId: string, hasSessionToken: boolean): string {
  if (accessKeyId.startsWith("ASIA") && !hasSessionToken) {
    return "This access key is temporary (it starts with ASIA). Paste the session token too. Read-only access from SSO or AssumeRole comes as three values: key id, secret, and session token.";
  }
  if (name === "SignatureDoesNotMatch") {
    return "The secret access key does not match that access key ID.";
  }
  if (name === "ExpiredToken" || name === "ExpiredTokenException") {
    return "The session token has expired. Generate a new set and paste all three values.";
  }
  if (name === "AccessDenied" || name === "AccessDeniedException" || name === "UnauthorizedException") {
    return "AWS accepted the keys, then denied sts:GetCallerIdentity. The keys are not the problem. That action has to be allowed on the role.";
  }
  if (name === "InvalidClientTokenId" || name === "UnrecognizedClientException") {
    return hasSessionToken
      ? "AWS does not recognize that access key and session token. They may be expired, or the key ID was copied short."
      : "AWS does not recognize that access key ID. It may be inactive, or a character was dropped when it was copied. If the key starts with ASIA, add the session token.";
  }
  return `AWS could not check those keys (${name || "unknown error"}).`;
}
