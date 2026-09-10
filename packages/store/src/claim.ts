import { pool } from "./db";

/**
 * Re-keys one anonymous session's work to a new user, atomically.
 *
 * Called on SIGN-UP only. Not on sign-in, and that asymmetry is deliberate: on a shared or
 * kiosk browser, claiming at sign-in would absorb whatever the previous person left in that
 * anonymous session into an established account.
 *
 * The cost is NOT "anonymous work stays anonymous, reachable only
 * while that cookie lives" — an earlier version of this comment said so, and it was wrong on
 * both halves. `signInAs` (session.ts) ROTATES the cookie on every sign-in (correctly — reusing
 * it would be session fixation), so signing in to an EXISTING account is the end of that old
 * cookie's life: the anonymous session's generations keep `session_id = <the old, now-dead
 * id>`, no browser will ever present that value again, and they become unreachable from that
 * moment, not merely "still there if you don't clear cookies". `authForms` (views.ts) says so
 * on the sign-in form now — see its own comment for why this fix belongs in two places, not
 * one.
 */
export async function claimAnonymousWork(sessionId: string, userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update generations set owner_id = $1, session_id = null
       where session_id = $2 and owner_id is null`,
      [userId, sessionId],
    );
    await client.query(
      `update provider_credentials set owner_id = $1, session_id = null
       where session_id = $2 and owner_id is null`,
      [userId, sessionId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
