import type { ProviderId } from "./types";

/** Token consumption for one call, normalized across providers' differently-shaped usage objects. */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  /** OpenAI-compatible only: tokens spent on hidden reasoning before visible output. */
  reasoningTokens?: number;
  /** Anthropic only: tokens served from / written to the prompt cache. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Logs token consumption for one call. Not part of the plan's `Provider` interface — that
 * interface only yields/returns text — but losing this would be a real regression: it is
 * the only way to know what a generation actually cost without cross-referencing a
 * provider dashboard after the fact, established as a permanent fixture back in Phase 2/3
 * (see .docs/open-problems.md). Each adapter calls this internally with whatever usage
 * shape its own SDK response carries, normalized to `UsageInfo` first.
 */
export function logUsage(
  label: string,
  providerId: ProviderId,
  usage: UsageInfo | null | undefined,
): void {
  if (!usage) {
    console.log(`[usage] ${label} (${providerId}): not reported`);
    return;
  }
  const total = usage.promptTokens + usage.completionTokens;
  const reasoningPart = usage.reasoningTokens ? ` (${usage.reasoningTokens} reasoning)` : "";
  const cachePart =
    usage.cacheReadTokens || usage.cacheWriteTokens
      ? ` cache_read=${usage.cacheReadTokens ?? 0} cache_write=${usage.cacheWriteTokens ?? 0}`
      : "";
  console.log(
    `[usage] ${label} (${providerId}): prompt=${usage.promptTokens} completion=${usage.completionTokens}${reasoningPart} total=${total}${cachePart}`,
  );
}
