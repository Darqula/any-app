import { isOpenAIAbort } from "./providers/openai.ts";
import { isAnthropicAbort } from "./providers/anthropic.ts";

/**
 * True for either SDK's abort error. Use instanceof: neither class overrides `name`, so an
 * `error.name === "AbortError"` check never matches. The streaming adapters raise it explicitly
 * after iteration.
 */
export function isAbortError(error: unknown): boolean {
  return isOpenAIAbort(error) || isAnthropicAbort(error);
}
