import { isOpenAIAbort } from "./providers/openai";
import { isAnthropicAbort } from "./providers/anthropic";

/**
 * True when `error` is either provider SDK's own abort error.
 *
 * Note what actually raises it mid-stream: neither SDK throws on its own when a signal fires
 * during stream *iteration* — the async iterator just returns silently, which is how a
 * truncated generation once got persisted as complete (testing-review.md S8). Both
 * `streamText` adapters therefore raise `APIUserAbortError` explicitly after their loop when
 * `req.signal.aborted`, so this check means the same thing on the streaming and
 * non-streaming paths. The SDKs do throw it themselves at the build/fetch stage.
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
