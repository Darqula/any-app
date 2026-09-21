/**
 * Which apps have a follow-up edit running right now.
 *
 * An edit never changes a generation's persisted `status` — the app stays `complete` the whole
 * time, and a failed edit leaves it `complete` too — so the sidebar had nothing to show for it.
 * This is the transient half of that state, kept in memory on purpose: it only has to be true
 * for the seconds a model call takes, a restart correctly forgets it (the request that set it
 * died with the process), and it needs no migration or cleanup sweep for a row stuck "editing".
 * The sidebar list reads it (views.ts's `generationList`) to show an "updating" badge, and the
 * delete route reads it to refuse removing an app mid-edit for the same reason it refuses one
 * mid-generation — see store's `deleteGeneration`.
 *
 * Counted, not a plain set, because two edits to one app can overlap (the second one loses the
 * optimistic-lock race, but both are still running until they finish).
 */
const running = new Map<string, number>();

/** Marks an edit as started; returns the function that marks it finished (safe to call twice). */
export function beginEdit(generationId: string): () => void {
  running.set(generationId, (running.get(generationId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (running.get(generationId) ?? 1) - 1;
    if (left <= 0) running.delete(generationId);
    else running.set(generationId, left);
  };
}

export function isEditing(generationId: string): boolean {
  return running.has(generationId);
}
