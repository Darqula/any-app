import { pool } from "./db";

export type GenerationStatus = "pending" | "streaming" | "complete" | "failed";

export interface Generation {
  id: string;
  prompt: string;
  status: GenerationStatus;
  document: string | null;
  /** The decomposed shell + slots + content. Written in Phase 2, read from Phase 3. */
  plan: unknown | null;
  error: string | null;
  created_at: Date;
}

export async function createGeneration(prompt: string): Promise<Generation> {
  const { rows } = await pool.query<Generation>(
    `insert into generations (prompt) values ($1)
     returning id, prompt, status, document, plan, error, created_at`,
    [prompt],
  );
  return rows[0]!;
}

export async function getGeneration(id: string): Promise<Generation | null> {
  const { rows } = await pool.query<Generation>(
    `select id, prompt, status, document, plan, error, created_at
     from generations where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Atomically claims a row for generation. Returns false if it is already `streaming`
 * (someone else is generating it right now) or already `complete`, so the caller never
 * starts a second concurrent call for the same id — e.g. a reload mid-generation.
 *
 * A row stuck in `streaming` from a crashed process is deliberately NOT reclaimed here.
 * That needs either a manual reset or a future sweeper keyed on `updated_at`; silently
 * reclaiming it would risk two calls racing on a merely-slow one.
 */
export async function claimForGeneration(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update generations set status = 'streaming', updated_at = now()
     where id = $1 and status in ('pending', 'failed')`,
    [id],
  );
  return rowCount === 1;
}

/**
 * Puts a generation back in `pending` so a later request can retry it. Used when the
 * viewer disconnects mid-stream — a half-written document must never be saved as
 * `complete`, and leaving the row in `streaming` would make `claimForGeneration` refuse
 * every retry.
 */
export async function resetForRetry(id: string): Promise<void> {
  await pool.query(
    `update generations set status = 'pending', updated_at = now() where id = $1`,
    [id],
  );
}

export async function markComplete(id: string, document: string): Promise<void> {
  await pool.query(
    `update generations
     set status = 'complete', document = $2, error = null, updated_at = now()
     where id = $1`,
    [id, document],
  );
}

/**
 * Same as `markComplete`, plus the decomposed plan (shell + slots + per-slot content) for
 * Phase 3 to read back and edit. `document` stays the flat assembled HTML so the replay
 * path never has to know the difference between a Phase 1 and a Phase 2 row.
 */
export async function markCompleteWithPlan(
  id: string,
  document: string,
  plan: unknown,
): Promise<void> {
  await pool.query(
    `update generations
     set status = 'complete', document = $2, plan = $3, error = null, updated_at = now()
     where id = $1`,
    [id, document, JSON.stringify(plan)],
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await pool.query(
    `update generations set status = 'failed', error = $2, updated_at = now() where id = $1`,
    [id, error],
  );
}

export async function listRecentGenerations(limit = 20): Promise<Generation[]> {
  const { rows } = await pool.query<Generation>(
    `select id, prompt, status, document, plan, error, created_at
     from generations order by created_at desc limit $1`,
    [limit],
  );
  return rows;
}
