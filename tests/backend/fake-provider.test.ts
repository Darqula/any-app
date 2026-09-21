/**
 * Self-test of tests/harness/fake-provider.ts: it runs the real adapters against the fixture and asserts what they produce, not what the
 * fixture wrote. Covers both serialisers, mid-marker chunk splits, delays, manual chunk-driving, request counting, abort recording,
 * every error shape, and instance isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { RefusalError } from "@any-app/generator";
import type { ProviderCredential } from "@any-app/generator";
// Not in @any-app/generator's exports map, so imported by relative path (which bypasses the map).
import { createOpenAIProvider } from "../../packages/generator/src/providers/openai";
import { createAnthropicProvider } from "../../packages/generator/src/providers/anthropic";
import type { ProviderRequest } from "../../packages/generator/src/providers/types";

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

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("waitFor: condition never became true within " + timeoutMs + "ms");
}


test("OpenAI serialiser: streamText yields exactly the scripted chunks, boundary preserved (G1)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  // The marker is split mid-token, as in A6.3, proving the fixture delivers the split through the real OpenAI adapter.
  fake.queueStream({ chunks: ["===SLO", "T timer===\n<div>ok</div>\n"], finish: "stop" });

  const deltas = await collect(provider.streamText("fake-model", req()));
  assert.deepEqual(deltas, ["===SLO", "T timer===\n<div>ok</div>\n"]);
  assert.equal(deltas.join(""), "===SLOT timer===\n<div>ok</div>\n");
});

test("Anthropic serialiser: streamText yields exactly the scripted chunks, boundary preserved (G2)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueStream({ chunks: ["===SLO", "T timer===\n<div>ok</div>\n"], finish: "stop" });

  const deltas = await collect(provider.streamText("fake-model", req()));
  assert.deepEqual(deltas, ["===SLO", "T timer===\n<div>ok</div>\n"]);
});

test("Both adapters, completeText: returns the full scripted text (G3)", async (t) => {
  const openaiFake = await startFakeProvider();
  t.after(() => openaiFake.close());
  const anthropicFake = await startFakeProvider();
  t.after(() => anthropicFake.close());

  openaiFake.queueComplete({ text: "hello from openai" });
  const openaiText = await createOpenAIProvider(openaiCred(openaiFake)).completeText("fake-model", req());
  assert.equal(openaiText, "hello from openai");

  anthropicFake.queueComplete({ text: "hello from anthropic" });
  const anthropicText = await createAnthropicProvider(anthropicCred(anthropicFake)).completeText("fake-model", req());
  assert.equal(anthropicText, "hello from anthropic");
});

test("System prompt placement is captured correctly per format (G9)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());

  fake.queueComplete({ text: "ok" });
  await createOpenAIProvider(openaiCred(fake)).completeText("fake-model", req({ system: "SYS-OPENAI" }));
  const openaiReq = fake.requests().at(-1)!;
  assert.equal(openaiReq.system, "SYS-OPENAI");
  assert.equal(
    openaiReq.body.messages.find((m: any) => m.role === "system")?.content,
    "SYS-OPENAI",
    "OpenAI: system prompt is a role:system message, not folded into the user message",
  );

  fake.queueComplete({ text: "ok" });
  await createAnthropicProvider(anthropicCred(fake)).completeText("fake-model", req({ system: "SYS-ANTHROPIC" }));
  const anthropicReq = fake.requests().at(-1)!;
  assert.equal(anthropicReq.system, "SYS-ANTHROPIC");
  assert.equal(anthropicReq.body.messages.some((m: any) => m.role === "system"), false, "Anthropic: never a system message");
});


test("Per-chunk delay: a chunk held back for delayMs actually arrives late", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueStream({ chunks: [{ text: "delayed", delayMs: 300 }], finish: "stop" });

  const start = Date.now();
  const gen = provider.streamText("fake-model", req());
  const first = await gen.next();
  const elapsed = Date.now() - start;

  assert.equal(first.value, "delayed");
  assert.ok(elapsed >= 250, `expected roughly >=300ms before the first chunk, got ${elapsed}ms`);
});


test("Explicit chunk-driving: a manually-driven stream stays open until finish() (frontend requirement)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  // No `chunks` — manual mode. The handle stays connected but open until finish() is called.
  const handle = fake.queueStream();
  const received: string[] = [];
  let done = false;
  const pump = (async () => {
    for await (const delta of provider.streamText("fake-model", req())) received.push(delta);
    done = true;
  })();

  await handle.connected;
  // Top-level fake.emit() sugar: drives the most recently queued stream, the shape the frontend suite uses.
  await fake.emit("first ");
  await waitFor(() => received.length >= 1);
  assert.deepEqual(received, ["first "]);
  assert.equal(done, false, "must still be open — nothing has finished it yet");

  // Also drive via the handle itself, to prove both entry points target the same stream.
  await handle.emit("second");
  assert.equal(done, false, "still open after a second emit — only finish() ends it");

  await handle.finish();
  await pump;
  assert.deepEqual(received, ["first ", "second"]);
  assert.equal(done, true);
});


test("Request counting: requestCount() reflects exactly the calls made, not calls attempted", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  assert.equal(fake.requestCount(), 0);

  fake.queueComplete({ text: "one" });
  await createOpenAIProvider(openaiCred(fake)).completeText("fake-model", req());
  assert.equal(fake.requestCount(), 1);

  fake.queueComplete({ text: "two" });
  await createOpenAIProvider(openaiCred(fake)).completeText("fake-model", req());
  assert.equal(fake.requestCount(), 2);

  // No further call made — this is the shape backend C8 needs ("replay made no provider
  // call"): asserting the count did not move without a new queued response or request.
  assert.equal(fake.requestCount(), 2);
  assert.equal(fake.requests().length, 2);
});


test("Abort recording: a client-aborted OpenAI stream is recorded on the captured request (C10)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  const handle = fake.queueStream(); // manual — stays open until we abort
  const ac = new AbortController();
  const pump = (async () => {
    try {
      for await (const _delta of provider.streamText("fake-model", req({ signal: ac.signal }))) {
        // draining
      }
    } catch {
      // Either a clean early-return or an AbortError depending on SDK internals — both are
      // fine here; only the fixture's own abort bookkeeping is under test.
    }
  })();

  await handle.connected;
  await handle.emit("partial content");
  ac.abort();
  await pump.catch(() => {});

  await waitFor(() => fake.requests().at(-1)!.aborted === true);
  assert.equal(fake.requests().at(-1)!.aborted, true);
});

test("Abort recording: a client-aborted Anthropic stream is recorded on the captured request (C10)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  const handle = fake.queueStream();
  const ac = new AbortController();
  const pump = (async () => {
    try {
      for await (const _delta of provider.streamText("fake-model", req({ signal: ac.signal }))) {
        // draining
      }
    } catch {
      // See the OpenAI version of this test above.
    }
  })();

  await handle.connected;
  await handle.emit("partial content");
  ac.abort();
  await pump.catch(() => {});

  await waitFor(() => fake.requests().at(-1)!.aborted === true);
  assert.equal(fake.requests().at(-1)!.aborted, true);
});


test("OpenAI: finish_reason content_filter surfaces as RefusalError (G5)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueStream({ chunks: ["partial "], finish: "content_filter" });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req())),
    (error: unknown) => error instanceof RefusalError && error.reason === "content_filter",
  );
});

test("OpenAI: empty stream surfaces as RefusalError('empty response') (G8)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueStream({ chunks: [] });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req())),
    (error: unknown) => error instanceof RefusalError && error.reason === "empty response",
  );
});

test("Anthropic: stop_reason refusal WITH stop_details surfaces the category (G6, G7)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueStream({ chunks: [], finish: "refusal", stopDetails: { type: "refusal", category: "policy_violation" } });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req())),
    (error: unknown) => error instanceof RefusalError && error.reason === "policy_violation",
  );
});

test("Anthropic: stop_reason refusal WITHOUT stop_details is null-safe (G6, G7)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueStream({ chunks: [], finish: "refusal" });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req())),
    (error: unknown) => error instanceof RefusalError && error.reason === "refusal",
  );
});

test("Anthropic: empty completeText surfaces as RefusalError('empty response') (G8)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueComplete({});
  await assert.rejects(
    () => provider.completeText("fake-model", req()),
    (error: unknown) => error instanceof RefusalError && error.reason === "empty response",
  );
});

test("HTTP 400: OpenAI completeText throws a real API error, not a RefusalError", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueError({ status: 400, body: { error: { message: "bad request", type: "invalid_request_error" } } });
  await assert.rejects(
    () => provider.completeText("fake-model", req()),
    (error: unknown) => !(error instanceof RefusalError) && (error as any)?.status === 400,
  );
});

test("HTTP 500: Anthropic streamText throws a real API error, not a RefusalError", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  // retryable:false (the default): otherwise the SDK's retries turn one scripted 500 into up to three requests.
  fake.queueError({ status: 500, retryable: false });
  await assert.rejects(
    () => collect(provider.streamText("fake-model", req())),
    (error: unknown) => !(error instanceof RefusalError) && (error as any)?.status === 500,
  );
  assert.equal(fake.requestCount(), 1, "x-should-retry:false must stop the SDK from retrying on its own");
});


test("Multiple fake-provider instances run concurrently without colliding", async (t) => {
  const a = await startFakeProvider();
  t.after(() => a.close());
  const b = await startFakeProvider();
  t.after(() => b.close());

  assert.notEqual(a.baseUrl, b.baseUrl);

  a.queueComplete({ text: "from A" });
  b.queueComplete({ text: "from B" });

  const [textA, textB] = await Promise.all([
    createOpenAIProvider(openaiCred(a)).completeText("fake-model", req({ user: "call-a" })),
    createOpenAIProvider(openaiCred(b)).completeText("fake-model", req({ user: "call-b" })),
  ]);

  assert.equal(textA, "from A");
  assert.equal(textB, "from B");
  assert.equal(a.requestCount(), 1);
  assert.equal(b.requestCount(), 1);
  assert.equal(a.requests()[0]!.body.messages.find((m: any) => m.role === "user")?.content, "call-a");
  assert.equal(b.requests()[0]!.body.messages.find((m: any) => m.role === "user")?.content, "call-b");
});
