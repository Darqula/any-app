import { createHmac, timingSafeEqual } from "node:crypto";
import { UUID_PATTERN } from "./app-token";
import type { TokenMode } from "./app-token";

/**
 * Bearer capability to view one app until it expires. Carries mode ("rw" only for the owner)
 * because the internal stream route, reached without a cookie, cannot re-derive it.
 * The "view:v1:" prefix keeps grants and app tokens from verifying as each other.
 */
export function mintViewGrant(
  appId: string,
  mode: TokenMode,
  expiresAtMs: number,
  secret: string,
): string {
  const body = `${appId}.${mode}.${expiresAtMs}`;
  const mac = createHmac("sha256", secret).update(`view:v1:${body}`).digest("base64url");
  return `${body}.${mac}`;
}

/** expired is distinct from invalid so an owner's stale tab is not silently downgraded to read-only. */
export type ViewGrantResult =
  | { status: "valid"; appId: string; mode: TokenMode }
  | { status: "expired"; appId: string; mode: TokenMode }
  | { status: "invalid" };

/** Checks the signature first, then expiry — a grant that doesn't verify never gets to claim
 *  an appId/mode at all, expired or not. */
export function verifyViewGrant(grant: string, secret: string): ViewGrantResult {
  const parts = grant.split(".");
  if (parts.length !== 4) return { status: "invalid" };
  const [appId, modeRaw, expRaw] = parts as [string, string, string, string];
  if (!UUID_PATTERN.test(appId)) return { status: "invalid" };
  if (modeRaw !== "rw" && modeRaw !== "ro") return { status: "invalid" };
  const mode = modeRaw as TokenMode;

  const expiresAtMs = Number(expRaw);
  if (!Number.isSafeInteger(expiresAtMs)) return { status: "invalid" };

  const expected = Buffer.from(mintViewGrant(appId, mode, expiresAtMs, secret));
  const actual = Buffer.from(grant);
  if (expected.length !== actual.length) return { status: "invalid" };
  if (!timingSafeEqual(expected, actual)) return { status: "invalid" };

  return Date.now() <= expiresAtMs ? { status: "valid", appId, mode } : { status: "expired", appId, mode };
}

/** 30 minutes: a slow generation plus the "Already generating" refresh must not 404 mid-way. */
export const VIEW_GRANT_TTL_MS = 30 * 60 * 1000;
