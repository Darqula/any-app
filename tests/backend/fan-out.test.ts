/**
 * J1–J5 — asCompleted / limitConcurrency.
 * Spec: .docs/tests-backend.md section J. Target: packages/generator/src/fan-out.ts.
 *
 * Neither function is re-exported from @any-app/generator's index.ts — they are exported
 * from their own module (fan-out.ts) but not re-exported through the package barrel (only
 * `parallel-fill.ts`, which imports them directly by relative path, uses them). Reached here
 * the same way, with no production-code change: a relative import straight to the module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asCompleted, limitConcurrency } from "../../packages/generator/src/fan-out";

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test("J1 — asCompleted with tasks resolving out of order yields in completion order, not input order", async () => {
  const tasks = [delay(30, "slow"), delay(5, "fast"), delay(15, "mid")];
  const out: string[] = [];
  for await (const v of asCompleted(tasks)) out.push(v);
  assert.deepEqual(out, ["fast", "mid", "slow"]);
});

test("J2 — asCompleted, every task resolving: all N yielded exactly once", async () => {
  const N = 25;
  const tasks = Array.from({ length: N }, (_, i) => delay(Math.floor(Math.random() * 10), i));
  const out: number[] = [];
  for await (const v of asCompleted(tasks)) out.push(v);
  assert.equal(out.length, N);
  assert.deepEqual([...out].sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i));
});

test(
  "J3 — asCompleted where one task rejects: the generator throws, and no unhandledRejection fires for the others",
  async () => {
    // The property this pins: Promise.race attaches a rejection handler to every pending
    // task, so tasks still in flight when the generator throws do not become unhandled
    // rejections later, even though they DO reject after the generator has already stopped
    // consuming them. Node 22 crashes the whole process on an unhandled rejection, so
    // losing this property turns a closed browser tab (one aborted region among several
    // in-flight ones) into a dead server. This was previously verified only by a throwaway
    // script that no longer exists — see tests-backend.md's J section.
    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount++;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const willRejectSoon = (async () => {
        await delay(5, undefined);
        throw new Error("early failure");
      })();
      // These settle AFTER the generator has already thrown from the first rejection —
      // exactly the window where an unhandled rejection would otherwise fire.
      const laterResolves = (async () => {
        await delay(50, undefined);
        return "late ok";
      })();
      const laterRejects = (async () => {
        await delay(60, undefined);
        throw new Error("late failure");
      })();

      let caught: unknown = null;
      try {
        for await (const _ of asCompleted([willRejectSoon, laterResolves, laterRejects])) {
          // never expected to yield anything before the throw
        }
      } catch (err) {
        caught = err;
      }

      assert.ok(caught instanceof Error);
      assert.equal((caught as Error).message, "early failure");

      // Let laterResolves and laterRejects actually settle, then drain the microtask/macrotask
      // queue so any unhandledRejection would have had the chance to fire before we assert.
      await delay(80, undefined);
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(unhandledCount, 0, "no task's rejection should ever reach unhandledRejection");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  },
);

test("J4 — limitConcurrency(2) over 5 tasks: never more than 2 running at once, all 5 complete", async () => {
  const limit = limitConcurrency(2);
  let active = 0;
  let maxActive = 0;
  let completed = 0;

  const work = async (ms: number) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(ms, undefined);
    active--;
    completed++;
  };

  await Promise.all([10, 10, 10, 10, 10].map((ms) => limit(() => work(ms))));

  assert.equal(maxActive <= 2, true);
  assert.equal(completed, 5);
});

test("J5 — limitConcurrency with a rejecting task: the semaphore is released, later tasks still run", async () => {
  const limit = limitConcurrency(1);

  const result = await Promise.allSettled([limit(() => Promise.reject(new Error("boom")))]);
  assert.equal(result[0]?.status, "rejected");

  // If release() were skipped on the reject path, this would hang forever (limit is 1, and
  // the failed task would still be holding the only slot) — the test's own timeout is the
  // deadlock detector.
  let secondRan = false;
  await limit(async () => {
    secondRan = true;
  });
  assert.equal(secondRan, true);
});
