import { roleConfig } from "./roles";
import type { Role } from "./roles";
import { createOpenAIProvider } from "./providers/openai";
import { createAnthropicProvider } from "./providers/anthropic";
import type { Provider, ProviderCredential, ProviderId } from "./providers/types";

export interface Resolved {
  provider: Provider;
  model: string;
  maxTokens: number;
  /** Everything that must never appear in an error message. */
  secrets: string[];
  /**
   * True when the platform key was used, i.e. this call costs money. BYOK calls are recorded but
   * never count against the monthly cap.
   */
  usedPlatformCredential: boolean;
}

export class NoCredentialError extends Error {
  constructor(public readonly provider: ProviderId) {
    super(`No credential configured for ${provider}. Add one in settings.`);
    this.name = "NoCredentialError";
  }
}

function platformCredential(provider: ProviderId): ProviderCredential | null {
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    return apiKey ? { provider, apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL } : null;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  return apiKey ? { provider, apiKey, baseUrl: process.env.OPENAI_BASE_URL } : null;
}

export function build(credential: ProviderCredential): Provider {
  return credential.provider === "anthropic"
    ? createAnthropicProvider(credential)
    : createOpenAIProvider(credential);
}

/** User credential, then platform credential, then a clear error raised before any HTTP call. */
export function resolve(role: Role, userCredential: ProviderCredential | null): Resolved {
  const config = roleConfig(role);
  const usesUserCredential = userCredential?.provider === config.provider;
  const credential = usesUserCredential ? userCredential : platformCredential(config.provider);

  if (!credential) throw new NoCredentialError(config.provider);

  return {
    provider: build(credential),
    model: config.model,
    maxTokens: config.maxTokens,
    secrets: [
      credential.apiKey,
      process.env.OPENAI_API_KEY ?? "",
      process.env.ANTHROPIC_API_KEY ?? "",
    ],
    usedPlatformCredential: !usesUserCredential,
  };
}
