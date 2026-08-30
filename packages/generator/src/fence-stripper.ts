/**
 * Models are told not to wrap output in markdown fences, but occasionally do it anyway.
 * This filter drops an opening fence line before it reaches the browser.
 *
 * It holds back output only until it can tell whether the response opens with a fence,
 * which is at most a few characters, so it does not delay the first paint meaningfully.
 */
export function createFenceStripper(): (chunk: string) => string {
  let decided = false;
  let buffer = "";

  return (chunk: string): string => {
    if (decided) return chunk;

    buffer += chunk;
    const trimmed = buffer.replace(/^\s+/, "");

    if (trimmed.startsWith("```")) {
      const newline = trimmed.indexOf("\n");
      if (newline === -1) return ""; // still inside the fence line, keep waiting
      decided = true;
      return trimmed.slice(newline + 1);
    }

    // Too short to rule a fence in or out yet (e.g. we have seen only "`").
    if (trimmed.length < 3 && "```".startsWith(trimmed)) return "";

    decided = true;
    return trimmed;
  };
}

/** Removes a trailing markdown fence. Applied once, to the finished document. */
export function stripTrailingFence(document: string): string {
  return document.replace(/\s*```\s*$/, "");
}

/**
 * Delays the tail of a stream by a small fixed window so a trailing markdown fence can be
 * detected and stripped before it ever reaches the browser, instead of only being cleaned
 * up when the saved document is replayed later (which made the fence visible on first
 * view and gone after reload — harmless, but a needless inconsistency).
 *
 * `holdBack` only needs to comfortably cover "```" plus a little surrounding whitespace;
 * it delays nothing but the very last few bytes of the whole response.
 */
export function createTrailingFenceGuard(holdBack = 16): {
  push(chunk: string): string;
  flush(): string;
} {
  let held = "";
  return {
    push(chunk: string): string {
      held += chunk;
      if (held.length <= holdBack) return "";
      const emit = held.slice(0, held.length - holdBack);
      held = held.slice(held.length - holdBack);
      return emit;
    },
    flush(): string {
      return stripTrailingFence(held);
    },
  };
}
