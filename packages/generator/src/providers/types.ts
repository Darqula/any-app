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
  /**
   * The conversation this call belongs to, sent as the opencode.ai gateway's
   * `x-opencode-session` header (see providers/session.ts) — required by that gateway since
   * 2026-09-07, and otherwise unused/harmless elsewhere. MUST be stable across every call
   * belonging to one generated app (planner, every fill call, every edit) and MUST NEVER be
   * a freshly-generated id per request — a fresh id defeats exactly the routing/caching
   * optimization the header exists for. The generation id is the natural value; call sites
   * with no generation in scope may leave this unset and get a stable per-process fallback
   * instead (see `providers/session.ts`'s `resolveConversationId`).
   */
  conversationId?: string;
}

export interface Provider {
  readonly id: ProviderId;
  /** Yields assistant text only. Reasoning/thinking output is never yielded. */
  streamText(model: string, req: ProviderRequest): AsyncGenerator<string>;
  completeText(model: string, req: ProviderRequest): Promise<string>;
  /** Cheap round trip used to reject a bad credential at entry. Throws on failure. */
  validate(model: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Thrown when a provider declines the request rather than failing the request.
 *
 * `kind` is the discriminator callers must use to tell an *explicit* decline
 * (`content_filter`, Anthropic's `stop_reason: "refusal"`) apart from an *empty* response —
 * no content and no explicit refusal signal from the API, reachable when a heavily-reasoning
 * model spends its whole budget on hidden reasoning and writes no visible output (see
 * `.docs/open-problems.md`). `reason` alone cannot serve this purpose: it is free-form
 * diagnostic text (`"content_filter"`, an Anthropic `stop_details.category`, or the literal
 * "empty response"), and matching on it is exactly the kind of string comparison that quietly
 * stops working after a reword. A real refusal must never be disguised as "we got nothing" —
 * routeEdit's RefusalError handling (testing-review.md S14 follow-up) relies on `kind`, not on
 * parsing `reason`.
 */
export class RefusalError extends Error {
  constructor(
    public readonly reason: string | null,
    public readonly kind: "declined" | "empty" = "declined",
  ) {
    // Message text is unchanged by `kind` deliberately — existing callers/tests match on
    // `reason`/message text ("empty response") for logging and display; `kind` is additive,
    // for callers that need a reliable programmatic discriminator instead of parsing text.
    super(`The model declined this request (${reason ?? "unknown reason"}).`);
    this.name = "RefusalError";
  }
}

/**
 * Thrown when a response was cut off at the token budget before the model finished —
 * `finish_reason: "length"` (OpenAI) or `stop_reason: "max_tokens"` (Anthropic) — rather than
 * being returned to the caller as if it were complete (testing-review.md S14).
 *
 * This exists because both adapters used to do exactly that: return a budget-truncated
 * response as if it were done. Live, a real planner call came back at `completion=11968` of a
 * `12,000` budget, stopped mid-section, and `parsePlan` accepted it — silently dropping the
 * app's data collections with no error anywhere.
 *
 * Deliberately a distinct class from `RefusalError`, not a shared "the call didn't produce a
 * usable result" error: a refusal means the model declined and retrying with more budget
 * cannot help, while a truncation means the model was still writing and a bigger `maxTokens`
 * might let it finish. Callers that want to tell those apart (and decide whether a retry is
 * worth it) need `instanceof` to actually distinguish them.
 */
export class TruncationError extends Error {
  constructor(public readonly maxTokens: number) {
    super(`The model's response was cut off at the token budget (max_tokens=${maxTokens}) before it finished.`);
    this.name = "TruncationError";
  }
}
