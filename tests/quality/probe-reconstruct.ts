/**
 * Rebuilds an AppPlan/FilledApp from a saved sweep artifact, for the Tier 2 probe (nothing else goes from document back to plan).
 * "Is it wrapped" stays in checks-doc.ts.
 */
import type { AppPlan, SlotSpec, FilledApp } from "@any-app/protocol";

export type FillModeName = "sequential" | "parallel";

export interface ReconstructedDoc {
  /** Original artifact filename, e.g. "parallel-contact-form.html". */
  file: string;
  mode: FillModeName;
  promptId: string;
  css: string;
  /** The skeleton-rendered placeholder markup: what appContext() shows the model, and what Tier 2 edits. Not byte-identical to the model's shell. */
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

/** The shared script is the LAST <script> in the pre-template slice, anchored to its end so a slot's own script cannot match. */
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

/** The artifact has no plan (linear fallback, e.g. parallel-recipe-browser.html). loadArtifactDocs skips it instead of aborting. */
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

  // Height is only recoverable from the inline min-height; falls back to a default for an unknown slot.
  const slots: SlotSpec[] = order.map((id) => {
    const heightRe = new RegExp(`data-slot="${id}"[^>]*style="[^"]*min-height:(\\d+)px`, "i");
    const hm = heightRe.exec(shell);
    return { id, height: hm ? Number(hm[1]) : 200, spec: "" };
  });

  return { file, mode, promptId, css, shell, script, slots, content };
}

/** Narrowed to what analyzeSlotRoots and fillSlot need. Collections stay empty: they only change prompt text, never the measurement. */
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

/** Merges classes onto a slot's placeholder for Tier 2's B-shape synthesis, deduped against anyapp-skeleton and what is already there. */
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

/** Reconstructs every artifact in alphabetical order; files with no plan are collected separately, not thrown. */
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
