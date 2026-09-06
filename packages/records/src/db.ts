import pg from "pg";
import { existsSync } from "node:fs";

// `pg` is a CommonJS package. Import the default export and destructure it;
// named imports are not reliable here.
const { Pool, types } = pg;

// OID 1184 is `timestamptz`. Left at its default, `pg` hands back a JS `Date`, and
// `Date.prototype.toString()` (e.g. "Tue Sep 01 2026 16:18:56 GMT+0500 (Kazakhstan Time)")
// is what `records.ts`'s `encodeCursor` was silently embedding in every pagination cursor —
// `Date.parse` happily re-parses that shape, so `decodeCursor`'s own validation never caught
// it, but Postgres's `timestamptz` input parser rejects it outright (SQLSTATE 22023) the
// moment a cursor comes back round-trip as a bind parameter. See testing-review.md S1.
//
// The first fix here went through a JS `Date` (`new Date(value).toISOString()`), which fixed
// the 500 but silently reintroduced a narrower version of the same problem (S1-R, caught on
// review): `Date` has millisecond resolution, Postgres's `timestamptz` stores microseconds
// (confirmed live: `select now()` on this database returns e.g. `...686107+00`), so the
// cursor was quietly truncating the boundary row's timestamp downward. Two distinct rows
// landing in the same millisecond — same page-boundary row, different microseconds — would
// both compare as "not less than" the truncated cursor and vanish off both pages with no
// error. Fixed properly by parsing Postgres's own text by hand instead of round-tripping it
// through `Date` at all, keeping every microsecond Postgres actually stored.
//
// `SET TIME ZONE 'UTC'` on every new connection (installed below, once `pool` exists) is
// what makes the `+00` this regex assumes an invariant rather than an accident of this
// machine's current session default (confirmed UTC via `show timezone`, but that is this
// docker container's default, not something this code should depend on without asking for
// it explicitly).
const TIMESTAMPTZ_TEXT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?\+00$/;

types.setTypeParser(1184, (value: string) => {
  const match = TIMESTAMPTZ_TEXT.exec(value);
  if (!match) {
    // Should not happen given the `SET TIME ZONE 'UTC'` above, but fail toward something that
    // still round-trips as a valid (if millisecond-truncated) instant rather than crashing the
    // parser outright on an unexpected shape (a non-UTC offset, a BC date, etc).
    return new Date(value).toISOString();
  }
  const [, date, time, fraction] = match;
  const micros = (fraction ?? "0").padEnd(6, "0");
  return `${date}T${time}.${micros}Z`;
});

// Deliberately NOT @any-app/store's loadEnv — this package must not depend on
// @any-app/store (see package.json and .docs/architecture.md's "Dependency rules"). This is
// the same ~15 lines duplicated on purpose: two pools against one database is the point of
// this whole package, not an accident (see records.ts's doc comment), and that only holds if
// this package never shares a module graph with the one that owns provider credentials.
//
// Exported (Phase 5 review S1) so apps/sandbox/src/index.ts can import loadEnv from HERE
// instead of from @any-app/store. Importing even one named export off @any-app/store
// evaluates that package's whole module graph — including db.ts's own top-level
// `new Pool({connectionString: requireEnv("DATABASE_URL")})`, which builds a pool
// authenticated as the *privileged* role, plus pulls `getCredential`/`saveCredential` into
// the sandbox process. `pg`'s Pool is lazy, so nothing actually connects — but the whole
// point of the restricted role was that the sandbox has no way out of that role. A latent
// privileged pool one `import { pool }` away undoes that, even unused.
let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const candidate of [".env", "../../.env", "../../../.env"]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

loadEnv();

// A role with rights to `records` and nothing else — it must never be able to read
// generations or provider_credentials. Falls back to DATABASE_URL only so a fresh checkout
// boots; that fallback is a development convenience and is wrong in any shared environment
// (see .env.example's SANDBOX_DATABASE_URL comment).
const connectionString = process.env.SANDBOX_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "Missing required environment variable: SANDBOX_DATABASE_URL (or DATABASE_URL as a dev fallback)",
  );
}

// See the TIMESTAMPTZ_TEXT comment above: `options: "-c TimeZone=UTC"` is what guarantees
// every `timestamptz` this pool ever reads comes back with a `+00` offset, regardless of
// what a given Postgres role, database, or deployment happens to default `TimeZone` to. This
// is a libpq startup parameter, applied before the connection accepts its first query — not
// a follow-up `SET TIME ZONE` issued from a `pool.on("connect", ...)` handler, which raced
// against whatever query the caller that triggered the new connection issues next (both
// land on the same client; node-postgres queues same-client queries in submission order
// regardless of awaiting, so it was never a correctness bug, but it did throw pg's own
// "query() called while already executing" deprecation warning under real concurrency —
// confirmed while verifying this fix. The startup-parameter form has no such window.
export const pool = new Pool({ connectionString, options: "-c TimeZone=UTC" });
