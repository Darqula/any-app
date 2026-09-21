import { pool } from "./db";

export type MessageRole = "user" | "assistant";
export type MessageKind = "create" | "edit" | "error" | "note";

export interface Message {
  /** Strictly increasing across the whole table — the cursor for "everything after N". */
  seq: number;
  role: MessageRole;
  kind: MessageKind;
  target: string | null;
  body: string;
  created_at: Date;
}

/** Longest body stored. A message is a line or two of conversation, never a document; the
 *  cap also bounds what a misbehaving caller (or, later, a model) can put in one row. */
export const MAX_MESSAGE_LENGTH = 1000;

export interface NewMessage {
  role: MessageRole;
  kind: MessageKind;
  target?: string | null;
  body: string;
}

/**
 * Appends one message to an app's conversation. Ownership is NOT checked here — every caller
 * is server code that has already resolved the generation (the stream route, the edit route);
 * reading the log back is what is owner-gated, in the route.
 *
 * A generation deleted between the caller's check and this insert violates the foreign key;
 * that is reported to the caller like any other database error, and callers treat the log as
 * best-effort (see the studio's `recordMessage`).
 */
export async function appendMessage(generationId: string, message: NewMessage): Promise<void> {
  const body = message.body.length > MAX_MESSAGE_LENGTH
    ? message.body.slice(0, MAX_MESSAGE_LENGTH - 1) + "…"
    : message.body;
  await pool.query(
    `insert into messages (generation_id, role, kind, target, body) values ($1, $2, $3, $4, $5)`,
    [generationId, message.role, message.kind, message.target ?? null, body],
  );
}

/** Messages for one app after `afterSeq` (0 = from the start), oldest first. */
export async function listMessages(generationId: string, afterSeq = 0): Promise<Message[]> {
  const { rows } = await pool.query<Omit<Message, "seq"> & { seq: string }>(
    `select seq, role, kind, target, body, created_at from messages
     where generation_id = $1 and seq > $2 order by seq asc limit 500`,
    [generationId, afterSeq],
  );
  // bigserial comes back from pg as a string; sequence values stay far below 2^53.
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
}
