import { appendMessage, listMessages } from "@any-app/store";
import type { Generation, Message, NewMessage } from "@any-app/store";
import { isEditing } from "./activity";

/**
 * Writes one line of an app's conversation, best-effort. The log is a convenience layered on
 * top of work that has already happened (a generation that finished, an edit that was applied),
 * so a failure to record it — most plausibly the app being deleted between the check and the
 * insert — must never turn that work into an error response or leave a stream half-written.
 */
export async function recordMessage(generationId: string, message: NewMessage): Promise<void> {
  try {
    await appendMessage(generationId, message);
  } catch (error) {
    console.warn(`conversation ${generationId}: failed to record message:`, error);
  }
}

/** The message every app starts with: what the user asked for. It is `generations.prompt`
 *  itself rather than a stored row, so apps that predate the messages table have it too. */
export function firstMessage(generation: Pick<Generation, "prompt">): Message {
  return { seq: 0, role: "user", kind: "create", target: null, body: generation.prompt, created_at: new Date(0) };
}

/** What the "assistant is working" row should say right now, or null when nothing is running.
 *  Derived, not stored: it is true exactly while the generation is unfinished or an edit is in
 *  flight (activity.ts), so there is nothing to clean up when a process dies mid-way. */
export function pendingText(generation: Pick<Generation, "id" | "status">): string | null {
  if (generation.status === "pending" || generation.status === "streaming") return "Building your app…";
  if (isEditing(generation.id)) return "Updating…";
  return null;
}

/** The full conversation for an app, oldest first, starting from the prompt. */
export async function fullConversation(generation: Generation): Promise<Message[]> {
  return [firstMessage(generation), ...(await listMessages(generation.id))];
}
