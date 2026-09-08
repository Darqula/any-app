/**
 * A stub `Provider` (`packages/generator/src/providers/types.ts`) for `probe.ts --dry-run`.
 * Returns pre-scripted text — no network, no real provider, no cost — so the S13 probe's
 * plumbing (CLI parsing, prompt selection, `parsePlan`, the wrapped-root measurement, disk
 * writes, reporting) can be exercised and shown correct without spending anything real.
 *
 * Deliberately NOT the HTTP-level `tests/harness/fake-provider.ts` fixture — that is a real
 * wire-format server (useful for testing the *adapters themselves*), which is more machinery
 * than a dry run of this harness needs. `probe.ts` never touches `resolve()`/the real
 * `providers/openai.ts`/`providers/anthropic.ts` adapters in `--dry-run` mode at all; this
 * stub is swapped in ahead of them, in-process, so there is no HTTP anywhere in a dry run.
 */
import type { Provider, ProviderRequest } from "../../packages/generator/src/providers/types";

export type StubScript = { text: string } | { chunks: string[] };

/**
 * Queue-driven stub: each `completeText`/`streamText` call consumes the next scripted
 * response, in order. Throws a clear error (not a silent empty string) if more calls happen
 * than were scripted — the same "harness misuse should be loud" convention
 * `tests/harness/fake-provider.ts` uses for its own empty queue.
 */
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

// -----------------------------------------------------------------------------------------
// Tier 1 dry-run fixtures — three canned planner responses, matching the shape `--dry-run`'s
// contract asks for: one with classes on every placeholder, one with none, one that fails
// parsePlan. Hand-written directly in the `===NAME===` section format `parseSections`
// (packages/generator/src/section-parser.ts) expects — each header alone on its own line.
// -----------------------------------------------------------------------------------------

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

/** Missing `===SLOTS===` (and, deliberately, `===SHELL===` too) so `parsePlan` throws
 * `PlanError` — this is the "must be captured raw before anything else" case Q2
 * (`.docs/open-problems.md`) exists to guard against. */
export const TIER1_FIXTURE_PARSE_FAILURE = `===TITLE===
Stub Broken Plan
===CSS===
body{margin:0}
`;

// -----------------------------------------------------------------------------------------
// Tier 2 dry-run fixtures — one fill response that wraps its output in a single element
// carrying a planner-defined class, one that doesn't.
// -----------------------------------------------------------------------------------------

/** Wraps its entire output in one root element carrying `stubClass` — the S13 shape
 * `DIAG:fill-wrapped-root` exists to catch. */
export function tier2FixtureWrapped(stubClass: string): string {
  return `<div class="${stubClass}"><p>Stub filled content.</p><button>Stub action</button></div>`;
}

/** Writes only children — no wrapper of its own — the shape the S13 fix asks the fill call
 * to produce. */
export const TIER2_FIXTURE_UNWRAPPED = `<p>Stub filled content.</p>\n<button>Stub action</button>`;
