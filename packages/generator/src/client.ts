import { isOpenAIAbort } from "./providers/openai";
import { isAnthropicAbort } from "./providers/anthropic";

/**
 * True when `error` is either provider SDK's own abort error — thrown whenever an in-flight
 * request's signal fires, regardless of what stage it was at (build, fetch, or mid-stream).
 *
 * Deliberately not `error.name === "AbortError"`: neither `OpenAI.APIUserAbortError` nor
 * `Anthropic.APIUserAbortError` overrides `name`, so both read as the generic `"Error"` —
 * checking the name string looks reasonable and silently never matches. That mistake was
 * already made once on this project (see `.docs/open-problems.md`); `instanceof` against
 * each SDK's own class is the only reliable check.
 */
export function isAbortError(error: unknown): boolean {
  return isOpenAIAbort(error) || isAnthropicAbort(error);
}
