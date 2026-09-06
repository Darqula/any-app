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

/** One role that would fail right now — either for lack of a credential (`provider` is set,
 * the usual case) or because the role itself is misconfigured, e.g. no model at all
 * (`provider` is absent — `roleConfig()` throws before it can even report which provider it
 * was resolving for). Both render through the same home-page banner; see `message`. */
export interface RoleProblem {
  role: Role;
  provider?: ProviderId;
  message: string;
}

/**
 * Every role that would fail right now — checked the same way `resolve()` checks it
 * (session credential, then platform `.env`), without making any HTTP call. Used to show a
 * banner before a generation is attempted, rather than letting someone discover the gap as
 * a failed generation or, worse, a 500 on the home page itself.
 *
 * `credentialForRole` is deliberately inside this `try`, not called ahead of it (testing-review.md
 * S3): it calls `roleConfig()`, which throws a plain `Error` — not `NoCredentialError` — when
 * a role has no model configured at all. That used to propagate straight out of this
 * function, out of `GET /`, and into a 500; now it is caught here alongside the credential
 * case and shown as the same kind of banner instead.
 */
export async function missingCredentials(sessionId: string): Promise<RoleProblem[]> {
  const missing: RoleProblem[] = [];
  for (const role of ROLES) {
    try {
      const credential = await credentialForRole(role, sessionId);
      resolve(role, credential);
    } catch (error) {
      if (error instanceof NoCredentialError) {
        missing.push({ role, provider: error.provider, message: `${role} needs ${error.provider}` });
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`missingCredentials: role "${role}" is misconfigured:`, error);
        missing.push({ role, message: `${role} is misconfigured (${detail})` });
      }
    }
  }
  return missing;
}
