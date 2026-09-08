/**
 * Reconstructs an `AppPlan`/`FilledApp`-shaped object from one saved quality-sweep artifact
 * HTML file (`tests/quality/artifacts/<run>/​<mode>-<promptId>.html`), for the S13 Tier 2
 * fill-only probe (`tests/quality/probe.ts`). There is no separate "replay script" already in
 * this repo to import from — `tests/frontend/doc-builder.ts` only goes the other direction
 * (plan -> document, for hand-written fixtures) — so this module does the one thing the task
 * brief actually asks for: pull `css`/`shell`/per-slot `content` back out of a real rendered
 * document, the same way `renderDocument`/`renderHead` (`packages/protocol/src/slots.ts`,
 * `apps/studio/src/shell.ts`) put them in, in reverse.
 *
 * Nothing here re-derives "is this content wrapped" — that stays in `checks-doc.ts`
 * (`analyzeSlotRoots`/`wrappedRootOffenders`), imported and reused by `probe.ts`.
 */
import type { AppPlan, SlotSpec, FilledApp } from "@any-app/protocol";

export type FillModeName = "sequential" | "parallel";

export interface ReconstructedDoc {
  /** Original artifact filename, e.g. "parallel-contact-form.html". */
  file: string;
  mode: FillModeName;
  promptId: string;
  css: string;
  /** The pre-template portion of `<body>…</body>` — the skeleton-rendered placeholder
   * markup, in document order. This is what `renderSkeletons` produced from the real
   * `plan.shell` the model wrote; it is not byte-identical to that original (server-added
   * `id="slot-x"`/`data-slot="x"`/merged `class`/`style` — see `renderSkeletonElement`), but
   * it is what `fillSlot`'s `appContext()` shows the model as "the shell your regions sit
   * inside" either way, and it is the thing Tier 2's B-shape synthesis edits. */
  shell: string;
  /** The shared shell script, split out of the same slice — see `splitShellAndScript`. */
  script: string;
  slots: SlotSpec[];
  /** Slot id -> the HTML saved in `<template id="c-ID">`, i.e. what the fill call actually
   * produced for that slot in this saved run. */
  content: Record<string, string>;
}

const CSS_RE = /<style id="anyapp-css">([\s\S]*?)<\/style>/;
/** One `<template id="c-ID">…</template><script>swap("ID")</script>` block — see
 * `packages/protocol/src/slots.ts`'s `slotOpen`/`slotClose`, which is exactly this shape. */
const TEMPLATE_RE = /<template id="c-([a-z][a-z0-9-]*)">([\s\S]*?)<\/template><script>swap\("\1"\)<\/script>/g;

export function parseArtifactFilename(file: string): { mode: FillModeName; promptId: string } {
  const m = /^(sequential|parallel)-(.+)\.html$/.exec(file);
  if (!m) throw new Error(`probe-reconstruct: unrecognized artifact filename shape: ${file}`);
  return { mode: m[1] as FillModeName, promptId: m[2]! };
}

/**
 * Splits the pre-template body slice into the skeleton-rendered shell and the shared shell
 * script. `renderHead` (`apps/studio/src/shell.ts`) writes the skeleton markup and then
 * exactly one `<script>${plan.script}</script>` block right before the first slot's
 * `<template>` (see `packages/protocol/src/slots.ts`'s `renderDocument`) — so the shared
 * script is reliably the LAST `<script>…</script>` in this slice, anchored to the slice's own
 * end (`$`) rather than matched loosely, so a slot's own inline `<script>` could never be
 * mistaken for it (no slot content exists in this slice at all — slots live in the
 * `<template>` blocks that come after).
 */
function splitShellAndScript(bodyAndScript: string): { shell: string; script: string } {
  const m = /<script>([\s\S]*?)<\/script>\s*$/.exec(bodyAndScript);
  if (!m) return { shell: bodyAndScript, script: "" };
  return { shell: bodyAndScript.slice(0, m.index), script: m[1]! };
}

/** Best-effort title, only for cosmetic use in probe output — never fed back into anything
 * that measurement depends on. */
function extractTitle(html: string): string {
  const m = /<title>([\s\S]*?)<\/title>/.exec(html);
  return m ? m[1]!.trim() : "";
}

/**
 * Thrown by `reconstructDoc` for an artifact that has no plan at all — the row went through
 * the Phase 1 linear fallback (`parsePlan` threw a `PlanError`), so the document has no
 * `<style id="anyapp-css">` and no `<template id="c-…">` blocks to reconstruct from. Not a
 * bug in this parser: `parallel-recipe-browser.html` in the 2026-09-06 sweep is exactly this
 * case (confirmed against that run's own `report.json`: F4 "Plan output parses without a
 * PlanError" is `fail`, and every other doc check is `skip` with "no structured plan
 * persisted"). `loadArtifactDocs` below catches this and skips the file rather than crashing
 * the whole replay — a document that was never plan-shaped in the first place contributes
 * zero slots to Tier 2's corpus either way, which is exactly what "skip it" means here.
 */
export class NoPlanError extends Error {
  constructor(file: string) {
    super(`probe-reconstruct: ${file}: no plan in this document (linear fallback — parsePlan likely threw)`);
    this.name = "NoPlanError";
  }
}

export function reconstructDoc(file: string, html: string): ReconstructedDoc {
  const { mode, promptId } = parseArtifactFilename(file);

  const cssMatch = CSS_RE.exec(html);
  const bodyTagEnd = html.indexOf("<body>");
  const firstTemplate = html.indexOf('<template id="c-');
  if (!cssMatch || bodyTagEnd === -1 || firstTemplate === -1) {
    throw new NoPlanError(file);
  }
  const css = cssMatch[1]!;

  const bodyAndScript = html.slice(bodyTagEnd + "<body>".length, firstTemplate);
  const { shell, script } = splitShellAndScript(bodyAndScript);

  const order: string[] = [];
  const content: Record<string, string> = {};
  TEMPLATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_RE.exec(html))) {
    const id = m[1]!;
    content[id] = m[2]!;
    order.push(id);
  }
  if (order.length === 0) {
    throw new Error(`probe-reconstruct: ${file}: no <template id="c-…"> blocks found — is this a completed document?`);
  }

  // Height is not recoverable exactly (renderSkeletonElement folds it into an inline
  // min-height style, not a separate field) — pulled back out of that same style attribute so
  // fillSlot's "about Npx tall" line stays plausible; falls back to a generic default if the
  // skeleton element for a slot can't be found (unknown-slot fallback, mirroring
  // `renderSkeletons`'s own height:0 fallback for the same case).
  const slots: SlotSpec[] = order.map((id) => {
    const heightRe = new RegExp(`data-slot="${id}"[^>]*style="[^"]*min-height:(\\d+)px`, "i");
    const hm = heightRe.exec(shell);
    return { id, height: hm ? Number(hm[1]) : 200, spec: "" };
  });

  return { file, mode, promptId, css, shell, script, slots, content };
}

/** `ReconstructedDoc` narrowed to what `analyzeSlotRoots`/`fillSlot` actually need — both take
 * a `FilledApp`/`AppPlan`-shaped value, and a `ReconstructedDoc` already has every field
 * either wants except `title`/`collections`, which don't affect either function's behaviour
 * (collections stay empty: none of the ten prompts' saved 2026-09-06 documents need the
 * data-API context line, and getting that wrong would only change prompt text, never the
 * wrapped-root measurement). */
export function asFilledApp(doc: ReconstructedDoc): FilledApp {
  return {
    title: doc.promptId,
    css: doc.css,
    shell: doc.shell,
    script: doc.script,
    slots: doc.slots,
    collections: [],
    content: doc.content,
  };
}

export function asAppPlan(doc: ReconstructedDoc, shellOverride?: string): AppPlan {
  return {
    title: doc.promptId,
    css: doc.css,
    shell: shellOverride ?? doc.shell,
    script: doc.script,
    slots: doc.slots,
    collections: [],
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Merges `classesToAdd` onto the placeholder element for `slotId` in `shell` — the mechanical
 * half of Tier 2's B-shape synthesis ("move the fill content root's class onto the
 * placeholder"). Dedupes against whatever the placeholder already carries (its server-added
 * `anyapp-skeleton`, plus any class the model itself already put there — see the four
 * already-B-shaped documents `probe.ts` skips this for). Adds a bare `class="…"` attribute
 * when the placeholder has none at all, though in practice every reconstructed placeholder
 * here already carries at least `anyapp-skeleton` from `renderSkeletonElement`.
 */
export function addClassesToPlaceholder(shell: string, slotId: string, classesToAdd: string[]): string {
  if (classesToAdd.length === 0) return shell;
  const tagRe = new RegExp(
    `<[a-zA-Z][a-zA-Z0-9-]*\\b[^>]*\\bdata-slot=(?:"${escapeRegExp(slotId)}"|'${escapeRegExp(slotId)}')[^>]*>`,
    "i",
  );
  const m = tagRe.exec(shell);
  if (!m) throw new Error(`addClassesToPlaceholder: no placeholder found for slot "${slotId}"`);
  const tag = m[0]!;
  const classAttrRe = /\bclass="([^"]*)"/i;
  const existing = classAttrRe.exec(tag);
  let newTag: string;
  if (existing) {
    const tokens = existing[1]!.split(/\s+/).filter(Boolean);
    for (const c of classesToAdd) if (!tokens.includes(c)) tokens.push(c);
    newTag = tag.slice(0, existing.index) + `class="${tokens.join(" ")}"` + tag.slice(existing.index + existing[0]!.length);
  } else {
    newTag = tag.replace(/\s*\/?>$/, (closing) => ` class="${classesToAdd.join(" ")}"${closing}`);
  }
  return shell.slice(0, m.index) + newTag + shell.slice(m.index + tag.length);
}

export { extractTitle };

/**
 * Reads and reconstructs every `<mode>-<promptId>.html` artifact in `dir`, in deterministic
 * (alphabetical) filename order. Files that don't parse as a plan-shaped document
 * (`NoPlanError` — the linear-fallback case, see above) are collected separately rather than
 * thrown: the 2026-09-06 sweep's `parallel-recipe-browser.html` is exactly this case, and a
 * caller (`probe.ts`) needs to report it as "skipped, no plan" rather than have the whole
 * replay abort on one bad file.
 */
export function loadArtifactDocs(
  dir: string,
  readFile: (path: string) => string,
  listFiles: (dir: string) => string[],
): { docs: ReconstructedDoc[]; skipped: { file: string; reason: string }[] } {
  const files = listFiles(dir)
    .filter((f) => /^(sequential|parallel)-.+\.html$/.test(f))
    .sort();
  const docs: ReconstructedDoc[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const file of files) {
    try {
      const html = readFile(`${dir}/${file}`);
      docs.push(reconstructDoc(file, html));
    } catch (error) {
      if (error instanceof NoPlanError) {
        skipped.push({ file, reason: error.message });
      } else {
        throw error;
      }
    }
  }
  return { docs, skipped };
}
