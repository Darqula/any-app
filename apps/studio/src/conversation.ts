import { appendMessage, listMessages } from "@any-app/store";
import type { Generation, Message, NewMessage } from "@any-app/store";
import { isEditing } from "./activity";

/** Best-effort: the log sits on top of work already done, so a failure to record must not fail it. */
export async function recordMessage(generationId: string, message: NewMessage): Promise<void> {
  try {
    await appendMessage(generationId, message);
  } catch (error) {
    console.warn(`conversation ${generationId}: failed to record message:`, error);
  }
}

/** What the user asked for. Read from generations.prompt, so older apps have it without a backfill. */
export function firstMessage(generation: Pick<Generation, "prompt">): Message {
  return { seq: 0, role: "user", kind: "create", target: null, body: generation.prompt, created_at: new Date(0) };
}

/** The "working" row, derived from live state so nothing needs cleaning up after a crash. */
export function pendingText(generation: Pick<Generation, "id" | "status">): string | null {
  if (generation.status === "pending" || generation.status === "streaming") return "Building your app…";
  if (isEditing(generation.id)) return "Updating…";
  return null;
}

export async function fullConversation(generation: Generation): Promise<Message[]> {
  return [firstMessage(generation), ...(await listMessages(generation.id))];
}
