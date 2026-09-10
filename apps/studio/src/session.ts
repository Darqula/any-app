import type { Request, Response } from "express";
import { createSession, getSession, deleteSession } from "@any-app/store";
import type { Owner } from "@any-app/store";

const COOKIE = "anyapp_session";
// SameSite=Lax, deliberately NOT Strict. Strict is not sent on a
// cross-site top-level navigation, and a shared /apps/:id link opened from Slack or email is
// exactly that — so `currentOwner` would see no cookie, mint an anonymous session, and its
// Set-Cookie would REPLACE the recipient's real one. Clicking a shared link would sign you
// out. The generated-app CSRF that Strict looks like it defends against is same-site anyway
// (<id>.apps.example.com -> example.com), so Strict never blocked it; index.ts's
// Sec-Fetch-Site guard is what does.
const COOKIE_ATTRS = "HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000";

function cookieValue(req: Request): string | undefined {
  return (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([name]) => name === COOKIE)?.[1];
}

function setCookie(res: Response, id: string): void {
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; ${COOKIE_ATTRS}`);
}

/**
 * The caller's identity, creating an anonymous session on first visit.
 *
 * The cookie is set with NO `Domain` attribute, which makes it host-only on
 * `localhost:3000`. That is load-bearing: generated apps live on
 * `<id>.apps.localhost`, a SUBDOMAIN of the studio's host, so a `Domain=localhost` cookie
 * would be sent to every generated app. Do not add one.
 */
export async function currentOwner(req: Request, res: Response): Promise<Owner> {
  const existing = cookieValue(req);
  if (existing) {
    const row = await getSession(existing);
    if (row) {
      return row.user_id
        ? { kind: "user", userId: row.user_id, sessionId: row.id }
        : { kind: "anon", sessionId: row.id };
    }
  }
  const id = await createSession(null);
  setCookie(res, id);
  return { kind: "anon", sessionId: id };
}

/**
 * Issues a NEW session id for a user and drops the old one. Rotation, not mutation: reusing
 * the pre-authentication id is session fixation — an attacker who plants a known cookie value
 * before sign-in would hold a valid signed-in session afterwards.
 */
export async function signInAs(
  res: Response,
  userId: string,
  oldSessionId: string | null,
): Promise<Owner> {
  const id = await createSession(userId);
  if (oldSessionId) await deleteSession(oldSessionId);
  setCookie(res, id);
  return { kind: "user", userId, sessionId: id };
}

export async function signOut(res: Response, sessionId: string): Promise<void> {
  await deleteSession(sessionId);
  const id = await createSession(null);
  setCookie(res, id);
}
