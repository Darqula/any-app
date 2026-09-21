import { pool } from "./db";
import { MAX_RECORDS_PER_APP, MAX_RECORD_BYTES } from "./quota";
import { UUID_PATTERN } from "@any-app/protocol";

// Single source is @any-app/protocol; re-exported for the sandbox routes.
export { COLLECTION_PATTERN, UUID_PATTERN } from "@any-app/protocol";

/**
 * One stored row as returned to callers. Not named `Record` (it would shadow the TS utility type) and
 * without app_id (not part of the API's JSON).
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
 * appId comes only from verifyAppToken, never from a request. Every statement filters on app_id,
 * even when a primary key is in hand.
 */

/**
 * The quota is enforced in the insert: approximate under concurrency, and that is fine (it bounds growth,
 * it is not a ledger). Returns null when full so the caller can answer 409.
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

/** `data @> '{}'` matches every row, so an unfiltered list needs no second path; records_data_idx serves it. */
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
 * PATCH merges shallowly. The merge is cumulative, so the size limit is enforced in the SQL where clause.
 * Zero rows is ambiguous (missing vs too large): the caller disambiguates with getRecord.
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

/**
 * Opaque pagination cursor. created_at must keep full microsecond precision (see db.ts); ISO_INSTANT_PATTERN
 * must match what the parser emits.
 */
export function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(`${row.created_at}|${row.id}`, "utf8").toString("base64url");
}

// The exact shape db.ts emits and Postgres accepts losslessly. A looser check only delays failure to the database.
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Null on anything malformed (reads as "no more pages"). Validates both halves so nothing malformed
 * reaches Postgres.
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
  if (!ISO_INSTANT_PATTERN.test(createdAt)) return null;
  return { createdAt, id };
}
