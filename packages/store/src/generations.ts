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
  /** The decomposed shell + slots + content, used by edits. */
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

/** Unscoped: only the internal stream route (no session; authorised by view grant) may call this. */
export async function getGeneration(id: string): Promise<Generation | null> {
  const { rows } = await pool.query<Generation>(
    `select ${GENERATION_COLUMNS} from generations where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Atomically claims a row. False if already streaming or complete. A row stuck in `streaming` after
 * a crash is deliberately not reclaimed (a sweeper would need care not to race a slow call).
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
 * Back to `pending` after a disconnect: a half-written document must not be saved as complete,
 * and `streaming` would make claimForGeneration refuse every retry.
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

/** Also stores the decomposed plan for edits. `document` stays flat so replay ignores the difference. */
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

/** Reads the decomposed app back for its owner, or null if the row is not theirs, has no plan or is malformed. */
export async function getFilledApp(id: string, owner: Owner): Promise<LoadedApp | null> {
  const { sql, param } = ownerFilter(owner, 2);
  const { rows } = await pool.query<{ plan: unknown; version: number }>(
    `select plan, version from generations where id = $1 and status = 'complete' and ${sql}`,
    [id, param],
  );
  const row = rows[0];
  if (!row || !isFilledApp(row.plan)) return null;
  // Older rows lack `collections`: a field added to persisted JSONB needs a default on read.
  const filled: FilledApp = { ...row.plan, collections: row.plan.collections ?? [] };
  return { filled, version: row.version };
}

/**
 * Optimistic concurrency: fails if the version moved or ownership changed, because holding a transaction
 * across a multi-second model call would pin a connection.
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
 * Copies the plan, never the document, so a fork always uses the current renderer and lands atomically.
 * renderDocumentFor takes no id on purpose: documents carry a placeholder, never a live token.
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

export type DeleteResult = "deleted" | "missing" | "busy";

/** A streaming row this old is assumed to belong to a crashed process and stays deletable. */
const STALE_STREAMING_INTERVAL = "15 minutes";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes an app and its records, for its owner only ("missing" also means "not yours").
 * Refuses a live generation ("busy"): its usage write, keyed to this row, would fail and dodge the monthly cap.
 * records has no foreign key (restricted role), so it is deleted explicitly in the same transaction.
 */
export async function deleteGeneration(
  id: string,
  owner: Owner,
  /** For work the database cannot see, such as a follow-up edit (it leaves status at `complete`). */
  isBusy: (id: string) => boolean = () => false,
): Promise<DeleteResult> {
  if (!UUID_RE.test(id)) return "missing";
  const { sql, param } = ownerFilter(owner, 2);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ status: GenerationStatus; stale: boolean }>(
      `select status, updated_at < now() - interval '${STALE_STREAMING_INTERVAL}' as stale
       from generations where id = $1 and ${sql} for update`,
      [id, param],
    );
    const row = rows[0];
    if (!row) {
      await client.query("rollback");
      return "missing";
    }
    if ((row.status === "streaming" && !row.stale) || isBusy(id)) {
      await client.query("rollback");
      return "busy";
    }
    await client.query(`delete from records where app_id = $1`, [id]);
    await client.query(`delete from generations where id = $1`, [id]);
    await client.query("commit");
    return "deleted";
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
