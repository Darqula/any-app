/** An in-process Provider stub for `probe.ts --dry-run`: scripted text, no network, no cost. Not the HTTP fake-provider (more than a dry run needs). */
import type { Provider, ProviderRequest } from "../../packages/generator/src/providers/types";

export type StubScript = { text: string } | { chunks: string[] };

/** Each call consumes the next scripted response; extra calls throw loudly, like the fake provider's empty queue. */
export function createStubProvider(scripts: StubScript[]): Provider {
  let i = 0;
  function next(caller: string): StubScript {
    if (i >= scripts.length) {
      throw new Error(
        `probe-stub: ${caller} call #${i + 1} has no scripted response queued (only ${scripts.length} scripted) — ` +
          `this dry-run path is asking the stub for more calls than it was set up to answer`,
      );
    }
    return scripts[i++]!;
  }

  return {
    id: "openai",
    async completeText(_model: string, _req: ProviderRequest): Promise<string> {
      const s = next("completeText");
      return "text" in s ? s.text : s.chunks.join("");
    },
    async *streamText(_model: string, _req: ProviderRequest): AsyncGenerator<string> {
      const s = next("streamText");
      if ("text" in s) {
        yield s.text;
      } else {
        for (const c of s.chunks) yield c;
      }
    },
    async validate(): Promise<void> {
      // Never called by probe.ts — present only to satisfy the Provider interface.
    },
  };
}

// Tier 1 dry-run fixtures: planner responses with classes on every placeholder, on none, and one that fails parsePlan.

/** A well-formed planner response whose every placeholder carries the region's own class —
 * the "fix worked" case. */
export const TIER1_FIXTURE_WITH_CLASSES = `===TITLE===
Stub Contact Form
===CSS===
.form-panel{padding:16px}
.confirmation-panel{padding:16px}
.hidden{display:none}
===SHELL===
<main>
<div data-slot="form-panel" class="form-panel"></div>
<div data-slot="confirmation-panel" class="confirmation-panel hidden"></div>
</main>
===SCRIPT===

===SLOTS===
form-panel|380|The contact form itself.
confirmation-panel|180|A confirmation message shown after submitting.
`;

/** A well-formed planner response whose placeholders carry no class at all — the pre-fix
 * (S13) case. */
export const TIER1_FIXTURE_WITHOUT_CLASSES = `===TITLE===
Stub Contact Form
===CSS===
.form-panel{padding:16px}
.confirmation-panel{padding:16px}
===SHELL===
<main>
<div data-slot="form-panel"></div>
<div data-slot="confirmation-panel"></div>
</main>
===SCRIPT===

===SLOTS===
form-panel|380|The contact form itself.
confirmation-panel|180|A confirmation message shown after submitting.
`;

/** Omits ===SLOTS=== (and ===SHELL===) so parsePlan throws: the "capture raw first" case. */
export const TIER1_FIXTURE_PARSE_FAILURE = `===TITLE===
Stub Broken Plan
===CSS===
body{margin:0}
`;


/** Wraps its entire output in one root element carrying `stubClass` — the S13 shape
 * `DIAG:fill-wrapped-root` exists to catch. */
export function tier2FixtureWrapped(stubClass: string): string {
  return `<div class="${stubClass}"><p>Stub filled content.</p><button>Stub action</button></div>`;
}

/** Writes only children — no wrapper of its own — the shape the S13 fix asks the fill call
 * to produce. */
export const TIER2_FIXTURE_UNWRAPPED = `<p>Stub filled content.</p>\n<button>Stub action</button>`;
