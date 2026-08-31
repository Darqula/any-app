export type ProviderId = "openai" | "anthropic";

export interface ProviderCredential {
  provider: ProviderId;
  apiKey: string;
  /**
   * The API prefix. For the OpenAI-compatible provider, e.g. `https://host/v1` (the SDK
   * appends `/chat/completions`). For the Anthropic provider, e.g. `https://host` (the SDK
   * appends `/v1/messages`). Optional for both — omit to use the provider's own default
   * endpoint (OpenAI's own API, or api.anthropic.com).
   *
   * Confirmed live this can also point the Anthropic adapter at a third-party gateway that
   * speaks the real Anthropic Messages API wire format, not just Anthropic's own servers —
   * see `ANTHROPIC_BASE_URL` in `.env.example`. That is a different thing from decision #9's
   * "do not use Anthropic's OpenAI-compatible shim": the adapter still speaks the real
   * Anthropic wire format end to end, it just isn't necessarily Anthropic's own servers on
   * the other end. Whether such a gateway's `cache_control` is real or a no-op is an
   * empirical question for whoever points one here — see .docs/open-problems.md.
   */
  baseUrl?: string;
}

export interface ProviderRequest {
  /** Stable instructions. Cached where the provider supports it. */
  system: string;
  /**
   * Stable per-app context — the stylesheet, the shell, the design system. Cached
   * together with `system`, because it repeats across every call about one app and is
   * the bulk of the tokens. Phase 4 sends this to every parallel slot call.
   */
  context?: string;
  /** The volatile part: the user's prompt or edit instruction. Never cached. */
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
  /** Log label for token-usage reporting (e.g. "planner", "fill"). Diagnostic only. */
  label: string;
}

export interface Provider {
  readonly id: ProviderId;
  /** Yields assistant text only. Reasoning/thinking output is never yielded. */
  streamText(model: string, req: ProviderRequest): AsyncGenerator<string>;
  completeText(model: string, req: ProviderRequest): Promise<string>;
  /** Cheap round trip used to reject a bad credential at entry. Throws on failure. */
  validate(model: string, signal?: AbortSignal): Promise<void>;
}

/** Thrown when a provider declines the request rather than failing the request. */
export class RefusalError extends Error {
  constructor(public readonly reason: string | null) {
    super(`The model declined this request (${reason ?? "unknown reason"}).`);
    this.name = "RefusalError";
  }
}
