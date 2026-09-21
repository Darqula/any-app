/**
 * Provider errors can quote the credential back.
 * Two overlapping passes: the secrets we know, and key-shaped patterns we don't.
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
