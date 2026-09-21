import { randomUUID } from "node:crypto";

/**
 * The opencode.ai gateway 400s without x-opencode-session, which must be stable for every call of
 * one generated app (never a fresh id per request) so prompt caching works. Applied by both adapters
 * to every endpoint. The fallback id serves calls with no generation, once per process.
 */
const PROCESS_FALLBACK_CONVERSATION_ID = `any-app-process-${randomUUID()}`;

/** Identifies this client to the gateway instead of the SDK default (insurance; not yet required). */
export const PROVIDER_USER_AGENT = "any-app/1.0";

/** The id actually sent: the caller's conversation id when given, else the process-stable
 * fallback. Never a freshly-generated id — see the module doc comment. */
export function resolveConversationId(conversationId: string | undefined): string {
  return conversationId || PROCESS_FALLBACK_CONVERSATION_ID;
}

export function conversationHeaders(conversationId: string | undefined): Record<string, string> {
  return {
    "x-opencode-session": resolveConversationId(conversationId),
    "User-Agent": PROVIDER_USER_AGENT,
  };
}
