/**
 * S14 follow-up — `routeEdit` must not let `TruncationError` escape as a raw failure.
 * Target: packages/generator/src/edit-router.ts's `routeEdit`.
 *
 * Before this fix, a truncated router reply threw `TruncationError` straight out of
 * `provider.completeText`, bypassing `routeEdit`'s own parse-and-throw-RoutingError logic —
 * so `apps/studio/src/edits.ts`'s `RoutingError` catch (the friendly "I could not tell which
 * part to change — pick one below" path) never fired, and the request fell through to the
 * generic 500 branch instead. The fix catches `TruncationError` from routeEdit's own call
 * only, logs a diagnostic that says "truncated" (not the generic RoutingError parse-failure
 * shape), and re-throws as `RoutingError` — semantically honest, since a truncated router
 * reply genuinely means "could not determine the target".
 *
 * Unit-level cases exercise `routeEdit` directly against the fake provider (same fixture and
 * `withEnv` pattern as provider-adapters.test.ts's S14 cases and parallel-fill.test.ts).
 * The route-level case drives the real HTTP endpoint end to end to confirm the user actually
 * gets the friendly html, not a 500, through apps/studio/src/edits.ts.
 *
 * Also covers the sibling gap: `RefusalError("empty response", "empty")` — hidden reasoning
 * consuming the whole budget before any visible output — gets the same RoutingError treatment
 * as TruncationError, for the same reason. A `RefusalError` with `kind: "declined"`
 * (content_filter, an explicit refusal) must NOT get that treatment; it has to propagate so
 * the caller sees a real decline, not "I couldn't tell which part to change."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { routeEdit, RoutingError, TruncationError, RefusalError } from "@any-app/generator";
import type { AppPlan } from "@any-app/protocol";

const { Pool } = pg;

function planWithOneSlot(): AppPlan {
  return {
    title: "Test App",
    css: ".card{padding:8px}",
    shell: `<div data-slot="hero"></div>`,
    script: "",
    slots: [{ id: "hero", height: 200, spec: "a welcome banner" }],
    collections: [],
  };
}

/** Saves and restores every listed env var around `fn` — see provider-adapters.test.ts's
 * identical helper for why this matters within one `node --test` process. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function routerEnv(fake: FakeProvider): Record<string, string> {
  return {
    LLM_PROVIDER: "openai",
    LLM_MODEL: "fake-model",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: fake.baseUrl,
    LLM_ROUTER_MAX_TOKENS: "20",
  };
}

function withConsoleWarn(fn: () => Promise<void>): Promise<string[]> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  return fn()
    .then(() => warns)
    .finally(() => {
      console.warn = original;
    });
}

// -----------------------------------------------------------------------------------------
// Unit-level: routeEdit against the fake provider directly
// -----------------------------------------------------------------------------------------

test("a truncated router reply surfaces as RoutingError, not TruncationError", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const plan = planWithOneSlot();

  await withEnv(routerEnv(fake), async () => {
    fake.queueComplete({ text: "sl", finish: "length" }); // cut off mid-word, before it could finish "slot hero"

    await assert.rejects(
      () => routeEdit("make the banner bigger", plan, null),
      (error: unknown) => error instanceof RoutingError && !(error instanceof TruncationError),
      "must reject with RoutingError, not let TruncationError escape",
    );
  });
});

test("the RoutingError from a truncated router reply names max_tokens, distinct from an unparseable-answer RoutingError", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const plan = planWithOneSlot();

  await withEnv(routerEnv(fake), async () => {
    fake.queueComplete({ text: "sl", finish: "length" });

    try {
      await routeEdit("make the banner bigger", plan, null);
      assert.fail("expected routeEdit to reject");
    } catch (error) {
      assert.ok(error instanceof RoutingError);
      assert.match((error as Error).message, /truncat/i);
      assert.match((error as Error).message, /max_tokens=20/);
    }
  });
});

test("the log distinguishes a truncated router reply from a merely-unparseable one", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const plan = planWithOneSlot();

  await withEnv(routerEnv(fake), async () => {
    // Case 1: truncated — must warn, and the warning must say so.
    fake.queueComplete({ text: "sl", finish: "length" });
    const truncatedWarns = await withConsoleWarn(async () => {
      await assert.rejects(() => routeEdit("make the banner bigger", plan, null));
    });
    assert.ok(
      truncatedWarns.some((w) => /truncat/i.test(w) && /max_tokens/.test(w)),
      `expected a console.warn mentioning truncation and max_tokens, got: ${JSON.stringify(truncatedWarns)}`,
    );

    // Case 2: a complete, well-formed reply that simply doesn't parse — no such warning.
    fake.queueComplete({ text: "not a valid route", finish: "stop" });
    const unparseableWarns = await withConsoleWarn(async () => {
      await assert.rejects(
        () => routeEdit("make the banner bigger", plan, null),
        (error: unknown) => error instanceof RoutingError,
      );
    });
    assert.equal(
      unparseableWarns.some((w) => /truncat/i.test(w)),
      false,
      "an unparseable (but not truncated) answer must not be logged as a truncation",
    );
  });
});

test("an empty router reply (hidden reasoning ate the whole budget) surfaces as RoutingError, not RefusalError", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const plan = planWithOneSlot();

  await withEnv(routerEnv(fake), async () => {
    // No text, finish "stop" — no explicit refusal signal, just nothing written. This is
    // the RefusalError(reason, "empty") shape, not a content_filter/refusal decline.
    fake.queueComplete({ text: "", finish: "stop" });

    await assert.rejects(
      () => routeEdit("make the banner bigger", plan, null),
      (error: unknown) => error instanceof RoutingError && !(error instanceof RefusalError),
      "must reject with RoutingError, not let RefusalError escape",
    );
  });
});

test("a content_filter router refusal is NOT converted to RoutingError — it must still propagate as a refusal", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const plan = planWithOneSlot();

  await withEnv(routerEnv(fake), async () => {
    fake.queueComplete({ finish: "content_filter" });

    try {
      await routeEdit("make the banner bigger", plan, null);
      assert.fail("expected routeEdit to reject");
    } catch (error) {
      assert.ok(error instanceof RefusalError, `expected a RefusalError, got ${error}`);
      assert.ok(!(error instanceof RoutingError), "a real decline must not be disguised as RoutingError");
      assert.equal((error as RefusalError).kind, "declined");
    }
  });
});

test("the log distinguishes an empty router reply from a truncated one and from a merely-unparseable one", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const plan = planWithOneSlot();

  await withEnv(routerEnv(fake), async () => {
    fake.queueComplete({ text: "", finish: "stop" });
    const emptyWarns = await withConsoleWarn(async () => {
      await assert.rejects(() => routeEdit("make the banner bigger", plan, null));
    });
    assert.ok(
      emptyWarns.some((w) => /empty/i.test(w) && !/truncat/i.test(w)),
      `expected a console.warn mentioning "empty" but not "truncat", got: ${JSON.stringify(emptyWarns)}`,
    );
  });
});

test("a normal, complete router response is unaffected", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const plan = planWithOneSlot();

  await withEnv(routerEnv(fake), async () => {
    fake.queueComplete({ text: "css", finish: "stop" });
    const target = await routeEdit("make the background blue", plan, null);
    assert.deepEqual(target, { kind: "css" });
  });

  await withEnv(routerEnv(fake), async () => {
    fake.queueComplete({ text: "slot hero", finish: "stop" });
    const target = await routeEdit("reword the banner", plan, null);
    assert.deepEqual(target, { kind: "slot", id: "hero" });
  });
});

// -----------------------------------------------------------------------------------------
// Route-level: the real HTTP endpoint must return the friendly html, not a raw 500
// -----------------------------------------------------------------------------------------

async function insertCompleteGeneration(databaseUrl: string, prompt: string): Promise<string> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const plan = {
      title: "Test App",
      css: ".card{padding:8px}",
      shell: `<div data-slot="hero"></div>`,
      script: "",
      slots: [{ id: "hero", height: 200, spec: "a welcome banner" }],
      collections: [],
      content: { hero: "<p>hi</p>" },
    };
    const document = `<!doctype html><html><body><p>hi</p></body></html>`;
    const { rows } = await pool.query<{ id: string }>(
      `insert into generations (prompt, status, document, plan) values ($1, 'complete', $2, $3) returning id`,
      [prompt, document, JSON.stringify(plan)],
    );
    return rows[0]!.id;
  } finally {
    await pool.end();
  }
}

test("route: a truncated router call ends in the friendly routing-failure html, not a raw 500", async (t) => {
  const scratch = await createScratchDatabase();
  t.after(() => scratch.drop());
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const [studioPort, sandboxPort] = await findFreePorts(2);
  const servers = await startServers({
    databaseUrl: scratch.databaseUrl,
    sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
    env: {
      LLM_PROVIDER: "openai",
      LLM_MODEL: "fake-model",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: fake.baseUrl,
      LLM_ROUTER_MAX_TOKENS: "20",
    },
  });
  t.after(() => servers.stop());

  const id = await insertCompleteGeneration(scratch.databaseUrl, "an app with a hero banner");
  fake.queueComplete({ text: "sl", finish: "length" }); // the router call, cut off

  const res = await fetch(`${servers.studioOrigin}/generations/${id}/edits`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ instruction: "make the banner bigger" }).toString(),
  });
  const body = await res.text();

  assert.equal(res.status, 200, "must not be a raw 500 — RoutingError renders as a normal 200 html fragment");
  assert.ok(
    body.includes("I could not tell which part to change"),
    `expected the friendly routing-failure message, got: ${body}`,
  );
});
