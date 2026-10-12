/** Credential validation must fail fast on a bad URL and never retry. Generation calls keep the SDK defaults. */
export const VALIDATE_TIMEOUT_MS = 15_000;

export function validateRequestOptions(timeoutMs: number = VALIDATE_TIMEOUT_MS) {
  return { timeout: timeoutMs, maxRetries: 0 };
}
