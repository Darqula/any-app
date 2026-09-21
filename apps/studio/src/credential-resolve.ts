import { roleConfig, resolve, NoCredentialError } from "@any-app/generator";
import type { Role, ProviderCredential, ProviderId } from "@any-app/generator";
import { getCredential } from "@any-app/store";
import type { Owner } from "@any-app/store";

const ROLES: Role[] = ["planner", "fill", "edit", "router"];

/** The caller's stored credential for the provider a role uses, or null (resolve() then uses the platform key). */
export async function credentialForRole(
  role: Role,
  owner: Owner,
): Promise<ProviderCredential | null> {
  const { provider } = roleConfig(role);
  const stored = await getCredential(owner, provider);
  if (!stored) return null;
  return { provider, apiKey: stored.apiKey, baseUrl: stored.baseUrl ?? undefined };
}

/** A role that would fail now: no credential (provider set) or misconfigured, e.g. no model (provider absent). */
export interface RoleProblem {
  role: Role;
  provider?: ProviderId;
  message: string;
}

/**
 * Every role that would fail now, checked as resolve() does but without an HTTP call, for the home-page banner.
 * credentialForRole stays inside the try: roleConfig() throws a plain Error for a role with no model.
 */
export async function missingCredentials(owner: Owner): Promise<RoleProblem[]> {
  const missing: RoleProblem[] = [];
  for (const role of ROLES) {
    try {
      const credential = await credentialForRole(role, owner);
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
