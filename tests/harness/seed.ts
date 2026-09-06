/**
 * Inserts canned `generations` rows directly via `pg` — deliberately NOT through
 * `@any-app/store`'s `createGeneration`/`markCompleteWithPlan`, for the same reason db.ts
 * avoids that package: this file must stay safe to call against several different scratch
 * databases within one test process, and `@any-app/store`'s pool is a module-scope
 * singleton bound to whichever `DATABASE_URL` was set the first time it was imported.
 *
 * This is the frontend suite's main lever (see `.docs/tests-frontend.md`'s "Seeding instead
 * of generating"): `internal.ts`'s `/internal/generations/:id/stream` route returns a
 * complete row's stored `document` *before* it claims the row and *before* it resolves any
 * credential, so a seeded `status=complete` row renders through the whole stack with no
 * provider configured at all.
 */
import pg from "pg";
import { mintAppToken } from "@any-app/protocol";

const { Pool } = pg;

export type GenerationStatus = "pending" | "streaming" | "complete" | "failed";

export interface SeedGenerationInput {
  /** Defaults to a placeholder — most callers only care about `document`/`plan`. */
  prompt?: string;
  status?: GenerationStatus;
  /** The flat assembled HTML. Required — this is what `getGeneration`/the stream route
   * actually serves for a `complete` row. */
  document: string;
  /** The decomposed shell+slots+content — a `FilledApp` shape from `@any-app/protocol`, or
   * `undefined` for a pre-Phase-2-shaped row. Stored as-is; JSONB round-trips it unchanged. */
  plan?: unknown;
  error?: string | null;
}

export interface SeededGeneration {
  id: string;
  /** `mintAppToken(id, secret)` — convenience so a caller doesn't need a separate import
   * just to mint the token for a seeded app (e.g. to call the sandbox's data API directly,
   * or to build the `Authorization` header for a K-series-style test). */
  appToken(secret: string): string;
}

/**
 * Inserts one row into `generations` on the given scratch database and returns its id.
 * Opens and closes its own short-lived `pg.Pool` — safe to call repeatedly, including
 * against different `databaseUrl`s in the same test file.
 */
export async function seedGeneration(
  databaseUrl: string,
  input: SeedGenerationInput,
): Promise<SeededGeneration> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `insert into generations (prompt, status, document, plan, error)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [
        input.prompt ?? "seeded generation",
        input.status ?? "complete",
        input.document,
        input.plan === undefined ? null : JSON.stringify(input.plan),
        input.error ?? null,
      ],
    );
    const id = rows[0]!.id;
    return { id, appToken: (secret: string) => mintAppToken(id, secret) };
  } finally {
    await pool.end();
  }
}

/** Re-exported so a caller who already has an id (e.g. from a prior `seedGeneration`, or
 * from a real `createGeneration` in a backend test) doesn't need a second import. */
export { mintAppToken };
