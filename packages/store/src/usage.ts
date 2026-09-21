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

/** One round trip per generation. Empty input is a no-op. */
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
 * Billable prompt + completion tokens this calendar month (a predictable reset date).
 * Not discounted by cached_tokens: a cached token is still real API usage.
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
