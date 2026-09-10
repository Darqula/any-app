import { randomBytes } from "node:crypto";
import { pool } from "./db";

export interface SessionRow {
  id: string;
  user_id: string | null;
}

export async function createSession(userId: string | null): Promise<string> {
  const id = randomBytes(24).toString("base64url");
  await pool.query(`insert into sessions (id, user_id) values ($1, $2)`, [id, userId]);
  return id;
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const { rows } = await pool.query<SessionRow>(
    `update sessions set last_seen_at = now() where id = $1 returning id, user_id`,
    [id],
  );
  return rows[0] ?? null;
}

export async function deleteSession(id: string): Promise<void> {
  await pool.query(`delete from sessions where id = $1`, [id]);
}
