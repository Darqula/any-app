import { roleConfig, resolve, NoCredentialError } from "@any-app/generator";
import type { Role, ProviderCredential, ProviderId } from "@any-app/generator";
import { getCredential } from "@any-app/store";

const ROLES: Role[] = ["planner", "fill", "edit", "router"];

/**
 * Looks up the session's stored credential for whichever provider a role is configured to
 * use — `roleConfig` decides the provider, this decides whether the session has its own key
 * for it. Returns null when the session has none, in which case `resolve()` (generator)
 * falls back to the platform credential from `.env`.
 */
export async function credentialForRole(
  role: Role,
  sessionId: string,
): Promise<ProviderCredential | null> {
  const { provider } = roleConfig(role);
  const stored = await getCredential(sessionId, provider);
  if (!stored) return null;
  return { provider, apiKey: stored.apiKey, baseUrl: stored.baseUrl ?? undefined };
}

/**
 * Every role that would fail right now for lack of a credential — checked the same way
 * `resolve()` checks it (session credential, then platform `.env`), without making any
 * HTTP call. Used to show a banner before a generation is attempted, rather than letting
 * someone discover the gap as a failed generation.
 */
export async function missingCredentials(
  sessionId: string,
): Promise<{ role: Role; provider: ProviderId }[]> {
  const missing: { role: Role; provider: ProviderId }[] = [];
  for (const role of ROLES) {
    const credential = await credentialForRole(role, sessionId);
    try {
      resolve(role, credential);
    } catch (error) {
      if (error instanceof NoCredentialError) missing.push({ role, provider: error.provider });
    }
  }
  return missing;
}
