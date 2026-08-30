/** One region of the app, generated separately from the shell that contains it. */
export interface SlotSpec {
  /** Lowercase kebab id, unique within the app. Used in DOM ids and stream markers. */
  id: string;
  /** Skeleton height in CSS pixels, so the layout does not shift when content lands. */
  height: number;
  /** One line telling the fill call what belongs here. */
  spec: string;
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
}

/** A plan plus the filled content of each slot, keyed by slot id. */
export interface FilledApp extends AppPlan {
  content: Record<string, string>;
}

export const SLOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

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
`.trim();

/**
 * Replaces each `<div data-slot="x"></div>` with a sized skeleton the browser can paint
 * immediately. Unknown slot ids are left as an empty div rather than throwing — a plan
 * with one stray placeholder should still render.
 */
export function renderSkeletons(shell: string, slots: SlotSpec[]): string {
  const byId = new Map(slots.map((s) => [s.id, s]));
  return shell.replace(PLACEHOLDER, (_match, id: string) => {
    const slot = byId.get(id);
    const height = slot ? slot.height : 0;
    return `<div id="slot-${id}" class="anyapp-skeleton" style="min-height:${height}px"></div>`;
  });
}

/** The list of slot ids actually referenced by the shell, in document order. */
export function slotIdsInShell(shell: string): string[] {
  return [...shell.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}
