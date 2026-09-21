/**
 * Rewrites the fill call's sectioned output into browser-ready HTML while it streams:
 * `===SLOT x===` opens <template id="c-x">, the next marker or the end closes it and emits swap("x").
 * Template content is not rendered, so bytes are forwarded as they arrive. Markers can straddle
 * chunks, so only complete lines are examined.
 */
import { slotOpen, slotClose } from "@any-app/protocol";

const MARKER = /^===SLOT ([a-z][a-z0-9-]{0,30})===[ \t]*$/;

export interface SlotStream {
  push(chunk: string): string;
  flush(): string;
  /** Slot id to content, accumulated for persistence. */
  content: Record<string, string>;
}

export function createSlotStream(): SlotStream {
  let pending = "";
  let open: string | null = null;
  const content: Record<string, string> = {};

  function emitLine(line: string): string {
    const match = MARKER.exec(line.trim());

    if (match) {
      const id = match[1]!;
      let out = "";
      if (open) out += slotClose(open);
      open = id;
      content[id] = "";
      return out + slotOpen(id);
    }

    // Text before the first marker is preamble the model was told not to write. Drop it.
    if (!open) return "";

    content[open] += line + "\n";
    return line + "\n";
  }

  return {
    content,

    push(chunk: string): string {
      pending += chunk;
      let out = "";
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        out += emitLine(line);
      }
      return out;
    },

    flush(): string {
      let out = "";
      if (pending) {
        out += emitLine(pending);
        pending = "";
      }
      if (open) {
        out += slotClose(open);
        open = null;
      }
      return out;
    },
  };
}
