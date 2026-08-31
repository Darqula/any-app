import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";

const COOKIE = "anyapp_session";

/**
 * Returns the caller's session id, setting a fresh httpOnly cookie on first visit. No
 * cookie parser, no session library — the id is unguessable and used only as a lookup key
 * for `provider_credentials`.
 *
 * The sandbox cannot see this cookie, because it is set on `localhost:3000` and the
 * sandbox is `127.0.0.1:3001` — a different host, so the browser never sends it there.
 * That is the origin split doing a second job; one more reason not to "tidy" the two
 * servers onto one hostname.
 */
export function sessionId(req: Request, res: Response): string {
  const existing = (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([name]) => name === COOKIE)?.[1];
  if (existing) return existing;

  const id = randomBytes(24).toString("base64url");
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
  return id;
}
