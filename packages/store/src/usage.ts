import { pool } from "./db";

export interface UsageEvent {
  ownerId: string | null;
  generationId: string | null;
  role: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  billable: boolean;
}

/** Batches every usage event for one generation into a single round trip. Empty input is a
 *  no-op — callers collect events for a whole generation and write them once at the end. */
export async function recordUsage(events: UsageEvent[]): Promise<void> {
  if (events.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  for (const e of events) {
    const base = params.length;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
    );
    params.push(
      e.ownerId,
      e.generationId,
      e.role,
      e.provider,
      e.model,
      e.promptTokens,
      e.completionTokens,
      e.cachedTokens ?? 0,
      e.billable,
    );
  }
  await pool.query(
    `insert into usage_events
       (owner_id, generation_id, role, provider, model, prompt_tokens, completion_tokens, cached_tokens, billable)
     values ${values.join(", ")}`,
    params,
  );
}

/**
 * Sum of billable (prompt + completion) tokens this calendar month.
 * `date_trunc('month', now())` rather than a rolling 30 days so a user's allowance resets on
 * a date they can predict.
 *
 * Deliberately `prompt_tokens + completion_tokens`, NOT discounted by `cached_tokens`:
 * a cached prompt token is still inside `prompt_tokens` at
 * full weight, by design — this counts against the cap as real API usage, because it still
 * is (the provider still serves the request; caching only changes what WE pay, per
 * open-problems.md, not what the token accounted for). `cached_tokens` exists on the row as
 * a diagnostic/cost-accounting field for later, not as an input to this cap.
 */
export async function billableTokensThisMonth(userId: string): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `select coalesce(sum(prompt_tokens + completion_tokens), 0) as total
     from usage_events
     where owner_id = $1 and billable and created_at >= date_trunc('month', now())`,
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

/** The configured monthly cap for a user, or null for no cap. */
export async function monthlyLimitFor(userId: string): Promise<number | null> {
  const { rows } = await pool.query<{ monthly_token_limit: number | null }>(
    `select monthly_token_limit from users where id = $1`,
    [userId],
  );
  return rows[0]?.monthly_token_limit ?? null;
}
