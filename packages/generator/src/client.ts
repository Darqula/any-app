import OpenAI from "openai";

// Any OpenAI-compatible chat-completions endpoint works here, not just OpenAI itself.
// Built lazily, on first use, so nothing depends on .env having been loaded at the moment
// this module happened to be imported.
let client: OpenAI | undefined;

export function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }
  return client;
}

export function getModel(): string {
  return process.env.OPENAI_MODEL ?? "gpt-4o";
}

/**
 * True when `error` is the SDK's own abort error — thrown whenever an in-flight request's
 * signal fires, regardless of what stage it was at (build, fetch, or mid-stream).
 *
 * Deliberately not `error.name === "AbortError"`: `APIUserAbortError` does not override
 * `name`, so it reads as the generic `"Error"` — checking the name string looks reasonable
 * and silently never matches. Callers need this instead of inspecting `AbortSignal.aborted`
 * on their own controller, because a signal can go true for reasons unrelated to the
 * specific operation being checked (e.g. the response having already ended).
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof OpenAI.APIUserAbortError;
}

/**
 * The planner call is small and on the critical path for first paint, so it is worth
 * pointing at a faster model than the fill call. Defaults to the same model.
 */
export function getPlannerModel(): string {
  return process.env.OPENAI_PLANNER_MODEL || getModel();
}

/**
 * True when the configured model is a "reasoning" model — one that spends a share of its
 * `max_tokens` budget on a hidden `reasoning_content` field before it ever writes the
 * visible `content` this app actually reads. Confirmed against glm-5.3-flash on the
 * opencode.ai gateway: a trivial one-word answer burned 123 tokens of reasoning first, and
 * the real planner prompt at max_tokens 4000 came back with empty `content` — the budget
 * was spent entirely on reasoning before any plan text was written.
 *
 * There is no reliable way to detect this from the response shape alone (a model can
 * legitimately return empty content for other reasons), so it is a manual flag rather than
 * an auto-detected one. Set `OPENAI_REASONING_MODEL=true` for any model with this behaviour
 * — LongCat and Kimi K2.7 Code both qualify; Kimi cannot even disable it.
 */
export function isReasoningModel(): boolean {
  return /^(1|true)$/i.test(process.env.OPENAI_REASONING_MODEL ?? "");
}

/**
 * Logs token consumption for one call. The only way to know what a generation actually
 * cost without cross-referencing the provider's own dashboard after the fact — worth
 * having permanently, not just while chasing a specific model's behaviour.
 *
 * `usage` is `null`/`undefined` when a streaming call didn't request it (see
 * `stream_options.include_usage` on the fill/linear calls) or when the provider doesn't
 * report it on failure paths.
 */
export function logUsage(label: string, usage: OpenAI.CompletionUsage | null | undefined): void {
  if (!usage) {
    console.log(`[usage] ${label}: not reported`);
    return;
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  const reasoningPart = reasoning ? ` (${reasoning} reasoning)` : "";
  console.log(
    `[usage] ${label}: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}${reasoningPart} total=${usage.total_tokens}`,
  );
}
