import type { Request, Response } from "express";
import { createSession, getSession, deleteSession, getUser } from "@any-app/store";
import type { Owner } from "@any-app/store";

const COOKIE = "anyapp_session";
// Lax, not Strict: Strict is not sent on a cross-site navigation, so opening a shared link would mint a
// fresh anonymous session and replace the recipient's real cookie. The Sec-Fetch-Site guard covers CSRF.
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
 * The caller's identity, creating an anonymous session on first visit. The cookie has no Domain attribute:
 * generated apps are subdomains of the studio's host and must not receive it.
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

/** The signed-in user's email for the sidebar footer; null for an anonymous owner. */
export async function accountEmail(owner: Owner): Promise<string | null> {
  if (owner.kind !== "user") return null;
  return (await getUser(owner.userId))?.email ?? null;
}

/** A new session id on sign-in, dropping the old one: reusing it would allow session fixation. */
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
