/**
 * Yields results in completion order. Tasks must never reject — a rejection would take the
 * Promise.race with it and lose every other pending task. Callers wrap failures into a
 * result value instead; see `fillAllSlots`.
 */
export async function* asCompleted<T>(tasks: Promise<T>[]): AsyncGenerator<T> {
  const pending = new Map<number, Promise<{ index: number; value: T }>>();
  tasks.forEach((task, index) => pending.set(index, task.then((value) => ({ index, value }))));

  while (pending.size > 0) {
    const { index, value } = await Promise.race(pending.values());
    pending.delete(index);
    yield value;
  }
}

/**
 * Bounds concurrency to `limit` without losing completion-order streaming. A simpler
 * "run `worker` over `items` with at most `limit` in flight" helper is tempting here, but it
 * only resolves once every item is done, which silently destroys completion-order streaming
 * the moment `items.length > limit` — exactly the case the cap exists for. Every task
 * starts immediately instead (so `asCompleted` can race all of them by real completion
 * time, including queueing delay), while a semaphore gates how many are actually doing
 * work — i.e. calling the provider — at once.
 */
export function limitConcurrency(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];

  function acquire(): Promise<void> {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
