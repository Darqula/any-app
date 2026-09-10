import { pool } from "./db";
import { seal, open } from "./crypto";
import type { Owner } from "./owner";

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
 *
 * Keyed by `owner_id` for a signed-in user, `session_id` for anonymous — never both (see
 * migration 008's `credential_subject_ck`). The `on conflict` target has to name the right
 * partial unique index for the subject at hand, because a partial unique index only serves
 * `on conflict` when the clause matches it exactly.
 */
export async function saveCredential(
  owner: Owner,
  provider: string,
  apiKey: string,
  baseUrl: string | null,
): Promise<void> {
  const sealed = seal(apiKey);
  const hint = apiKey.slice(-4);
  const ownerId = owner.kind === "user" ? owner.userId : null;
  const sessionId = owner.kind === "user" ? null : owner.sessionId;

  await pool.query(
    `insert into provider_credentials
       (owner_id, session_id, provider, base_url, ciphertext, iv, tag, hint, validated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict ${owner.kind === "user"
       ? "(owner_id, provider) where owner_id is not null"
       : "(session_id, provider) where session_id is not null"}
     do update set base_url = $4, ciphertext = $5, iv = $6, tag = $7, hint = $8,
                   created_at = now(), validated_at = now()`,
    [ownerId, sessionId, provider, baseUrl, sealed.ciphertext, sealed.iv, sealed.tag, hint],
  );
}

/** Decrypts and returns one subject's credential for one provider, or null if none is stored. */
export async function getCredential(
  owner: Owner,
  provider: string,
): Promise<StoredCredential | null> {
  const { sql, param } =
    owner.kind === "user"
      ? { sql: "owner_id = $1", param: owner.userId }
      : { sql: "session_id = $1", param: owner.sessionId };
  const { rows } = await pool.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer; base_url: string | null }>(
    `select ciphertext, iv, tag, base_url from provider_credentials where ${sql} and provider = $2`,
    [param, provider],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    apiKey: open({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }),
    baseUrl: row.base_url,
  };
}

/** Provider, last-4-chars hint, and validation date only — never the key or ciphertext. */
export async function listCredentialHints(owner: Owner): Promise<CredentialHint[]> {
  const { sql, param } =
    owner.kind === "user"
      ? { sql: "owner_id = $1", param: owner.userId }
      : { sql: "session_id = $1", param: owner.sessionId };
  const { rows } = await pool.query<{ provider: string; hint: string; validated_at: Date | null }>(
    `select provider, hint, validated_at from provider_credentials where ${sql} order by provider`,
    [param],
  );
  return rows.map((r) => ({ provider: r.provider, hint: r.hint, validatedAt: r.validated_at }));
}

export async function deleteCredential(owner: Owner, provider: string): Promise<void> {
  const { sql, param } =
    owner.kind === "user"
      ? { sql: "owner_id = $1", param: owner.userId }
      : { sql: "session_id = $1", param: owner.sessionId };
  await pool.query(`delete from provider_credentials where ${sql} and provider = $2`, [param, provider]);
}
