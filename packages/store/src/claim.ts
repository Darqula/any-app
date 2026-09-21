import { pool } from "./db";

/**
 * Re-keys one anonymous session's work to a new user, atomically. Sign-up only, not sign-in: on a
 * shared browser that would absorb the previous person's work. Signing in to an existing account
 * rotates the cookie, which orphans the old anonymous work.
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
