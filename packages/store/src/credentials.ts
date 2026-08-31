import { pool } from "./db";
import { seal, open } from "./crypto";

export interface StoredCredential {
  apiKey: string;
  baseUrl: string | null;
}

export interface CredentialHint {
  provider: string;
  hint: string;
  validatedAt: Date | null;
}

/**
 * Persists a credential that has already passed `provider.validate()` — the caller
 * validates first and only calls this on success (see settings.ts), so `validated_at` is
 * set here rather than needing a separate follow-up write.
 */
export async function saveCredential(
  sessionId: string,
  provider: string,
  apiKey: string,
  baseUrl: string | null,
): Promise<void> {
  const sealed = seal(apiKey);
  const hint = apiKey.slice(-4);
  await pool.query(
    `insert into provider_credentials (session_id, provider, base_url, ciphertext, iv, tag, hint, validated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (session_id, provider)
     do update set base_url = $3, ciphertext = $4, iv = $5, tag = $6, hint = $7,
                   created_at = now(), validated_at = now()`,
    [sessionId, provider, baseUrl, sealed.ciphertext, sealed.iv, sealed.tag, hint],
  );
}

/** Decrypts and returns one session's credential for one provider, or null if none is stored. */
export async function getCredential(
  sessionId: string,
  provider: string,
): Promise<StoredCredential | null> {
  const { rows } = await pool.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer; base_url: string | null }>(
    `select ciphertext, iv, tag, base_url from provider_credentials where session_id = $1 and provider = $2`,
    [sessionId, provider],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    apiKey: open({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }),
    baseUrl: row.base_url,
  };
}

/** Provider, last-4-chars hint, and validation date only — never the key or ciphertext. */
export async function listCredentialHints(sessionId: string): Promise<CredentialHint[]> {
  const { rows } = await pool.query<{ provider: string; hint: string; validated_at: Date | null }>(
    `select provider, hint, validated_at from provider_credentials where session_id = $1 order by provider`,
    [sessionId],
  );
  return rows.map((r) => ({ provider: r.provider, hint: r.hint, validatedAt: r.validated_at }));
}

export async function deleteCredential(sessionId: string, provider: string): Promise<void> {
  await pool.query(
    `delete from provider_credentials where session_id = $1 and provider = $2`,
    [sessionId, provider],
  );
}
