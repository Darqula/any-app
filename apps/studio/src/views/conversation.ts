import type { Message } from "@any-app/store";
import { html, type Html } from "./escape.ts";

/**
 * The conversation panel's rows. Every body is escaped text, never HTML. The pending row has
 * data-pending and no data-seq; the polling cursor is the highest data-seq.
 */
export function messageItems(
  messages: Pick<Message, "seq" | "role" | "kind" | "target" | "body">[],
  pending: string | null = null,
): Html {
  const items = messages.map((m) => {
    const meta =
      m.role === "user" && m.kind === "edit" && m.target
        ? html`<span class="chat-meta">${m.target === "css" ? "styling" : m.target === "shell" || m.target === "@shell" ? "page frame" : m.target}</span>`
        : null;
    return html`<li class="chat-msg chat-${m.role}${m.kind === "error" ? " chat-error" : ""}" data-seq="${m.seq}">${meta}<p class="chat-body">${m.body}</p></li>`;
  });
  const pendingRow = pending
    ? html`<li class="chat-msg chat-assistant chat-pending" data-pending="1"><p class="chat-body">${pending}</p></li>`
    : null;
  return html`${items}${pendingRow}`;
}

/** Replaces the whole #chat-log element so data-app changes with it; an empty data-app hides the panel. */
export function chatLogOob(appId: string, items?: Html): Html {
  return html`<ol id="chat-log" class="chat-log" hx-swap-oob="true" data-app="${appId}" aria-label="Conversation" aria-live="polite">${items}</ol>`;
}
