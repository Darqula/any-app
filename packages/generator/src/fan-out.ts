/**
 * Yields in completion order. Tasks must never reject: a rejection would abort the race and lose
 * every other pending task.
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
 * Every task starts at once (so completion order is real) while a semaphore bounds concurrent work.
 * A "worker over items" helper would resolve only at the end and lose completion-order streaming.
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
