import { createHmac, timingSafeEqual } from "node:crypto";
import { UUID_PATTERN } from "./app-token";
import type { TokenMode } from "./app-token";

/**
 * A bearer capability to view ONE app until it expires. Minted by studio (which knows the
 * viewer), carried in the iframe URL, forwarded blind by sandbox, verified by studio's
 * internal route. See architecture.md decision #10.
 *
 * Deliberately NOT bound to a viewer identity: the verifying side cannot identify one either,
 * so binding one in would be decoration. Treat a leaked grant as read access to that one app
 * for the remainder of its window — which is why apps/sandbox/src/index.ts sets
 * `Referrer-Policy: no-referrer` on the preview response.
 *
 * `mode` IS carried, though, and that is not decoration: it is the one thing the studio's
 * frame route (which does know the viewer, via `currentOwner`) can determine that the
 * internal stream route — reached from the sandbox with no cookie at all — genuinely cannot
 * re-derive on its own. `mode: "rw"` is minted only when the viewer is this app's actual
 * owner; a shared visitor gets `"ro"`, and an absent/invalid grant also gets `"ro"` (for a
 * private app it never reaches that far — see the 404 above). An EXPIRED-but-well-signed
 * grant is its own case, not folded into `"ro"` — see `ViewGrantResult` right below, and
 * internal.ts's dedicated branch. The internal route uses `mode`
 * verbatim to decide which data-API token (`mintAppToken`, app-token.ts) to bake into the
 * document it sends — never re-deriving ownership itself; see internal.ts.
 *
 * The `view:v1:` prefix is what keeps this and `mintAppToken`'s `v1:` from ever verifying as
 * each other under the shared `APP_TOKEN_SECRET`. Do not remove it to "simplify".
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

/**
 * A well-signed but expired grant and an outright forged/malformed one used to collapse to
 * the same `null` — which meant `internal.ts` could not tell them apart either, and served
 * BOTH as `mode: "ro"` (see its own doc comment on the "no grant at all" default). For a
 * PRIVATE app that is invisible (both cases 404 identically, which is correct — see
 * architecture.md's "never confirm a private app exists"). For an UNLISTED/PUBLIC app it is
 * not: the owner's own tab, left open past `VIEW_GRANT_TTL_MS` with the page never reloaded,
 * silently starts answering read-only to its own writes, with nothing on screen to explain
 * why. `expired` is a real, distinct case; `invalid` covers both "no
 * grant at all" and "signature doesn't verify" — the caller has no more reason to believe
 * `appId`/`mode` in a tampered grant than in a missing one.
 */
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

/**
 * 30 minutes, not 5. A generation on this project's default model can take six minutes
 * (open-problems.md), and the "Already generating…" page carries a two-second meta refresh
 * that re-requests the same URL with the same grant. A short TTL turns a slow generation into
 * a 404 partway through, which looks like a bug in the grant and is not.
 */
export const VIEW_GRANT_TTL_MS = 30 * 60 * 1000;
