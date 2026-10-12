/**
 * Q1-Q16: the outbound guard on user-supplied provider base URLs (SSRF). Q1-Q8 and Q13-Q16 run in-process against
 * loopback test servers with an injected policy, so none of them needs the escape hatch off globally, real DNS or the
 * network. Q9-Q12 need live studios (scratch databases, fake provider): Q10 starts one with the hatch off, Q11 with it
 * on, Q12 with it on in environments that must refuse it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo, Server as NetServer } from "node:net";
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";
import { describeValidationFailure, isAbortError, resolve } from "@any-app/generator";
import {
  BlockedAddressError,
  checkProviderBaseUrl,
  escapeHatchProblem,
  findBlockedAddressError,
  guardedFetch,
  isBlockedAddressError,
  isPublicAddress,
} from "../../packages/generator/src/providers/net-guard";
import type { NetPolicy } from "../../packages/generator/src/providers/net-guard";
import { createOpenAIProvider } from "../../packages/generator/src/providers/openai";
import { createAnthropicProvider } from "../../packages/generator/src/providers/anthropic";
import { VALIDATE_TIMEOUT_MS, validateRequestOptions } from "../../packages/generator/src/providers/validate-options";
import type { ProviderRequest } from "../../packages/generator/src/providers/types";

/** Plain http to loopback is what the test servers speak, so https is not required; only 127.0.0.1 is let through. */
const LOOPBACK_ONLY: NetPolicy = {
  allowPrivate: false,
  requireHttps: false,
  isAddressAllowed: (address) => address === "127.0.0.1",
};

/** Default address rules (everything private refused), plain http allowed so a test server could be reached at all. */
const DEFAULT_RULES: NetPolicy = { allowPrivate: false, requireHttps: false };

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { system: "system prompt", user: "user prompt", maxTokens: 500, label: "test", ...overrides };
}

/** Sets env vars for one async body and restores them, so one case's changes never leak into the next. */
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

interface Listener<S> {
  server: S;
  port: number;
  /** TCP connections accepted: nonzero means the guard let a connection through. */
  connections(): number;
  /** HTTP requests received. */
  requests(): number;
  close(): Promise<void>;
}

async function listenHttp(
  host: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end("ok"),
): Promise<Listener<HttpServer>> {
  let connections = 0;
  let requests = 0;
  const server = createHttpServer((incoming, res) => {
    requests++;
    handler(incoming, res);
  });
  server.on("connection", () => connections++);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function listenTcp(host: string): Promise<Listener<NetServer>> {
  let connections = 0;
  const server = createNetServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    requests: () => 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to be refused, but it resolved" });
}

test("Q1 — address classifier: public addresses pass, every non-public range is refused", () => {
  const publicAddresses = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.0.1", "198.20.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "::ffff:808:808"];
  for (const address of publicAddresses) assert.equal(isPublicAddress(address), true, `${address} must be public`);

  const refused: Record<string, string[]> = {
    "0.0.0.0/8": ["0.0.0.0", "0.1.2.3"],
    loopback: ["127.0.0.1", "127.255.255.254"],
    "10/8": ["10.0.0.1", "10.255.255.255"],
    "172.16/12": ["172.16.0.1", "172.31.255.255"],
    "192.168/16": ["192.168.0.1", "192.168.255.255"],
    "link-local, incl. metadata": ["169.254.0.1", "169.254.169.254"],
    "CGNAT 100.64/10": ["100.64.0.1", "100.127.255.255"],
    "198.18/15": ["198.18.0.1", "198.19.255.255"],
    "protocol/doc/relay ranges": ["192.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "192.88.99.1"],
    "multicast/reserved/broadcast": ["224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"],
    "IPv6 unspecified/loopback": ["::", "::1", "0:0:0:0:0:0:0:1"],
    "fc00::/7": ["fc00::1", "fd12:3456:789a::1"],
    "fe80::/10": ["fe80::1", "febf::1", "fe80::1%eth0"],
    "IPv6 multicast and other non-global": ["ff02::1", "fec0::1", "100::1", "2001:db8::1", "2001::1", "2002:7f00:1::", "64:ff9b::7f00:1"],
    "IPv4-mapped IPv6 judged as its IPv4": ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:192.168.1.1", "0:0:0:0:0:ffff:7f00:1", "[::ffff:127.0.0.1]"],
    "not an address (fail closed)": ["", "garbage", "localhost", "256.1.1.1", "127.1", "2130706433", "0x7f.1"],
  };
  for (const [range, addresses] of Object.entries(refused)) {
    for (const address of addresses) assert.equal(isPublicAddress(address), false, `${address} (${range}) must be refused`);
  }
});

test("Q2 — IP-literal hosts, including alternate IPv4 spellings, are refused before any connection", async (t) => {
  const listener = await listenTcp("127.0.0.1");
  t.after(() => listener.close());
  const guarded = guardedFetch(DEFAULT_RULES)!;
  assert.ok(guarded, "a strict policy must produce a guarded fetch");
  const { port } = listener;

  // 2130706433 and 0x7f.1 and 127.1 are all 127.0.0.1 once the URL parser has normalised them; the lookup hook is never
  // consulted for an IP literal, so this only passes because the connector checks the literal itself.
  const targets = [
    `http://127.0.0.1:${port}/`,
    `http://2130706433:${port}/`,
    `http://0x7f.1:${port}/`,
    `http://127.1:${port}/`,
    `http://0177.0.0.1:${port}/`,
    `http://[::1]:${port}/`,
    `http://[::ffff:127.0.0.1]:${port}/`,
    `http://[::ffff:7f00:1]:${port}/`,
    `http://169.254.169.254/latest/meta-data/`,
    `http://10.0.0.5:${port}/`,
    `http://0.0.0.0:${port}/`,
    `http://[fe80::1]:${port}/`,
  ];
  for (const url of targets) {
    const error = await rejection(guarded(url, { signal: AbortSignal.timeout(5000) }));
    assert.equal(isBlockedAddressError(error), true, `${url} must be refused by the guard, got: ${String(error)} / ${String((error as Error).cause)}`);
  }
  assert.equal(listener.connections(), 0, "no TCP connection may have reached the loopback listener");
});

test("Q3 — a hostname that resolves to a non-public address is refused before connecting (stubbed resolver)", async (t) => {
  const listener = await listenTcp("127.0.0.1");
  t.after(() => listener.close());
  const resolved: string[] = [];
  const guarded = guardedFetch({
    ...DEFAULT_RULES,
    resolve: async (hostname) => {
      resolved.push(hostname);
      return [{ address: "127.0.0.1", family: 4 }];
    },
  })!;

  const error = await rejection(guarded(`http://rebind.example.test:${listener.port}/`, { signal: AbortSignal.timeout(5000) }));
  assert.equal(isBlockedAddressError(error), true, String(error));
  assert.equal(findBlockedAddressError(error)?.byName, true, "a refusal that came from resolving a name is marked as such");
  assert.deepEqual(resolved, ["rebind.example.test"], "the injected resolver must be the one consulted");
  assert.equal(listener.connections(), 0);

  // A name with one public and one private answer is refused as a whole, not "the public one is used".
  const mixed = guardedFetch({
    ...DEFAULT_RULES,
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
  })!;
  assert.equal(isBlockedAddressError(await rejection(mixed("http://mixed.example.test/", { signal: AbortSignal.timeout(5000) }))), true);

  // The system resolver path: "localhost" resolves to loopback, which the default rules refuse.
  const system = guardedFetch(DEFAULT_RULES)!;
  const viaSystem = await rejection(system(`http://localhost:${listener.port}/`, { signal: AbortSignal.timeout(5000) }));
  assert.equal(isBlockedAddressError(viaSystem), true, String(viaSystem));
  assert.equal(listener.connections(), 0);
});

test("Q4 — the address actually connected is what is judged (a lookup answer that passes does not excuse the peer)", async (t) => {
  const listener = await listenHttp("127.0.0.1");
  t.after(() => listener.close());

  // Allowed for a hostname that resolves to loopback, so the guarded fetch reaches the server.
  const allowing = guardedFetch({
    ...LOOPBACK_ONLY,
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  })!;
  const ok = await allowing(`http://ok.example.test:${listener.port}/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "ok");
  assert.equal(listener.requests(), 1);

  // DNS rebinding in miniature: the name check passes (first verdict), the socket's peer is then judged again and
  // refused (second verdict). No HTTP request may be sent on the refused connection.
  let verdicts = 0;
  const rebinding = guardedFetch({
    ...DEFAULT_RULES,
    isAddressAllowed: () => ++verdicts === 1,
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  })!;
  const error = await rejection(rebinding(`http://rebinding.example.test:${listener.port}/`, { signal: AbortSignal.timeout(5000) }));
  assert.equal(isBlockedAddressError(error), true, String(error));
  assert.ok(verdicts >= 2, "the peer address must be judged after the connection, not only the lookup answer");
  assert.equal(listener.requests(), 1, "the refused connection must not have carried a request");
});

test("Q5 — a redirect is refused outright: no hop is made, not even to an allowed address", async (t) => {
  const target = await listenHttp("127.0.0.1");
  t.after(() => target.close());
  const resolved: string[] = [];
  const guarded = guardedFetch({
    ...LOOPBACK_ONLY,
    resolve: async (hostname) => {
      resolved.push(hostname);
      return [{ address: "127.0.0.1", family: 4 }];
    },
  })!;

  const locations = [
    `http://127.0.0.1:${target.port}/fine`, // an allowed address: refused all the same
    `http://127.0.0.2:${target.port}/secret`,
    "http://[::1]:8443/x",
    "http://169.254.169.254/latest/meta-data/",
    `http://hop.example.test:${target.port}/`, // a name: the resolver must not even be asked
  ];
  const statuses = [301, 302, 303, 307, 308];
  let origins = 0;
  for (const [index, location] of locations.entries()) {
    const status = statuses[index % statuses.length]!;
    const origin = await listenHttp("127.0.0.1", (_incoming, res) => res.writeHead(status, { location }).end());
    t.after(() => origin.close());
    const error = await rejection(guarded(`http://127.0.0.1:${origin.port}/`, { method: "POST", body: "secret-body", signal: AbortSignal.timeout(5000) }));
    assert.equal(origin.requests(), 1, `${status} ${location}: the origin was asked once`);
    assert.equal(isBlockedAddressError(error), false, "refused as a redirect, not as an address: no hop was attempted");
    origins++;
  }
  assert.equal(origins, locations.length);
  assert.equal(target.connections(), 0, "no redirect target was ever connected to");
  assert.deepEqual(resolved, [], "no redirect target name was ever resolved");

  // Through a provider adapter, so an SDK-supplied redirect option cannot undo it.
  const hopper = await listenHttp("127.0.0.1", (_incoming, res) => res.writeHead(307, { location: `http://127.0.0.1:${target.port}/` }).end());
  t.after(() => hopper.close());
  for (const [name, create] of [
    ["openai", createOpenAIProvider],
    ["anthropic", createAnthropicProvider],
  ] as const) {
    const provider = create({ provider: name, apiKey: "test-key", baseUrl: `http://127.0.0.1:${hopper.port}` }, { userSupplied: true, netPolicy: LOOPBACK_ONLY });
    await rejection(provider.validate("fake-model"));
    await rejection(provider.completeText("fake-model", req()));
  }
  assert.equal(target.connections(), 0, "adapters never followed a redirect either");
});

test("Q6 — https is required by default and the escape hatch switches the guard off entirely", () => {
  const guarded = guardedFetch({ allowPrivate: false })!;
  return rejection(guarded("http://example.test/", { signal: AbortSignal.timeout(5000) })).then((error) => {
    assert.equal(isBlockedAddressError(error), true, "a plain-http URL must be refused when https is required");
    assert.equal(guardedFetch({ allowPrivate: true }), undefined, "the hatch leaves the SDK on its own fetch");

    const saved = process.env.ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS;
    try {
      process.env.ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS = "1";
      assert.equal(guardedFetch(), undefined);
      process.env.ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS = "true";
      assert.ok(guardedFetch(), "only the literal value 1 enables the hatch");
      delete process.env.ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS;
      assert.ok(guardedFetch(), "strict by default");
    } finally {
      if (saved === undefined) delete process.env.ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS;
      else process.env.ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS = saved;
    }
  });
});

test("Q7 — both adapters refuse a user-supplied loopback URL on validate and on generation calls; operator URLs are untouched", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());

  for (const [name, create] of [
    ["openai", createOpenAIProvider],
    ["anthropic", createAnthropicProvider],
  ] as const) {
    const credential = { provider: name, apiKey: "test-key", baseUrl: fake.baseUrl };
    const user = create(credential, { userSupplied: true, netPolicy: DEFAULT_RULES });
    const baseline = fake.requestCount();

    assert.equal(isBlockedAddressError(await rejection(user.validate("fake-model"))), true, `${name} validate`);
    assert.equal(isBlockedAddressError(await rejection(user.completeText("fake-model", req()))), true, `${name} completeText`);
    const streamError = await rejection((async () => { for await (const _ of user.streamText("fake-model", req())) { /* drain */ } })());
    assert.equal(isBlockedAddressError(streamError), true, `${name} streamText`);
    assert.equal(fake.requestCount(), baseline, `${name}: the fake provider must not have been contacted`);

    // Not marked user-supplied (a platform credential from .env): same URL, no guard.
    fake.queueComplete({ text: "operator ok" });
    assert.equal(await create(credential).completeText("fake-model", req()), "operator ok", `${name} operator URL`);
    assert.equal(fake.requestCount(), baseline + 1);
  }
});

test("Q8 — a guarded provider still streams and completes through undici's fetch; validate does not retry", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  // Same loopback-only policy as Q4, here to prove SSE streaming, Headers and AbortSignal survive the custom fetch.
  const policy: NetPolicy = LOOPBACK_ONLY;

  for (const [name, create] of [
    ["openai", createOpenAIProvider],
    ["anthropic", createAnthropicProvider],
  ] as const) {
    const provider = create({ provider: name, apiKey: "test-key", baseUrl: fake.baseUrl }, { userSupplied: true, netPolicy: policy });

    fake.queueStream({ chunks: ["Hel", "lo"], finish: "stop" });
    const parts: string[] = [];
    for await (const delta of provider.streamText("fake-model", req())) parts.push(delta);
    assert.equal(parts.join(""), "Hello", `${name} stream`);

    fake.queueComplete({ text: "done" });
    assert.equal(await provider.completeText("fake-model", req()), "done", `${name} complete`);

    const before = fake.requestCount();
    fake.queueError({ status: 500, retryable: true });
    await rejection(provider.validate("fake-model"));
    assert.equal(fake.requestCount() - before, 1, `${name}: validate must not retry a retryable failure`);

    const controller = new AbortController();
    fake.queueStream({});
    const iterator = provider.streamText("fake-model", req({ signal: controller.signal }));
    const pending = iterator.next();
    setTimeout(() => controller.abort(), 100);
    const abortError = await rejection(pending);
    assert.equal(isAbortError(abortError), true, `${name}: an abort must surface as the SDK's abort error, got ${String(abortError)}`);
  }

  assert.equal(VALIDATE_TIMEOUT_MS, 15_000);
  assert.deepEqual(validateRequestOptions(), { timeout: 15_000, maxRetries: 0 });

  // The timeout itself, proved with a short test-only value against a server that never answers.
  const silent = await listenHttp("127.0.0.1", () => { /* never responds */ });
  t.after(() => silent.close());
  for (const [name, create] of [
    ["openai", createOpenAIProvider],
    ["anthropic", createAnthropicProvider],
  ] as const) {
    const provider = create({ provider: name, apiKey: "test-key", baseUrl: `http://127.0.0.1:${silent.port}` }, { userSupplied: true, netPolicy: LOOPBACK_ONLY, validateTimeoutMs: 300 });
    const started = Date.now();
    const timeoutError = await rejection(provider.validate("fake-model"));
    assert.ok(Date.now() - started < 5000, `${name}: validate must give up on its own timeout`);
    assert.match(describeValidationFailure(timeoutError), /Could not reach the provider/);
  }
  assert.equal(silent.requests(), 2, "one attempt per provider, no retry");
});

test("Q9 — save-time URL check: https only, no credentials in the URL, parseable; the hatch relaxes https", () => {
  const strict: NetPolicy = { allowPrivate: false };
  assert.equal(checkProviderBaseUrl("https://api.example.com/v1", strict), null);
  assert.equal(checkProviderBaseUrl("https://api.example.com", strict), null);
  for (const bad of ["http://api.example.com/v1", "ftp://api.example.com", "file:///etc/passwd", "javascript:alert(1)", "api.example.com/v1", "not a url", "https://", "https://user:pass@api.example.com/v1", "https://user@api.example.com/v1", "http://127.0.0.1:8080/v1"]) {
    assert.equal(typeof checkProviderBaseUrl(bad, strict), "string", `${bad} must be rejected with a message`);
  }
  const relaxed: NetPolicy = { allowPrivate: true };
  assert.equal(checkProviderBaseUrl("http://127.0.0.1:8080/v1", relaxed), null);
  assert.equal(typeof checkProviderBaseUrl("ftp://localhost/v1", relaxed), "string", "the hatch relaxes https, not the scheme allow-list");
  assert.equal(typeof checkProviderBaseUrl("http://user:pass@localhost/v1", relaxed), "string", "credentials in the URL are never accepted");
});

async function startStack(t: import("node:test").TestContext, env: Record<string, string> = {}) {
  const scratch = await createScratchDatabase();
  t.after(() => scratch.drop());
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const [studioPort, sandboxPort] = await findFreePorts(2);
  const servers = await startServers({
    databaseUrl: scratch.databaseUrl,
    sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
    env: { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "", ...env },
  });
  t.after(() => servers.stop());
  return { servers, fake };
}

async function postCredential(studioOrigin: string, fields: Record<string, string>, cookie?: string) {
  return fetch(`${studioOrigin}/settings/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ provider: "openai", apiKey: "q-test-key", model: "fake-model", ...fields }),
  });
}

test("Q10 — with the hatch off, the settings route refuses non-https and non-public base URLs with the right reason and stores nothing", async (t) => {
  const { servers, fake } = await startStack(t);
  const fakePort = new URL(fake.baseUrl).port;

  // The https cases target the fake's plain-http port, so an unguarded run would fail the TLS handshake and answer
  // "Could not reach": asserting the specific sentence is what proves the guard (not the handshake) refused them.
  const NOT_ALLOWED = /That base URL is not allowed/;
  const attempts: [string, string, RegExp][] = [
    ["plain http to the fake provider", fake.baseUrl, /must start with https/],
    ["https to a loopback literal", `https://127.0.0.1:${fakePort}/v1`, NOT_ALLOWED],
    ["https to an IPv4-mapped literal", `https://[::ffff:127.0.0.1]:${fakePort}/v1`, NOT_ALLOWED],
    ["https to the metadata address", "https://169.254.169.254/latest", NOT_ALLOWED],
    ["https to a decimal-spelled loopback", `https://2130706433:${fakePort}/v1`, NOT_ALLOWED],
    ["https to a private literal", "https://10.0.0.5/v1", NOT_ALLOWED],
    // A name that resolves to loopback must read exactly like a name that does not resolve (see Q15).
    ["https to localhost", `https://localhost:${fakePort}/v1`, /Could not reach the provider/],
    ["credentials in the URL", "https://user:pass@api.example.com/v1", /username or password/],
    ["unparseable", "not a url", /full address/],
  ];
  let cookie: string | undefined;
  for (const [label, baseUrl, expected] of attempts) {
    for (const provider of ["openai", "anthropic"]) {
      const res = await postCredential(servers.studioOrigin, { provider, baseUrl }, cookie);
      cookie ??= res.headers.get("set-cookie")?.split(";")[0];
      const body = await res.text();
      assert.equal(res.status, 400, `${label} (${provider}) must be refused`);
      assert.ok(body.includes("edit-problem"), `${label}: a readable problem fragment`);
      assert.match(body, expected, `${label} (${provider})`);
      assert.equal(body.includes(fakePort) && body.includes("127.0.0.1"), false, `${label}: the response must not echo the target`);
    }
  }
  assert.equal(fake.requestCount(), 0, "nothing may have been sent to the fake provider on loopback");
  assert.ok(servers.logs("studio").includes("refused address 127.0.0.1"), "the refused address is logged server-side");

  const html = await (await fetch(`${servers.studioOrigin}/settings`, { headers: { cookie: cookie! } })).text();
  assert.ok(html.includes("No credentials saved"), "a refused credential must not have been stored");
});

test("Q11 — a failed validation answers with a fixed sentence; the provider's text is only logged", async (t) => {
  const { servers, fake } = await startStack(t, { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1" });
  const leak = "PROVIDER-BODY-SENTINEL-4f9c";

  const cases: [number, RegExp][] = [
    [401, /rejected the API key/],
    [403, /rejected the API key/],
    [404, /model or URL/],
    [500, /answered with HTTP 500\./],
    [400, /answered with HTTP 400\./],
    [429, /answered with HTTP 429\./],
  ];
  let cookie: string | undefined;
  for (const [status, expected] of cases) {
    fake.queueError({ status, retryable: false, body: { error: { message: `${leak} status ${status} internal host 10.1.2.3:5432`, type: "x" } } });
    const res = await postCredential(servers.studioOrigin, { baseUrl: fake.baseUrl }, cookie);
    cookie ??= res.headers.get("set-cookie")?.split(";")[0];
    const body = await res.text();
    assert.equal(res.status, 400, `status ${status}`);
    assert.match(body, expected, `status ${status}`);
    assert.equal(body.includes(leak), false, `status ${status}: provider text must not be reflected`);
    assert.equal(body.includes("10.1.2.3"), false);
  }
  assert.ok(servers.logs("studio").includes(leak), "the detail is kept in the server log");
  assert.match(servers.logs("studio"), /WARNING: ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS=1/, "the studio warns loudly at boot when the hatch is on");

  // Pure mapping, including the blocked-address case and an arbitrary error that carries body text.
  assert.match(describeValidationFailure(new BlockedAddressError("10.0.0.1")), /not allowed/);
  assert.match(describeValidationFailure(Object.assign(new Error(`${leak}`), { cause: new TypeError("fetch failed", { cause: new BlockedAddressError("10.0.0.1") }) })), /not allowed/);
  assert.match(describeValidationFailure(Object.assign(new Error(leak), { status: 500 })), /answered with HTTP 500\./);
  assert.equal(describeValidationFailure(Object.assign(new Error(leak), { status: 500 })).includes(leak), false);
  assert.match(describeValidationFailure(Object.assign(new Error(leak), { status: 401 })), /rejected the API key/);
  const generic = describeValidationFailure(new Error(leak));
  assert.match(generic, /Could not reach/);
  assert.equal(generic.includes(leak), false);
});

test("Q12 — the studio refuses to boot with the hatch set under NODE_ENV=production or off a loopback host", async (t) => {
  const scratch = await createScratchDatabase();
  t.after(() => scratch.drop());
  for (const [env, expected] of [
    [{ NODE_ENV: "production" }, /must not be set in production/],
    [{ STUDIO_PUBLIC_URL: "http://studio.example.com" }, /not a loopback address/],
    [{ STUDIO_PUBLIC_URL: "http://192.168.1.20:3000" }, /not a loopback address/],
  ] as const) {
    const [studioPort, sandboxPort] = await findFreePorts(2);
    await assert.rejects(
      () =>
        startServers({
          databaseUrl: scratch.databaseUrl,
          sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
          ports: { studio: studioPort!, sandbox: sandboxPort! },
          env: { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", ...env },
        }),
      expected,
      JSON.stringify(env),
    );
  }
});

test("Q13 — a user key with no base URL goes to the provider's public API and carries none of the operator's credentials", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());

  await withEnv(
    {
      OPENAI_BASE_URL: fake.baseUrl,
      ANTHROPIC_BASE_URL: fake.baseUrl,
      ANTHROPIC_AUTH_TOKEN: "operator-auth-token",
      OPENAI_ORG_ID: "org-operator",
      OPENAI_PROJECT_ID: "proj-operator",
    },
    async () => {
      for (const [name, create, publicHost] of [
        ["openai", createOpenAIProvider, "api.openai.com"],
        ["anthropic", createAnthropicProvider, "api.anthropic.com"],
      ] as const) {
        // The resolver stub records the host and answers "no such host", so nothing leaves the machine.
        const hosts: string[] = [];
        const user = create({ provider: name, apiKey: "user-key" }, {
          userSupplied: true,
          netPolicy: { allowPrivate: false, resolve: async (hostname) => { hosts.push(hostname); return []; } },
        });
        const baseline = fake.requestCount();
        await rejection(user.validate("fake-model"));
        assert.deepEqual(hosts, [publicHost], `${name}: a user key with no URL targets the public API, not the operator's URL from env`);
        assert.equal(fake.requestCount(), baseline, `${name}: the operator's gateway must not see the user's key`);

        // The platform credential keeps the SDK's env fallback.
        fake.queueComplete({ text: "platform ok" });
        assert.equal(await create({ provider: name, apiKey: "platform-key" }).completeText("fake-model", req()), "platform ok", `${name} platform`);
        assert.equal(fake.requestCount(), baseline + 1, `${name}: the platform credential still uses the operator's URL`);

        // A user key with its own URL must not carry the operator's auth token or organization either.
        fake.queueComplete({ text: "user ok" });
        const own = create({ provider: name, apiKey: "user-key", baseUrl: fake.baseUrl }, { userSupplied: true, netPolicy: LOOPBACK_ONLY });
        assert.equal(await own.completeText("fake-model", req()), "user ok");
        const sent = fake.requests().at(-1)!.headers;
        assert.equal(sent["openai-organization"], undefined, `${name}: no operator organization`);
        assert.equal(sent["openai-project"], undefined, `${name}: no operator project`);
        assert.equal(JSON.stringify(sent).includes("operator-auth-token"), false, `${name}: no operator auth token`);
      }
    },
  );
});

test("Q14 — resolve() guards a stored user credential but not the operator's own URL (hatch off)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());

  await withEnv(
    {
      ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: undefined,
      LLM_PROVIDER: "openai",
      LLM_MODEL: "fake-model",
      LLM_MAX_TOKENS: "100",
      OPENAI_API_KEY: "operator-key",
      OPENAI_BASE_URL: fake.baseUrl,
    },
    async () => {
      for (const baseUrl of [fake.baseUrl, `https://127.0.0.1:${new URL(fake.baseUrl).port}/v1`, `https://[::ffff:127.0.0.1]:${new URL(fake.baseUrl).port}/v1`]) {
        const user = resolve("fill", { provider: "openai", apiKey: "user-key", baseUrl });
        assert.equal(user.usedPlatformCredential, false);
        const error = await rejection(user.provider.completeText(user.model, req()));
        assert.equal(isBlockedAddressError(error), true, `${baseUrl}: ${String(error)}`);
        assert.equal(fake.requestCount(), 0, `${baseUrl}: no request may reach the server`);
      }

      fake.queueComplete({ text: "operator ok" });
      const platform = resolve("fill", null);
      assert.equal(platform.usedPlatformCredential, true);
      assert.equal(await platform.provider.completeText(platform.model, req()), "operator ok");
      assert.equal(fake.requestCount(), 1, "the operator's own URL on loopback still works");
    },
  );
});

test("Q15 — a hostname the guard refuses reads exactly like one that does not resolve; a literal address says not allowed", async () => {
  const sentenceFor = async (baseUrl: string, answer: ResolvedLike[] | "nxdomain") => {
    const provider = createOpenAIProvider({ provider: "openai", apiKey: "k", baseUrl }, {
      userSupplied: true,
      netPolicy: {
        allowPrivate: false,
        resolve: async () => {
          if (answer === "nxdomain") throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
          return answer;
        },
      },
    });
    return describeValidationFailure(await rejection(provider.validate("fake-model")));
  };
  type ResolvedLike = { address: string; family: 4 | 6 };

  const internal = await sentenceFor("https://db.internal.example/v1", [{ address: "10.0.0.7", family: 4 }]);
  const missing = await sentenceFor("https://nope.internal.example/v1", "nxdomain");
  const empty = await sentenceFor("https://empty.internal.example/v1", []);
  assert.equal(internal, missing, "an internal name and a missing name must give the same sentence");
  assert.equal(internal, empty);
  assert.match(internal, /Could not reach the provider/);

  const literal = await sentenceFor("https://10.0.0.7/v1", "nxdomain");
  assert.match(literal, /not allowed/, "a literal address reveals nothing, so it is named");
});

test("Q16 — the escape hatch is refused in production and off a loopback studio URL", () => {
  const ok = [
    {},
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "" , NODE_ENV: "production" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://localhost:3000" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://studio.localhost:3000" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://127.0.0.1:3000" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://127.4.5.6" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://[::1]:3000" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", NODE_ENV: "development", STUDIO_PUBLIC_URL: "http://localhost:3000" },
  ];
  for (const env of ok) assert.equal(escapeHatchProblem(env), null, JSON.stringify(env));

  const refused = [
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", NODE_ENV: "production" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", NODE_ENV: "production", STUDIO_PUBLIC_URL: "http://localhost:3000" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "https://studio.example.com" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://192.168.1.20:3000" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://10.0.0.5" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://127.0.0.1.evil.example" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "http://localhost.evil.example" },
    { ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS: "1", STUDIO_PUBLIC_URL: "not a url" },
  ];
  for (const env of refused) assert.equal(typeof escapeHatchProblem(env), "string", JSON.stringify(env));
});
