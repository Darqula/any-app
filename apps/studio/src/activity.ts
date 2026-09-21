/**
 * Which apps have a follow-up edit running. An edit never changes the stored status, so the sidebar
 * badge and the delete guard need this. In memory on purpose (transient; a restart correctly forgets
 * it). Counted, since edits to one app can overlap.
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
