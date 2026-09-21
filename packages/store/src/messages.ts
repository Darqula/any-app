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
 * Ownership is checked by callers; only reading the log back is owner-gated. A deleted generation
 * fails the foreign key, so callers treat the log as best-effort.
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

export async function listMessages(generationId: string, afterSeq = 0): Promise<Message[]> {
  const { rows } = await pool.query<Omit<Message, "seq"> & { seq: string }>(
    `select seq, role, kind, target, body, created_at from messages
     where generation_id = $1 and seq > $2 order by seq asc limit 500`,
    [generationId, afterSeq],
  );
  // bigserial comes back from pg as a string; sequence values stay far below 2^53.
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
}
