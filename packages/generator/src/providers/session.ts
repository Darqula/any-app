import { randomUUID } from "node:crypto";

/**
 * Headers the opencode.ai "zen" gateway started requiring on 2026-09-07 (see
 * .docs/open-problems.md's "the gateway started requiring x-opencode-session" entry): every
 * request needs a stable `x-opencode-session` per conversation, and the gateway separately
 * asks every client to identify itself with its own `User-Agent` rather than the SDK's
 * generic default. Shared by both adapters (openai.ts, anthropic.ts) so there is exactly one
 * fallback id, not two independently-generated ones that would each defeat the other's
 * caching.
 *
 * Applied unconditionally from both adapters, not gated on which gateway is configured:
 * `x-opencode-session` is meaningless (and, on ordinary REST APIs, harmless) to any endpoint
 * that isn't this gateway, and `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` are both confirmed to
 * be able to point at this same "zen" gateway's two different wire-format endpoints (see
 * CLAUDE.md's provider section and open-problems.md's Phase 3.5 findings) — there is no
 * cheaper way to stay correct on whichever one is actually configured today or later.
 *
 * `x-opencode-session` MUST be present on every request — a missing header is a 400 on this
 * gateway, not a degraded response — and it MUST be stable across every call that belongs to
 * one generated app (planner, every fill call, every edit), never a fresh id per request:
 * that is exactly the optimization the header exists to enable, and this project's economics
 * depend on prompt caching working (see CLAUDE.md, open-problems.md). Real call sites pass
 * the generation id as `ProviderRequest.conversationId` (see its doc comment); the fallback
 * below exists only so a request with no generation in scope (credential validation from
 * `/settings`) still always carries the header, correctly, by construction — it is
 * deliberately generated once per process rather than once per call, for the same
 * never-a-fresh-id-per-request reason.
 */
const PROCESS_FALLBACK_CONVERSATION_ID = `any-app-process-${randomUUID()}`;

/**
 * "my-coding-agent/1.0"-shaped, per the gateway's own docs ("identify itself with its own
 * user agent ... rather than a generic SDK or HTTP-library name") — replaces the SDK's own
 * default User-Agent for every request rather than being appended to it. Not required by the
 * current 400 (a bare `x-opencode-session` alone was confirmed to unblock it), but cheap
 * insurance against the next tightening — see open-problems.md.
 */
export const PROVIDER_USER_AGENT = "any-app/1.0";

/** The id actually sent: the caller's conversation id when given, else the process-stable
 * fallback. Never a freshly-generated id — see the module doc comment. */
export function resolveConversationId(conversationId: string | undefined): string {
  return conversationId || PROCESS_FALLBACK_CONVERSATION_ID;
}

/** The exact extra headers every provider request must carry. */
export function conversationHeaders(conversationId: string | undefined): Record<string, string> {
  return {
    "x-opencode-session": resolveConversationId(conversationId),
    "User-Agent": PROVIDER_USER_AGENT,
  };
}
