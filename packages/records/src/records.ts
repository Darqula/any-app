import { pool } from "./db";
import { MAX_RECORDS_PER_APP, MAX_RECORD_BYTES } from "./quota";
import { UUID_PATTERN } from "@any-app/protocol";

// Single source of truth is @any-app/protocol (shared with the planner's DATA-section
// parsing and the fill prompts' collection list) — re-exported here so sandbox/data.ts can
// import it from the same place it imports everything else records-shaped.
export { COLLECTION_PATTERN, UUID_PATTERN } from "@any-app/protocol";

/**
 * One stored row, as returned to a caller. Deliberately NOT named `Record` — that shadows
 * TypeScript's built-in `Record<K, V>` utility type, which `listRecords`'s `where` parameter
 * below needs. Deliberately does not include `app_id`: every function here already scopes
 * on it internally, and it is not part of the JSON the data API hands back to a generated
 * app (see impl-phase-5.md step 5's response shapes).
 */
export interface RecordRow {
  id: string;
  collection: string;
  data: unknown;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = "id, collection, data, created_at, updated_at";

/**
 * Every function below takes `appId` as its first argument, and callers only ever get it
 * from `verifyAppToken` (never from a request body, a query string, or a hostname — see
 * .docs/architecture.md's data-API rules). A record id is not an authorization token: every
 * statement here filters on `app_id`, without exception, including the ones that already
 * have a primary key in hand.
 */

/**
 * Enforces the row quota inside the insert itself, not before it. This is approximate under
 * concurrency and that is the right call — two simultaneous inserts at exactly the limit can
 * both pass and land the app at MAX_RECORDS_PER_APP + 1 rows. Making it exact needs a
 * serializable transaction or a lock on every write, on a path whose entire purpose is to be
 * cheap. A quota is a bound on runaway growth, not a ledger; being over by one occasionally
 * costs nothing. Returns null (not a thrown error) when the quota is full, so the caller can
 * respond 409 — that is an expected outcome here, not an exceptional one.
 */
export async function createRecord(
  appId: string,
  collection: string,
  data: unknown,
): Promise<RecordRow | null> {
  const { rows } = await pool.query<RecordRow>(
    `insert into records (app_id, collection, data)
     select $1, $2, $3::jsonb
     where (select count(*) from records where app_id = $1) < $4
     returning ${SELECT_COLUMNS}`,
    [appId, collection, JSON.stringify(data), MAX_RECORDS_PER_APP],
  );
  return rows[0] ?? null;
}

/**
 * `data @> '{}'::jsonb` matches every row, so the unfiltered list needs no second code path.
 * It is also exactly what `records_data_idx` (a jsonb_path_ops GIN index) serves — see
 * .docs/impl-phase-5.md step 5: the API is deliberately exactly as wide as that index can
 * answer.
 */
export async function listRecords(
  appId: string,
  collection: string,
  where: Record<string, string | number | boolean>,
  limit: number,
  before?: { createdAt: string; id: string },
): Promise<RecordRow[]> {
  const params: unknown[] = [appId, collection, JSON.stringify(where), limit];
  let cursorClause = "";
  if (before) {
    params.push(before.createdAt, before.id);
    cursorClause = `and (created_at, id) < ($5, $6)`;
  }
  const { rows } = await pool.query<RecordRow>(
    `select ${SELECT_COLUMNS}
       from records
      where app_id = $1 and collection = $2 and data @> $3::jsonb ${cursorClause}
      order by created_at desc, id desc
      limit $4`,
    params,
  );
  return rows;
}

export async function getRecord(
  appId: string,
  collection: string,
  id: string,
): Promise<RecordRow | null> {
  const { rows } = await pool.query<RecordRow>(
    `select ${SELECT_COLUMNS} from records where app_id = $1 and collection = $2 and id = $3`,
    [appId, collection, id],
  );
  return rows[0] ?? null;
}

/**
 * PATCH semantics: a shallow merge of `patch` over the stored object. `express.json`'s
 * request-body limit (see data.ts) bounds one PATCH's own size, but the merge is cumulative
 * — a loop of distinct-key patches, each individually under that limit, grows one row
 * without bound, and the row quota only counts rows, not bytes. Guarded here the same way
 * the row quota is (a `where` clause the insert/update can fail against), not in application
 * code after the fact, for the same concurrency reason `createRecord`'s doc comment gives.
 *
 * Zero rows back is ambiguous between "not found" and "merge would exceed the size limit" —
 * the caller (data.ts) distinguishes the two with a follow-up `getRecord` rather than this
 * function guessing, since only the caller needs to turn that into a 404 vs a 413.
 */
export async function updateRecord(
  appId: string,
  collection: string,
  id: string,
  patch: unknown,
): Promise<RecordRow | null> {
  const { rows } = await pool.query<RecordRow>(
    `update records set data = data || $4::jsonb, updated_at = now()
     where app_id = $1 and collection = $2 and id = $3
       and octet_length((data || $4::jsonb)::text) <= $5
     returning ${SELECT_COLUMNS}`,
    [appId, collection, id, JSON.stringify(patch), MAX_RECORD_BYTES],
  );
  return rows[0] ?? null;
}

/** PUT semantics: the stored object is replaced wholesale. */
export async function replaceRecord(
  appId: string,
  collection: string,
  id: string,
  data: unknown,
): Promise<RecordRow | null> {
  const { rows } = await pool.query<RecordRow>(
    `update records set data = $4::jsonb, updated_at = now()
     where app_id = $1 and collection = $2 and id = $3
     returning ${SELECT_COLUMNS}`,
    [appId, collection, id, JSON.stringify(data)],
  );
  return rows[0] ?? null;
}

export async function deleteRecord(appId: string, collection: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from records where app_id = $1 and collection = $2 and id = $3`,
    [appId, collection, id],
  );
  return rowCount === 1;
}

/** Opaque pagination cursor — `nextCursor` in a list response. Never parsed by the client. */
export function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(`${row.created_at}|${row.id}`, "utf8").toString("base64url");
}

/**
 * Null on anything malformed — a bad cursor should read as "no more pages", not throw.
 * Validates both halves, not just that a separator exists (Phase 5 review S2: the earlier
 * version let `base64url("x|y")` reach Postgres as a real query parameter, which failed
 * loudly as an `invalid input syntax` error instead of the 400 this function's own docstring
 * already promised). `id` must look like a uuid; `createdAt` must parse as a real instant —
 * both are exactly what `listRecords`'s `(created_at, id) < ($5, $6)` clause needs to bind
 * against typed columns without ever reaching the database malformed.
 */
export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.lastIndexOf("|");
  if (sep <= 0) return null;
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!UUID_PATTERN.test(id)) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
}
