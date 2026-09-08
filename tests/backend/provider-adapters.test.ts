/**
 * G1–G14 — provider adapters. Spec: .docs/tests-backend.md section G.
 * Target: packages/generator/src/providers/{openai,anthropic}.ts, resolve.ts, roles.ts.
 *
 * These run the *same* assertions against both wire formats via the fake provider fixture
 * (tests/harness/fake-provider.ts) — the whole point of the adapters is to make the two
 * protocols indistinguishable to the rest of the generator, and this is the only way to know
 * that actually holds. `tests/backend/fake-provider.test.ts` is a self-test of the fixture
 * itself and happens to already exercise several of these scenarios (labelled with the same
 * case ids) while proving the fixture is faithful; this file is the dedicated G-suite the
 * task brief asks for and stands on its own.
 *
 * G15 (real provider, nightly/on-demand — never in CI) is listed at the bottom as a
 * documented `skip`, per the task brief: it needs a real key and real money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { RefusalError, TruncationError, isAbortError, resolve, roleConfig, NoCredentialError } from "@any-app/generator";
import type { ProviderCredential } from "@any-app/generator";
// Not part of @any-app/generator's public `exports` (only "." -> src/index.ts is declared).
// Imported by relative filesystem path — Node's ESM resolver does not consult a package's
// `exports` map for a path that never goes through the bare specifier at all. Same approach
// already used by fake-provider.test.ts and fan-out.test.ts; no production code changed.
import { createOpenAIProvider } from "../../packages/generator/src/providers/openai";
import { createAnthropicProvider } from "../../packages/generator/src/providers/anthropic";
import type { ProviderRequest } from "../../packages/generator/src/providers/types";
import { parsePlan } from "../../packages/generator/src/planner";

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { system: "system prompt", user: "user prompt", maxTokens: 500, label: "test", ...overrides };
}

function openaiCred(fake: FakeProvider): ProviderCredential {
  return { provider: "openai", apiKey: "test-key", baseUrl: fake.baseUrl };
}

function anthropicCred(fake: FakeProvider): ProviderCredential {
  return { provider: "anthropic", apiKey: "test-key", baseUrl: fake.baseUrl };
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of gen) out.push(delta);
  return out;
}

/** Saves and restores every listed env var around `fn`, so G11–G13's env manipulation never
 * leaks into a later test in this same process (each test file is its own `node --test`
 * child process, but tests within one file share `process.env`). */
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

const PLAN_TEXT = `===TITLE===
G14 App

===CSS===
.card{padding:8px}

===SHELL===
<div data-slot="alpha"></div><div data-slot="beta"></div>

===SLOTS===
alpha|200|First region
beta|180|Second region

===SCRIPT===

===DATA===
`;

// -----------------------------------------------------------------------------------------
// G1–G3: passthrough
// -----------------------------------------------------------------------------------------

test("G1 — OpenAI adapter, streamText yields exactly choices[0].delta.content text, in order", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueStream({ chunks: ["Hello ", "world", "!"], finish: "stop" });
  const deltas = await collect(provider.streamText("fake-model", req()));
  assert.deepEqual(deltas, ["Hello ", "world", "!"]);
});

test("G2 — Anthropic adapter, streamText yields text_delta content only, in order", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueStream({ chunks: ["Hello ", "world"], finish: "stop" });
  const deltas = await collect(provider.streamText("fake-model", req()));
  assert.deepEqual(deltas, ["Hello ", "world"]);

  // FINDING: the fixture's emit() (tests/harness/fake-provider.ts's makeStreamHandle) only
  // ever produces `content_block_delta` events with `delta.type: "text_delta"` — it has no
  // API to script a `thinking_delta` event. So "thinking deltas are never emitted as app
  // HTML" cannot be driven end-to-end against this fixture without a harness change (out of
  // scope here). What IS verified: real text deltas pass through unchanged (above). The
  // adapter's own gate — packages/generator/src/providers/anthropic.ts's `if (event.type ===
  // "content_block_delta" && event.delta.type === "text_delta")` — was read during
  // investigation but is not exercised by a scripted thinking-delta frame here; see the
  // report.
});

test("G3 — both adapters, completeText: returns the full text of a non-streamed response", async (t) => {
  const openaiFake = await startFakeProvider();
  t.after(() => openaiFake.close());
  const anthropicFake = await startFakeProvider();
  t.after(() => anthropicFake.close());

  openaiFake.queueComplete({ text: "hello from openai" });
  assert.equal(await createOpenAIProvider(openaiCred(openaiFake)).completeText("fake-model", req()), "hello from openai");

  anthropicFake.queueComplete({ text: "hello from anthropic" });
  assert.equal(await createAnthropicProvider(anthropicCred(anthropicFake)).completeText("fake-model", req()), "hello from anthropic");
});

// -----------------------------------------------------------------------------------------
// G4 — abort. The regression: neither SDK's abort class sets `name` to "AbortError", so a
// name-based check looks reasonable and silently never matches. Prove both halves: the real
// check passes, AND the naive check that was wrong once already would still be wrong.
// -----------------------------------------------------------------------------------------

test("G4 — OpenAI: isAbortError is true for OpenAI's own abort error class", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  const handle = fake.queueStream(); // manual mode — stays open until we abort it
  const ac = new AbortController();
  let caught: unknown = null;
  const pump = (async () => {
    try {
      for await (const _delta of provider.streamText("fake-model", req({ signal: ac.signal }))) {
        // draining
      }
    } catch (error) {
      caught = error;
    }
  })();

  await handle.connected;
  await handle.emit("partial content");
  ac.abort();
  await pump;

  assert.ok(caught, "aborting mid-stream must throw");
  assert.equal(isAbortError(caught), true, "isAbortError must recognise OpenAI's own abort class");
  assert.notEqual(
    (caught as Error).name,
    "AbortError",
    "OpenAI's abort error does NOT set name to \"AbortError\" — this is exactly why a name-based check would silently never match, and why isAbortError must use instanceof",
  );
});

test("G4 — Anthropic: isAbortError is true for Anthropic's own abort error class", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  const handle = fake.queueStream();
  const ac = new AbortController();
  let caught: unknown = null;
  const pump = (async () => {
    try {
      for await (const _delta of provider.streamText("fake-model", req({ signal: ac.signal }))) {
        // draining
      }
    } catch (error) {
      caught = error;
    }
  })();

  await handle.connected;
  await handle.emit("partial content");
  ac.abort();
  await pump;

  assert.ok(caught, "aborting mid-stream must throw");
  assert.equal(isAbortError(caught), true, "isAbortError must recognise Anthropic's own abort class");
  assert.notEqual(
    (caught as Error).name,
    "AbortError",
    "Anthropic's abort error does NOT set name to \"AbortError\" either — same trap as the OpenAI SDK",
  );
});

// -----------------------------------------------------------------------------------------
// G5–G8 — refusal and empty-response shapes
// -----------------------------------------------------------------------------------------

test("G5 — OpenAI, finish_reason content_filter surfaces as RefusalError", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueStream({ chunks: ["partial "], finish: "content_filter" });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req())),
    (error: unknown) => error instanceof RefusalError && error.reason === "content_filter",
  );
});

test("G6 — Anthropic, stop_reason refusal surfaces as the SAME RefusalError class OpenAI's content_filter does", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueStream({ chunks: [], finish: "refusal" });
  let caught: unknown = null;
  try {
    await collect(provider.streamText("fake-model", req()));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RefusalError, "must be the exact same RefusalError class G5 used — callers need no provider branch");
});

test("G7 — Anthropic refusal WITH stop_details surfaces the category", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueStream({ chunks: [], finish: "refusal", stopDetails: { type: "refusal", category: "policy_violation" } });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req())),
    (error: unknown) => error instanceof RefusalError && error.reason === "policy_violation",
  );
});

test("G7 — Anthropic refusal WITHOUT stop_details is null-safe", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueStream({ chunks: [], finish: "refusal" }); // stopDetails omitted entirely, not merely empty
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req())),
    (error: unknown) => error instanceof RefusalError && error.reason === "refusal",
  );
});

test("G8 — both adapters, empty response surfaces as RefusalError('empty response')", async (t) => {
  const openaiFake = await startFakeProvider();
  t.after(() => openaiFake.close());
  const anthropicFake = await startFakeProvider();
  t.after(() => anthropicFake.close());

  openaiFake.queueStream({ chunks: [] });
  await assert.rejects(
    () => collect(createOpenAIProvider(openaiCred(openaiFake)).streamText("fake-model", req())),
    (error: unknown) => error instanceof RefusalError && error.reason === "empty response",
  );

  anthropicFake.queueComplete({}); // text omitted
  await assert.rejects(
    () => createAnthropicProvider(anthropicCred(anthropicFake)).completeText("fake-model", req()),
    (error: unknown) => error instanceof RefusalError && error.reason === "empty response",
  );
});

// -----------------------------------------------------------------------------------------
// G9 — system prompt placement
// -----------------------------------------------------------------------------------------

test("G9 — system prompt placement: OpenAI is a role:system message, Anthropic is the top-level system field and never a message", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());

  fake.queueComplete({ text: "ok" });
  await createOpenAIProvider(openaiCred(fake)).completeText("fake-model", req({ system: "SYS-OPENAI" }));
  const openaiReq = fake.requests().at(-1)!;
  assert.equal(
    openaiReq.body.messages.find((m: any) => m.role === "system")?.content,
    "SYS-OPENAI",
    "OpenAI: system prompt must be a role:system message",
  );

  fake.queueComplete({ text: "ok" });
  await createAnthropicProvider(anthropicCred(fake)).completeText("fake-model", req({ system: "SYS-ANTHROPIC" }));
  const anthropicReq = fake.requests().at(-1)!;
  assert.equal(anthropicReq.system, "SYS-ANTHROPIC", "Anthropic: system prompt must reach the top-level system field");
  assert.equal(
    anthropicReq.body.messages.some((m: any) => m.role === "system"),
    false,
    "Anthropic: the system prompt must NEVER appear as a message",
  );
});

// -----------------------------------------------------------------------------------------
// G10 — no assistant prefill
// -----------------------------------------------------------------------------------------

test("G10 — Anthropic: assistant prefill is never attempted", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());

  fake.queueComplete({ text: "ok" });
  await createAnthropicProvider(anthropicCred(fake)).completeText("fake-model", req());
  const captured = fake.requests().at(-1)!;
  assert.deepEqual(
    captured.body.messages.map((m: any) => m.role),
    ["user"],
    "only a single user message is ever sent — an assistant-role prefill message returns a 400 on current models, so the adapter must never attempt one",
  );

  fake.queueStream({ chunks: ["x"], finish: "stop" });
  await collect(createAnthropicProvider(anthropicCred(fake)).streamText("fake-model", req()));
  const streamCaptured = fake.requests().at(-1)!;
  assert.deepEqual(streamCaptured.body.messages.map((m: any) => m.role), ["user"], "same for the streaming path");
});

// -----------------------------------------------------------------------------------------
// G11 — token budget is per-role, not global
// -----------------------------------------------------------------------------------------

test("G11 — a raised token budget applies only to the role configured for it, not globally", async () => {
  await withEnv(
    {
      LLM_MODEL: "base-model",
      LLM_MAX_TOKENS: undefined, // fall back to roles.ts's own per-role defaults
      LLM_FILL_MAX_TOKENS: "120000",
      LLM_PLANNER_MAX_TOKENS: undefined,
    },
    async () => {
      const fill = roleConfig("fill");
      assert.equal(fill.maxTokens, 120000);

      const planner = roleConfig("planner");
      assert.notEqual(planner.maxTokens, 120000, "the raised budget must not leak to an unrelated role");
      assert.equal(planner.maxTokens, 20000, "planner keeps its own default (DEFAULT_MAX_TOKENS.planner)");
    },
  );
});

// -----------------------------------------------------------------------------------------
// G12 — per-role resolution, with fallback
// -----------------------------------------------------------------------------------------

test("G12 — planner, fill, edit, router each resolve their own provider/model/budget; an unset role falls back to the default", async () => {
  await withEnv(
    {
      LLM_PROVIDER: "openai",
      LLM_MODEL: "default-model",
      LLM_MAX_TOKENS: "999",
      LLM_PLANNER_MODEL: "planner-model",
      LLM_PLANNER_MAX_TOKENS: "111",
      LLM_FILL_PROVIDER: "anthropic",
      LLM_FILL_MODEL: "fill-model",
      LLM_FILL_MAX_TOKENS: undefined,
      LLM_EDIT_PROVIDER: undefined,
      LLM_EDIT_MODEL: undefined,
      LLM_EDIT_MAX_TOKENS: undefined,
    },
    async () => {
      const planner = roleConfig("planner");
      assert.equal(planner.provider, "openai");
      assert.equal(planner.model, "planner-model");
      assert.equal(planner.maxTokens, 111);

      const fill = roleConfig("fill");
      assert.equal(fill.provider, "anthropic", "fill has its own provider override");
      assert.equal(fill.model, "fill-model");
      assert.equal(fill.maxTokens, 999, "fill has no LLM_FILL_MAX_TOKENS of its own — falls back to LLM_MAX_TOKENS");

      const edit = roleConfig("edit"); // entirely unset
      assert.equal(edit.provider, "openai", "an unset role falls back to the default provider");
      assert.equal(edit.model, "default-model", "an unset role falls back to the default model");
      assert.equal(edit.maxTokens, 999, "an unset role falls back to the default max tokens");
    },
  );
});

// -----------------------------------------------------------------------------------------
// G13 — resolution fails before any HTTP call
// -----------------------------------------------------------------------------------------

test("G13 — a role pointed at a provider with no credential fails at resolution, before any HTTP call", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());

  await withEnv(
    {
      LLM_MODEL: "fallback-model",
      LLM_FILL_PROVIDER: "openai",
      LLM_FILL_MODEL: "fake-model",
      LLM_FILL_MAX_TOKENS: "2000",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: fake.baseUrl,
      // planner is deliberately pointed at anthropic, with no credential configured anywhere.
      LLM_PLANNER_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
    },
    async () => {
      assert.throws(
        () => resolve("planner", null),
        (error: unknown) => error instanceof NoCredentialError && error.provider === "anthropic",
      );
      assert.equal(fake.requestCount(), 0, "resolve() must throw synchronously, before any request ever reaches the fake");

      // The fill role, correctly configured, still resolves — proves the failure above is
      // per-role, not a global misconfiguration.
      assert.doesNotThrow(() => resolve("fill", null));
      assert.equal(fake.requestCount(), 0, "resolving fill alone still makes no HTTP call — resolve() never calls the provider itself");
    },
  );
});

// -----------------------------------------------------------------------------------------
// G14 — same prompt, both adapters, same parseable output
// -----------------------------------------------------------------------------------------

test("G14 — the same plan prompt through both adapters produces output parsePlan accepts", async (t) => {
  const openaiFake = await startFakeProvider();
  t.after(() => openaiFake.close());
  const anthropicFake = await startFakeProvider();
  t.after(() => anthropicFake.close());

  openaiFake.queueComplete({ text: PLAN_TEXT });
  const openaiText = await createOpenAIProvider(openaiCred(openaiFake)).completeText("fake-model", req());
  const openaiPlan = parsePlan(openaiText);
  assert.equal(openaiPlan.slots.length, 2);
  assert.deepEqual(
    openaiPlan.slots.map((s) => s.id),
    ["alpha", "beta"],
  );

  anthropicFake.queueComplete({ text: PLAN_TEXT });
  const anthropicText = await createAnthropicProvider(anthropicCred(anthropicFake)).completeText("fake-model", req());
  const anthropicPlan = parsePlan(anthropicText);

  assert.deepEqual(openaiPlan, anthropicPlan, "the adapter changes transport, not semantics — parsed plans must be identical");
});

// -----------------------------------------------------------------------------------------
// S14 — a response cut off at the token budget must surface as TruncationError, distinct
// from RefusalError: only a truncation is worth retrying with a bigger budget. Covers both
// wire formats (finish_reason: "length" / stop_reason: "max_tokens") on both call paths.
// See .docs/testing-review.md's S14 entry.
// -----------------------------------------------------------------------------------------

test("S14 — OpenAI, finish_reason length surfaces as TruncationError (not RefusalError) on streamText", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueStream({ chunks: ["partial content"], finish: "length" });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req({ maxTokens: 777 }))),
    (error: unknown) =>
      error instanceof TruncationError &&
      !(error instanceof RefusalError) &&
      error.maxTokens === 777,
  );
});

test("S14 — OpenAI, finish_reason length surfaces as TruncationError (not RefusalError) on completeText", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueComplete({ text: "partial content", finish: "length" });
  await assert.rejects(
    () => provider.completeText("fake-model", req({ maxTokens: 555 })),
    (error: unknown) =>
      error instanceof TruncationError &&
      !(error instanceof RefusalError) &&
      error.maxTokens === 555,
  );
});

test("S14 — Anthropic, stop_reason max_tokens surfaces as TruncationError (not RefusalError) on streamText", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueStream({ chunks: ["partial content"], finish: "length" });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req({ maxTokens: 333 }))),
    (error: unknown) =>
      error instanceof TruncationError &&
      !(error instanceof RefusalError) &&
      error.maxTokens === 333,
  );
});

test("S14 — Anthropic, stop_reason max_tokens surfaces as TruncationError (not RefusalError) on completeText", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueComplete({ text: "partial content", finish: "length" });
  await assert.rejects(
    () => provider.completeText("fake-model", req({ maxTokens: 222 })),
    (error: unknown) =>
      error instanceof TruncationError &&
      !(error instanceof RefusalError) &&
      error.maxTokens === 222,
  );
});

test("S14 — both adapters, a truncated response WITH NO visible text yet is TruncationError, not RefusalError('empty response')", async (t) => {
  // The two checks (truncated vs. empty) could collide when the cutoff lands before the
  // first delta — this pins the order: truncation must win, since "cut off" is the more
  // actionable diagnosis and the caller still needs to know a bigger budget might help.
  const openaiFake = await startFakeProvider();
  t.after(() => openaiFake.close());
  const anthropicFake = await startFakeProvider();
  t.after(() => anthropicFake.close());

  openaiFake.queueStream({ chunks: [], finish: "length" });
  await assert.rejects(
    () => collect(createOpenAIProvider(openaiCred(openaiFake)).streamText("fake-model", req())),
    (error: unknown) => error instanceof TruncationError,
  );

  anthropicFake.queueComplete({ finish: "length" }); // text omitted
  await assert.rejects(
    () => createAnthropicProvider(anthropicCred(anthropicFake)).completeText("fake-model", req()),
    (error: unknown) => error instanceof TruncationError,
  );
});

test("S14 — both adapters, both paths: a normal (stop / end_turn) response is unaffected", async (t) => {
  const openaiFake = await startFakeProvider();
  t.after(() => openaiFake.close());
  const anthropicFake = await startFakeProvider();
  t.after(() => anthropicFake.close());

  openaiFake.queueStream({ chunks: ["all good"], finish: "stop" });
  const streamed = await collect(createOpenAIProvider(openaiCred(openaiFake)).streamText("fake-model", req()));
  assert.deepEqual(streamed, ["all good"]);

  openaiFake.queueComplete({ text: "all good", finish: "stop" });
  assert.equal(await createOpenAIProvider(openaiCred(openaiFake)).completeText("fake-model", req()), "all good");

  anthropicFake.queueStream({ chunks: ["all good"], finish: "stop" });
  const anthropicStreamed = await collect(createAnthropicProvider(anthropicCred(anthropicFake)).streamText("fake-model", req()));
  assert.deepEqual(anthropicStreamed, ["all good"]);

  anthropicFake.queueComplete({ text: "all good", finish: "stop" });
  assert.equal(await createAnthropicProvider(anthropicCred(anthropicFake)).completeText("fake-model", req()), "all good");
});

// -----------------------------------------------------------------------------------------
// G15 — real provider, nightly/on-demand only. Never in CI: needs a real key and real money.
// -----------------------------------------------------------------------------------------

test(
  "G15 — caching: two calls sharing a realistic (~4,500-token) prefix, the second reports a nonzero cache-read count (SKIPPED)",
  { skip: "requires a real provider credential and spends real money — never run in CI; see .docs/open-problems.md for the last measured numbers" },
  async () => {
    // Deliberately not implemented against a live endpoint here. See tests-backend.md's G
    // section and CLAUDE.md's provider notes: a minimal (too-short) shared prefix silently
    // reports zero cache hits, indistinguishable from broken caching — any real
    // implementation of this case must use a realistic prefix, not a token-saving one.
  },
);
