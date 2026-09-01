import pg from "pg";
import { existsSync } from "node:fs";

// `pg` is a CommonJS package. Import the default export and destructure it;
// named imports are not reliable here.
const { Pool } = pg;

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

export const pool = new Pool({ connectionString });
