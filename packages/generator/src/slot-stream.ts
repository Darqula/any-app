/**
 * Rewrites the fill call's sectioned output into browser-ready HTML as it streams.
 *
 * `===SLOT x===` becomes `<template id="c-x">`, and the next marker (or the end of the
 * stream) closes it and emits `<script>swap("x")</script>`. Content inside a <template> is
 * parsed but not rendered, so slot bytes can be forwarded as they arrive with no
 * server-side buffering — the slot appears the moment its swap call is parsed.
 *
 * Markers can be split across chunks, so text is held back to the last newline and only
 * complete lines are examined.
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
