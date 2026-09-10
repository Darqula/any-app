import { pool } from "./db";
import { hashPassword, verifyPassword } from "./passwords";

export interface User {
  id: string;
  email: string;
  monthly_token_limit: number | null;
}

/** Returns null when the email is already taken — a unique-violation is an expected outcome
 *  here, not an exception. 23505 is Postgres's unique_violation SQLSTATE. */
export async function createUser(email: string, password: string): Promise<User | null> {
  try {
    const { rows } = await pool.query<User>(
      `insert into users (email, password_hash) values ($1, $2)
       returning id, email, monthly_token_limit`,
      [email.toLowerCase().trim(), await hashPassword(password)],
    );
    return rows[0]!;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
}

/**
 * Null on a wrong email OR a wrong password — never say which.
 *
 * The dummy verify on the unknown-email path is deliberate: without it, an unknown email
 * returns in ~1ms and a known one in ~100ms, which is a working account-enumeration oracle.
 */
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(88);

export async function authenticate(email: string, password: string): Promise<User | null> {
  const { rows } = await pool.query<User & { password_hash: string }>(
    `select id, email, monthly_token_limit, password_hash from users where email = $1`,
    [email.toLowerCase().trim()],
  );
  const row = rows[0];
  if (!row) {
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  return { id: row.id, email: row.email, monthly_token_limit: row.monthly_token_limit };
}

export async function getUser(id: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    `select id, email, monthly_token_limit from users where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
