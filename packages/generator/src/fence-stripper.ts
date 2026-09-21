/**
 * Drops an opening markdown fence line before it reaches the browser, holding output back only
 * until it can tell whether the response opens with one.
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

/** Holds back the last few bytes so a trailing fence is stripped on first view, not only on replay. */
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
