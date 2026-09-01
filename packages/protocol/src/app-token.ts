import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Matches a `records.id`/`generations.id` uuid — hex digits grouped 8-4-4-4-12, which is
 * what `gen_random_uuid()` (the column default) always produces, without pinning the RFC
 * 4122 version/variant bits within each group (that guarantee comes from the column
 * default, not from anything this regex needs to re-check). The hyphens are anchored by
 * position, not just counted: an unordered `[0-9a-f-]{36}` character class (the original
 * Phase 5 review S2 fix) lets 36 hex digits with no hyphens, or 36 hyphens, both pass —
 * neither is valid `uuid` input, so both would still reach Postgres and raise `22P02`
 * instead of the clean 404 the fix's whole point was to return (residual R1). Shared so an
 * app id embedded in a token and a record id in a URL path are validated the same way; see
 * `verifyAppToken` below and `apps/sandbox/src/data.ts`'s use on `:id`.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-app data-API token. Derived, not stored: an HMAC of the app id under a server secret
 * shared by studio (which mints) and sandbox (which verifies).
 *
 * Deriving rather than storing buys three things. The sandbox needs no access to any table
 * but `records`, so the restricted role stays as narrow as architecture.md wants it. There
 * is no lookup on the hot path. And — the one that would otherwise cause a real bug — a
 * token is a pure function of the app id, so re-rendering a document (which every edit does,
 * via renderDocument) reproduces the same token instead of silently minting a new one or
 * dropping it.
 *
 * This file uses node:crypto and is NEVER inlined into a generated document. Only
 * `swap-runtime.ts` and `data-runtime.ts` are strings that reach a browser.
 *
 * The `v1:` prefix is a rotation seam. Changing it invalidates every token at once, which is
 * the whole of revocation in this phase — see impl-phase-5.md's "Deliberately deferred".
 */
export function mintAppToken(appId: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(`v1:${appId}`).digest("base64url");
  return `${appId}.${mac}`;
}

/** The app id this token is for, or null. Never trust an app id from anywhere else. */
export function verifyAppToken(token: string, secret: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const appId = token.slice(0, dot);
  if (!UUID_PATTERN.test(appId)) return null;

  const expected = Buffer.from(mintAppToken(appId, secret));
  const actual = Buffer.from(token);
  // Length must match before timingSafeEqual, which throws on differing lengths.
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? appId : null;
}
