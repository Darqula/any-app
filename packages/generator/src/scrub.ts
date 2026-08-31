/**
 * Provider error messages quote the credential back. This is not hypothetical: during live
 * testing a 401 wrote `Incorrect API key provided: REPLACE_ME` straight into
 * `generations.error`. That was survivable when the key was a placeholder belonging to the
 * operator. With user-supplied credentials the same path is a breach.
 *
 * Two passes, deliberately overlapping. The known-secret pass catches the credential we are
 * actually using, in whatever form the provider echoes it. The pattern pass catches keys we
 * were never told about — another service's token quoted in a gateway's error, say.
 */
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
];

export function scrub(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** The only way an error should ever become a user- or database-facing string. */
export function safeMessage(error: unknown, secrets: string[] = []): string {
  const raw = error instanceof Error ? error.message : "unknown error";
  return scrub(raw, secrets).slice(0, 500);
}
