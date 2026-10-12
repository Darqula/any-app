import { findBlockedAddressError } from "./net-guard.ts";

/**
 * A fixed, user-facing sentence for a failed credential check. Never built from the provider's reply: the SDK errors
 * quote the response body, and with a user-chosen base URL that would turn the form into a reader of arbitrary hosts.
 *
 * A hostname that resolved to a non-public address gets the same sentence as one that does not resolve, so the form
 * cannot be used to learn which internal names exist. Only a literal address or scheme refusal says "not allowed".
 */
export function describeValidationFailure(error: unknown): string {
  const blocked = findBlockedAddressError(error);
  if (blocked && !blocked.byName) return "That base URL is not allowed. Use a public https address.";
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return "The provider rejected the API key.";
  if (status === 404) return "The provider does not know that model or URL. Check the model name and base URL.";
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return `The provider answered with HTTP ${status}.`;
  }
  return "Could not reach the provider with those settings.";
}
