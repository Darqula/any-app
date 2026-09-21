/**
 * Inserts canned generations rows with pg, not @any-app/store (module-scope pool singleton). A seeded status=complete row
 * renders with no provider configured, since the internal route serves a complete document before claiming or resolving
 * credentials. Defaults to visibility "unlisted" so previews need no grant.
 */
import pg from "pg";
import { mintAppToken } from "@any-app/protocol";
import type { TokenMode } from "@any-app/protocol";

const { Pool } = pg;

export type GenerationStatus = "pending" | "streaming" | "complete" | "failed";
export type Visibility = "private" | "unlisted" | "public";

export interface SeedGenerationInput {
  /** Defaults to a placeholder — most callers only care about `document`/`plan`. */
  prompt?: string;
  status?: GenerationStatus;
  /** The flat assembled HTML. Required — this is what `getGeneration`/the stream route
   * actually serves for a `complete` row. */
  document: string;
  /** The decomposed FilledApp, or undefined for a row with no plan. Stored as-is. */
  plan?: unknown;
  error?: string | null;
  /** Defaults to `"unlisted"` — see the file-level doc comment. */
  visibility?: Visibility;
  ownerId?: string | null;
  sessionId?: string | null;
}

export interface SeededGeneration {
  id: string;
  /** mintAppToken for the seeded app. Defaults to "rw". */
  appToken(secret: string, mode?: TokenMode): string;
}

/** Inserts one row and returns its id. Opens and closes its own short-lived pool. */
export async function seedGeneration(
  databaseUrl: string,
  input: SeedGenerationInput,
): Promise<SeededGeneration> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `insert into generations (prompt, status, document, plan, error, visibility, owner_id, session_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        input.prompt ?? "seeded generation",
        input.status ?? "complete",
        input.document,
        input.plan === undefined ? null : JSON.stringify(input.plan),
        input.error ?? null,
        input.visibility ?? "unlisted",
        input.ownerId ?? null,
        input.sessionId ?? null,
      ],
    );
    const id = rows[0]!.id;
    return { id, appToken: (secret: string, mode: TokenMode = "rw") => mintAppToken(id, mode, secret) };
  } finally {
    await pool.end();
  }
}

/** Re-exported so a caller who already has an id (e.g. from a prior `seedGeneration`, or
 * from a real `createGeneration` in a backend test) doesn't need a second import. */
export { mintAppToken };
