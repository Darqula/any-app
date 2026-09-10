import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * N=2^15, r=8 needs 128*N*r = 33,554,432 bytes — just over Node's 32MB default `maxmem`, so
 * scrypt THROWS rather than degrading, and the error text names neither the parameter nor the
 * limit. This is the single most likely way to lose an afternoon in this step.
 *
 * The async form, never `scryptSync`: at these parameters it occupies a core for ~100ms, and
 * this process is simultaneously streaming generations to browsers. Blocking the event loop
 * there is exactly the stall the whole architecture exists to avoid.
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
  // `Buffer.from(x, "base64")` silently drops invalid characters rather than throwing, so a
  // corrupt field (e.g. all-punctuation) decodes to a zero-length buffer instead of failing
  // here — and scrypt is happy to produce a zero-length key for `keylen: 0`, which would make
  // the comparison below `timingSafeEqual(<empty>, <empty>)`, i.e. true, for ANY password. A
  // field that decoded to (near-)nothing is a corrupt row, not a zero-length password hash.
  // Range check, not `=== KEYLEN`: the parameters travel with the hash so KEYLEN can be
  // raised later without invalidating every existing row.
  if (salt.length < 16 || expected.length < 32) return false;

  const actual = await scryptAsync(password, salt, expected.length, {
    N, r, p, maxmem: 64 * 1024 * 1024,
  });
  // timingSafeEqual throws on differing lengths, so check first.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
