/**
 * The opencode.ai "zen" gateway started rejecting every request with a 400 on 2026-09-07
 * unless it carries a stable `x-opencode-session` header (see .docs/open-problems.md's
 * "the gateway started requiring x-opencode-session" entry, and CLAUDE.md's provider
 * section). This file proves the fix: both adapters send the header on every request they
 * make, the id is the caller's `conversationId` when given, the id is REUSED across every
 * call in one conversation rather than regenerated per request, and a call with no
 * conversation in scope (credential validation) still always carries a header — via a
 * stable per-process fallback, never a fresh id.
 *
 * Same fixture/pattern as provider-adapters.test.ts (G-suite): the fake HTTP server records
 * every request's headers, and the real adapters (imported by relative path, same
 * justification as that file) are run against it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import type { ProviderCredential } from "@any-app/generator";
import { createOpenAIProvider } from "../../packages/generator/src/providers/openai";
import { createAnthropicProvider } from "../../packages/generator/src/providers/anthropic";
import type { ProviderRequest } from "../../packages/generator/src/providers/types";
import {
  conversationHeaders,
  resolveConversationId,
  PROVIDER_USER_AGENT,
} from "../../packages/generator/src/providers/session";

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

// -----------------------------------------------------------------------------------------
// Unit: providers/session.ts's own pure logic
// -----------------------------------------------------------------------------------------

test("session.ts — resolveConversationId returns the given id when present", () => {
  assert.equal(resolveConversationId("gen-123"), "gen-123");
});

test("session.ts — resolveConversationId falls back to a stable, non-empty id when omitted, and NEVER changes between calls", () => {
  const a = resolveConversationId(undefined);
  const b = resolveConversationId(undefined);
  assert.ok(a, "fallback id must not be empty");
  assert.equal(a, b, "the fallback must be the SAME id every time, not freshly generated per call");
});

test("session.ts — conversationHeaders always sets both x-opencode-session and User-Agent, with the project's own User-Agent value", () => {
  const withId = conversationHeaders("gen-abc");
  assert.equal(withId["x-opencode-session"], "gen-abc");
  assert.equal(withId["User-Agent"], PROVIDER_USER_AGENT);

  const withoutId = conversationHeaders(undefined);
  assert.ok(withoutId["x-opencode-session"], "must still carry a session header with no conversationId given");
  assert.equal(withoutId["User-Agent"], PROVIDER_USER_AGENT);
});

// -----------------------------------------------------------------------------------------
// Integration: the real adapters actually send it, on every call shape
// -----------------------------------------------------------------------------------------

test("OpenAI — completeText sends x-opencode-session and a project User-Agent, not the SDK default", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueComplete({ text: "ok" });
  await provider.completeText("fake-model", req({ conversationId: "gen-1" }));

  const captured = fake.requests().at(-1)!;
  assert.equal(captured.headers["x-opencode-session"], "gen-1");
  assert.equal(captured.headers["user-agent"], PROVIDER_USER_AGENT, "must not be the SDK's own generic User-Agent");
});

test("OpenAI — streamText sends x-opencode-session too, not just completeText", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueStream({ chunks: ["hi"], finish: "stop" });
  await collect(provider.streamText("fake-model", req({ conversationId: "gen-2" })));

  const captured = fake.requests().at(-1)!;
  assert.equal(captured.headers["x-opencode-session"], "gen-2");
  assert.equal(captured.headers["user-agent"], PROVIDER_USER_AGENT);
});

test("Anthropic — completeText and streamText both send x-opencode-session and the project User-Agent", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));

  fake.queueComplete({ text: "ok" });
  await provider.completeText("fake-model", req({ conversationId: "gen-3" }));
  const completeCaptured = fake.requests().at(-1)!;
  assert.equal(completeCaptured.headers["x-opencode-session"], "gen-3");
  assert.equal(completeCaptured.headers["user-agent"], PROVIDER_USER_AGENT);

  fake.queueStream({ chunks: ["hi"], finish: "stop" });
  await collect(provider.streamText("fake-model", req({ conversationId: "gen-3" })));
  const streamCaptured = fake.requests().at(-1)!;
  assert.equal(streamCaptured.headers["x-opencode-session"], "gen-3");
  assert.equal(streamCaptured.headers["user-agent"], PROVIDER_USER_AGENT);
});

test("both adapters — a request with NO conversationId still carries the header (never missing, per the 400 this fixes)", async (t) => {
  const openaiFake = await startFakeProvider();
  t.after(() => openaiFake.close());
  const anthropicFake = await startFakeProvider();
  t.after(() => anthropicFake.close());

  openaiFake.queueComplete({ text: "ok" });
  await createOpenAIProvider(openaiCred(openaiFake)).completeText("fake-model", req());
  assert.ok(openaiFake.requests().at(-1)!.headers["x-opencode-session"], "OpenAI: header must be present even with no conversationId");

  anthropicFake.queueComplete({ text: "ok" });
  await createAnthropicProvider(anthropicCred(anthropicFake)).completeText("fake-model", req());
  assert.ok(
    anthropicFake.requests().at(-1)!.headers["x-opencode-session"],
    "Anthropic: header must be present even with no conversationId",
  );
});

// -----------------------------------------------------------------------------------------
// The core design requirement: STABLE across a conversation, never a fresh id per request
// -----------------------------------------------------------------------------------------

test("OpenAI — the same conversationId is reused, byte-identical, across planner-shaped, fill-shaped, and edit-shaped calls", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));
  const conversationId = "generation-42";

  // planner: completeText
  fake.queueComplete({ text: "plan" });
  await provider.completeText("fake-model", req({ label: "planner", conversationId }));

  // fill: streamText
  fake.queueStream({ chunks: ["fill"], finish: "stop" });
  await collect(provider.streamText("fake-model", req({ label: "fill", conversationId })));

  // edit-css / edit-slot: completeText again
  fake.queueComplete({ text: "edit" });
  await provider.completeText("fake-model", req({ label: "edit-css", conversationId }));

  const sessionIds = fake.requests().map((r) => r.headers["x-opencode-session"]);
  assert.equal(sessionIds.length, 3);
  assert.deepEqual(
    new Set(sessionIds),
    new Set([conversationId]),
    `every call in one conversation must send the exact same x-opencode-session — got ${JSON.stringify(sessionIds)}`,
  );
});

test("OpenAI — two DIFFERENT conversations (different generation ids) get two DIFFERENT session headers", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createOpenAIProvider(openaiCred(fake));

  fake.queueComplete({ text: "a" });
  await provider.completeText("fake-model", req({ conversationId: "generation-a" }));
  fake.queueComplete({ text: "b" });
  await provider.completeText("fake-model", req({ conversationId: "generation-b" }));

  const [first, second] = fake.requests();
  assert.equal(first!.headers["x-opencode-session"], "generation-a");
  assert.equal(second!.headers["x-opencode-session"], "generation-b");
  assert.notEqual(
    first!.headers["x-opencode-session"],
    second!.headers["x-opencode-session"],
    "distinct generations must not share a session id — that would mix unrelated apps' cache prefixes",
  );
});

test("Anthropic — the same conversationId is reused across completeText and streamText calls", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const provider = createAnthropicProvider(anthropicCred(fake));
  const conversationId = "generation-99";

  fake.queueComplete({ text: "plan" });
  await provider.completeText("fake-model", req({ conversationId }));

  fake.queueStream({ chunks: ["fill"], finish: "stop" });
  await collect(provider.streamText("fake-model", req({ conversationId })));

  const sessionIds = fake.requests().map((r) => r.headers["x-opencode-session"]);
  assert.deepEqual(new Set(sessionIds), new Set([conversationId]));
});

test("OpenAI — the no-conversationId fallback is ALSO stable across separate calls (e.g. repeated credential validation), never regenerated", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  // Two separate provider instances, the way resolve()/build() constructs a fresh client
  // per call — proves the fallback lives above the client, not inside it.
  const providerA = createOpenAIProvider(openaiCred(fake));
  const providerB = createOpenAIProvider(openaiCred(fake));

  fake.queueComplete({ text: "a" });
  await providerA.completeText("fake-model", req());
  fake.queueComplete({ text: "b" });
  await providerB.completeText("fake-model", req());

  const [first, second] = fake.requests();
  assert.ok(first!.headers["x-opencode-session"]);
  assert.equal(
    first!.headers["x-opencode-session"],
    second!.headers["x-opencode-session"],
    "the process-level fallback id must be identical across separate calls/instances, not freshly generated each time",
  );
});
