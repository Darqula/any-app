import type { ProviderId } from "./providers/types";

export type Role = "planner" | "fill" | "edit" | "router";

export interface RoleConfig {
  provider: ProviderId;
  model: string;
  maxTokens: number;
}

function env(role: Role, key: string): string | undefined {
  return process.env[`LLM_${role.toUpperCase()}_${key}`] || undefined;
}

function fallback(key: string): string | undefined {
  return process.env[`LLM_${key}`] || undefined;
}

const DEFAULT_MAX_TOKENS: Record<Role, number> = {
  planner: 20000,
  fill: 32000,
  edit: 8000,
  router: 20,
};

export function roleConfig(role: Role): RoleConfig {
  const provider = (env(role, "PROVIDER") ?? fallback("PROVIDER") ?? "openai") as ProviderId;
  const model = env(role, "MODEL") ?? fallback("MODEL");
  if (!model) {
    throw new Error(
      `No model configured for role "${role}" — set LLM_MODEL or LLM_${role.toUpperCase()}_MODEL`,
    );
  }
  const maxTokens = Number(
    env(role, "MAX_TOKENS") ?? fallback("MAX_TOKENS") ?? DEFAULT_MAX_TOKENS[role],
  );
  return { provider, model, maxTokens };
}
