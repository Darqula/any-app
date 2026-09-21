import { createHmac, timingSafeEqual } from "node:crypto";

/** Hyphen positions are anchored: a 36-char hex/hyphen class let malformed ids reach Postgres (22P02). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** rw for the owner; ro for viewers of a shared app (reads only). */
export type TokenMode = "rw" | "ro";

/**
 * Derived, not stored: an HMAC of app id and mode, so re-rendering a document reproduces the same
 * token. Never inlined into a document. The "v1:" prefix is the rotation seam.
 */
export function mintAppToken(appId: string, mode: TokenMode, secret: string): string {
  const mac = createHmac("sha256", secret).update(`v1:${mode}:${appId}`).digest("base64url");
  return `${appId}.${mode}.${mac}`;
}

/** The app id and mode this token is for, or null. Never trust an app id from anywhere else. */
export function verifyAppToken(token: string, secret: string): { appId: string; mode: TokenMode } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [appId, modeRaw, mac] = parts as [string, string, string];
  if (!UUID_PATTERN.test(appId)) return null;
  if (modeRaw !== "rw" && modeRaw !== "ro") return null;
  const mode = modeRaw as TokenMode;

  const expected = Buffer.from(mintAppToken(appId, mode, secret));
  const actual = Buffer.from(`${appId}.${mode}.${mac}`);
  // Length must match before timingSafeEqual, which throws on differing lengths.
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? { appId, mode } : null;
}
