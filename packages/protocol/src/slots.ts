/** One region of the app, generated separately from the shell that contains it. */
export interface SlotSpec {
  /** Lowercase kebab id, unique within the app. Used in DOM ids and stream markers. */
  id: string;
  /** Skeleton height in CSS pixels, so the layout does not shift when content lands. */
  height: number;
  /** One line telling the fill call what belongs here. */
  spec: string;
}

/** One collection the app's data API exposes, from the planner's optional DATA section. */
export interface CollectionSpec {
  name: string;
  description: string;
}

/** Everything the planner call produces. */
export interface AppPlan {
  title: string;
  css: string;
  /** Body markup containing `<div data-slot="id"></div>` placeholders. */
  shell: string;
  /** Shared state and delegated listeners. Runs before any slot lands. */
  script: string;
  slots: SlotSpec[];
  /**
   * Collections this app's data API exposes. Empty for most apps — a static app should not
   * carry a data-API token it never uses (see `dataRuntime`). A row written before Phase 5
   * has no `collections` key at all; `getFilledApp` (store/generations.ts) defaults it to
   * `[]` on read, the same way a field added to a persisted JSONB shape always needs a
   * migration of *reads*, not just of writers.
   */
  collections: CollectionSpec[];
}

/** A plan plus the filled content of each slot, keyed by slot id. */
export interface FilledApp extends AppPlan {
  content: Record<string, string>;
}

export const SLOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * Shared by the planner (parsing the DATA section), `packages/records` (validating a
 * collection name on every data-API request), and the fill prompts (naming collections in
 * context). One definition so the three never drift apart — a name the planner accepts but
 * the data API rejects would be a collection nothing can ever write to.
 */
export const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

/** Matches the placeholder the planner is required to write, exactly. */
const PLACEHOLDER = /<div data-slot="([a-z][a-z0-9-]{0,30})"><\/div>/g;

/**
 * Server-owned skeleton styling. Deliberately not left to the planner: skeletons should
 * look identical across every generated app, and a planner that invents its own each time
 * makes loading states one more thing that varies for no reason.
 */
export const SKELETON_CSS = `
.anyapp-skeleton{position:relative;overflow:hidden;border-radius:8px;background:color-mix(in srgb,currentColor 8%,transparent)}
.anyapp-skeleton::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,currentColor 10%,transparent),transparent);animation:anyapp-shimmer 1.2s infinite}
@keyframes anyapp-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.anyapp-slot-error{padding:16px;border:1px dashed color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;opacity:.65;font:14px system-ui,sans-serif}
`.trim();

const SLOT_ERROR_MARKER = 'class="anyapp-slot-error"';

/** Stored as a slot's content when generation fails, so the document stays complete. */
export function slotErrorPlaceholder(id: string): string {
  return `<p ${SLOT_ERROR_MARKER}>This section could not be generated. Ask for a change to "${id}" to try again.</p>`;
}

/**
 * True when a slot's stored content is the placeholder above, not real content. An edit
 * request against a placeholder is a fill, not an edit — there is nothing to preserve, and
 * `SLOT_EDIT_PROMPT`'s "this is an edit, not a rewrite" rule would otherwise have the model
 * dutifully keep the apology paragraph intact. See edits.ts.
 */
export function isSlotErrorPlaceholder(html: string): boolean {
  return html.includes(SLOT_ERROR_MARKER);
}

/**
 * Replaces each `<div data-slot="x"></div>` with a sized skeleton the browser can paint
 * immediately. Unknown slot ids are left as an empty div rather than throwing — a plan
 * with one stray placeholder should still render.
 *
 * Keeps `data-slot="x"` on the rendered element alongside `id="slot-x"` (S12): the planner
 * prompt shows the model only the `data-slot` placeholder and never states the `id="slot-…"`
 * mapping, so a model that reaches for its own region with `[data-slot="x"]` — exactly the
 * identifier it was given — would otherwise always get `null`, since `swap()`/`fill()`
 * (`swap-runtime.ts`) replace this element's *children*, never the element itself. Carrying
 * the attribute through makes that selector work too, independent of prompt compliance.
 */
export function renderSkeletons(shell: string, slots: SlotSpec[]): string {
  const byId = new Map(slots.map((s) => [s.id, s]));
  return shell.replace(PLACEHOLDER, (_match, id: string) => {
    const slot = byId.get(id);
    const height = slot ? slot.height : 0;
    return `<div id="slot-${id}" data-slot="${id}" class="anyapp-skeleton" style="min-height:${height}px"></div>`;
  });
}

/** The list of slot ids actually referenced by the shell, in document order. */
export function slotIdsInShell(shell: string): string[] {
  return [...shell.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Opening tag for a slot's content block. Shared with the streaming emitter. */
export function slotOpen(id: string): string {
  return `<template id="c-${id}">`;
}

/** Closing tag plus the swap call that moves the content into place. */
export function slotClose(id: string): string {
  return `</template><script>swap(${JSON.stringify(id)})</script>\n`;
}

/**
 * The one and only definition of a generated app's document.
 *
 * The live generation stream is an *incremental emission of exactly this* — same shell,
 * same templates, same swap calls, same ordering — which is what keeps a replayed app
 * behaving identically to one being watched as it generates. Editing re-renders through
 * here too, so an edited app is structurally the same kind of document as a fresh one.
 */
export function renderDocument(
  filled: FilledApp,
  renderHead: (plan: AppPlan) => string,
  tail: string,
): string {
  let out = renderHead(filled);
  for (const slot of filled.slots) {
    out += slotOpen(slot.id) + (filled.content[slot.id] ?? "") + slotClose(slot.id);
  }
  return out + tail;
}

/** Runtime shape check for a `plan` column written by an older build. */
export function isFilledApp(value: unknown): value is FilledApp {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.css === "string" &&
    typeof v.shell === "string" &&
    typeof v.script === "string" &&
    Array.isArray(v.slots) &&
    typeof v.content === "object" &&
    v.content !== null
  );
}
