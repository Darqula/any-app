export type ProviderId = "openai" | "anthropic";

export interface ProviderCredential {
  provider: ProviderId;
  apiKey: string;
  /**
   * API prefix; each SDK appends its own path. Omit for the provider's default endpoint.
   * May point the Anthropic adapter at an Anthropic-shaped gateway.
   */
  baseUrl?: string;
}

export interface ProviderRequest {
  /** Stable instructions. Cached where the provider supports it. */
  system: string;
  /** Stable per-app context (stylesheet, shell), cached together with system. */
  context?: string;
  /** The volatile part: the user's prompt or edit instruction. Never cached. */
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
  /** Log label for token-usage reporting (e.g. "planner", "fill"). Diagnostic only. */
  label: string;
  /** Sent as x-opencode-session. Use the generation id: stable per app, never per request. */
  conversationId?: string;
  /**
   * Called with each call's token usage even when the call then throws: a cost record, not a
   * success record. Keep it beside logUsage in every adapter; must not throw.
   */
  onUsage?: (usage: import("./usage").UsageInfo) => void;
}

export interface Provider {
  readonly id: ProviderId;
  /** Yields assistant text only. Reasoning/thinking output is never yielded. */
  streamText(model: string, req: ProviderRequest): AsyncGenerator<string>;
  completeText(model: string, req: ProviderRequest): Promise<string>;
  /** Cheap round trip used to reject a bad credential at entry. Throws on failure. */
  validate(model: string, signal?: AbortSignal): Promise<void>;
}

/** The provider declined. Discriminate on kind ("declined" vs "empty"), never on reason text. */
export class RefusalError extends Error {
  constructor(
    public readonly reason: string | null,
    public readonly kind: "declined" | "empty" = "declined",
  ) {
    // Additive to reason/message text, which existing callers still match on.
    super(`The model declined this request (${reason ?? "unknown reason"}).`);
    this.name = "RefusalError";
  }
}

/**
 * Response cut off at the token budget. Distinct from RefusalError: only this one is worth
 * retrying with a larger budget.
 */
export class TruncationError extends Error {
  constructor(public readonly maxTokens: number) {
    super(`The model's response was cut off at the token budget (max_tokens=${maxTokens}) before it finished.`);
    this.name = "TruncationError";
  }
}
