import { pool } from "./db";
import { isFilledApp } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import { ownerFilter } from "./owner";
import type { Owner } from "./owner";

export type GenerationStatus = "pending" | "streaming" | "complete" | "failed";
export type Visibility = "private" | "unlisted" | "public";

export interface Generation {
  id: string;
  prompt: string;
  status: GenerationStatus;
  document: string | null;
  /** The decomposed shell + slots + content. Written in Phase 2, read from Phase 3. */
  plan: unknown | null;
  error: string | null;
  /** Bumped on every successful edit. The optimistic-lock key for `saveEditedApp`. */
  version: number;
  owner_id: string | null;
  session_id: string | null;
  visibility: Visibility;
  forked_from: string | null;
  created_at: Date;
}

const GENERATION_COLUMNS =
  "id, prompt, status, document, plan, error, version, owner_id, session_id, visibility, forked_from, created_at";

export async function createGeneration(prompt: string, owner: Owner): Promise<Generation> {
  const { rows } = await pool.query<Generation>(
    `insert into generations (prompt, owner_id, session_id) values ($1, $2, $3)
     returning ${GENERATION_COLUMNS}`,
    [
      prompt,
      owner.kind === "user" ? owner.userId : null,
      owner.kind === "user" ? null : owner.sessionId,
    ],
  );
  return rows[0]!;
}

/**
 * Unscoped. The ONLY caller is the internal stream route, which is reached from the sandbox
 * and has no session to scope by — it authorizes with the view grant and `visibility`
 * instead (see apps/studio/src/internal.ts and view-grant.ts). Never call this from a studio
 * route that acts on behalf of a specific signed-in browser.
 */
export async function getGeneration(id: string): Promise<Generation | null> {
  const { rows } = await pool.query<Generation>(
    `select ${GENERATION_COLUMNS} from generations where id = $1`,
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

export async function listRecentGenerations(owner: Owner, limit = 20): Promise<Generation[]> {
  const { sql, param } = ownerFilter(owner, 1);
  const { rows } = await pool.query<Generation>(
    `select ${GENERATION_COLUMNS} from generations where ${sql}
     order by created_at desc limit $2`,
    [param, limit],
  );
  return rows;
}

export async function setVisibility(
  id: string,
  owner: Owner,
  visibility: Visibility,
): Promise<boolean> {
  const { sql, param } = ownerFilter(owner, 3);
  const { rowCount } = await pool.query(
    `update generations set visibility = $1, updated_at = now() where id = $2 and ${sql}`,
    [visibility, id, param],
  );
  return rowCount === 1;
}

export interface LoadedApp {
  filled: FilledApp;
  version: number;
}

/** Reads the decomposed app back for its owner, or null if the row is not theirs, predates
 *  Phase 2, or is malformed. */
export async function getFilledApp(id: string, owner: Owner): Promise<LoadedApp | null> {
  const { sql, param } = ownerFilter(owner, 2);
  const { rows } = await pool.query<{ plan: unknown; version: number }>(
    `select plan, version from generations where id = $1 and status = 'complete' and ${sql}`,
    [id, param],
  );
  const row = rows[0];
  if (!row || !isFilledApp(row.plan)) return null;
  // A row written before Phase 5 has no `collections` key at all — plan is JSONB and every
  // app generated before this phase predates the field. Default it here so the first edit
  // of a pre-Phase-5 app does not throw on `plan.collections.map`. Same class of bug as
  // Phase 3's `document !== flat`: a field added to a persisted shape is a migration of
  // *reads*, even when the column itself never changed.
  const filled: FilledApp = { ...row.plan, collections: row.plan.collections ?? [] };
  return { filled, version: row.version };
}

/**
 * Writes an edited app back, but only if nobody else edited it in the meantime AND it still
 * belongs to this owner. The model call sits between reading the app and writing it, and
 * that call takes seconds. Holding a transaction open across it would pin a connection for
 * the whole round trip, so concurrency is handled optimistically instead: the write fails if
 * the version moved (or ownership doesn't match), and the caller tells the user to retry.
 */
export async function saveEditedApp(
  id: string,
  owner: Owner,
  filled: FilledApp,
  document: string,
  expectedVersion: number,
): Promise<boolean> {
  const { sql, param } = ownerFilter(owner, 5);
  const { rowCount } = await pool.query(
    `update generations
     set plan = $2, document = $3, version = version + 1, updated_at = now()
     where id = $1 and version = $4 and ${sql}`,
    [id, JSON.stringify(filled), document, expectedVersion, param],
  );
  return rowCount === 1;
}

/**
 * Copies the PLAN, never the DOCUMENT.
 *
 * `generations.document` embeds the data runtime's app-token placeholder (Phase 6 step 7) —
 * copying it verbatim would be harmless token-wise (the placeholder carries no app identity),
 * but the document is still re-rendered rather than copied so a fork always reflects the
 * CURRENT renderer (`renderDocument` is the single producer of a document; a fork is one
 * more caller, not an exception) and so `forked_from`/ownership land atomically with content
 * that is unambiguously the fork's own row.
 *
 * `renderDocumentFor` takes only `filled`, not the fork's new id: that is correct, not an
 * oversight — the id would only matter to embed a live app
 * token, and the document never carries one any more (it carries the placeholder, same as
 * every other render). Don't add the parameter back to "look more complete".
 */
export async function forkGeneration(
  source: Generation,
  owner: Owner,
  renderDocumentFor: (filled: FilledApp) => string,
): Promise<Generation> {
  const { rows } = await pool.query<Generation>(
    `insert into generations (prompt, plan, status, visibility, forked_from, owner_id, session_id, version)
     values ($1, $2, 'complete', 'private', $3, $4, $5, 1)
     returning ${GENERATION_COLUMNS}`,
    [
      source.prompt,
      source.plan,
      source.id,
      owner.kind === "user" ? owner.userId : null,
      owner.kind === "user" ? null : owner.sessionId,
    ],
  );
  const fork = rows[0]!;
  const document = renderDocumentFor(source.plan as FilledApp);
  await pool.query(`update generations set document = $1 where id = $2`, [document, fork.id]);
  return { ...fork, document };
}
