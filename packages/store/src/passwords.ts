import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * N=2^15, r=8 needs ~33.5MB, just over Node's 32MB default maxmem, which makes scrypt throw with an
 * unhelpful message. Async form only: scryptSync would block the event loop for ~100ms.
 */
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

/** Format: `scrypt$N$r$p$<salt-base64>$<hash-base64>`. The parameters travel with the hash so
 *  they can be raised later without invalidating every existing password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Constant-time where it matters. Returns false on any malformed stored value rather than
 *  throwing — a corrupt row must not become a 500 on the sign-in path. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  // Reject fields that decode to (near) nothing: Buffer.from("base64") drops bad characters, and an empty key
  // would make timingSafeEqual pass for any password. A range check, so KEYLEN can be raised later.
  if (salt.length < 16 || expected.length < 32) return false;

  const actual = await scryptAsync(password, salt, expected.length, {
    N, r, p, maxmem: 64 * 1024 * 1024,
  });
  // timingSafeEqual throws on differing lengths, so check first.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
