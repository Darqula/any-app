/**
 * A real HTTP server speaking both provider wire formats (OpenAI chat-completions, Anthropic Messages), streaming and
 * not: one scripted core with two serialisers. Queued responses are matched in FIFO order regardless of endpoint; an
 * empty queue is a clear 500; every request is recorded in requests(). Contract: tests/README.md.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { findFreePort } from "./ports";


export type WireFormat = "openai" | "anthropic";

/**
 * What ends a scripted response. Not every value exists on every format: serialisers throw rather than emit an impossible
 * shape. "length" maps to Anthropic's max_tokens.
 */
export type FinishKind = "stop" | "content_filter" | "refusal" | "length";

export interface StopDetailsSpec {
  type: string;
  category?: string;
}

export interface UsageSpec {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChunkSpec {
  text: string;
  /** Milliseconds to wait *before* sending this chunk — the per-chunk delay knob backend E4
   * needs for its "headers arrive well before a delayed first chunk" assertion. */
  delayMs?: number;
}

export interface StreamScript {
  /** Auto-played chunks. Omit (or []) to drive the stream by hand with the handle's emit()/finish() or fake.emit(). */
  chunks?: (string | ChunkSpec)[];
  /** Sent when the content is done (default "stop"). Ignored when chunks is omitted: a manual stream ends on finish(). */
  finish?: FinishKind;
  /** Anthropic only, for finish "refusal": present vs absent (not empty) is what G7 distinguishes. */
  stopDetails?: StopDetailsSpec;
  usage?: UsageSpec;
  model?: string;
}

export interface CompleteScript {
  /** Omit or `""` for the empty-response case. */
  text?: string;
  delayMs?: number;
  finish?: FinishKind;
  stopDetails?: StopDetailsSpec;
  usage?: UsageSpec;
  model?: string;
}

export interface ErrorScript {
  status: number;
  /** Defaults to a wire-appropriate `{error:{message,type}}` (OpenAI) /
   * `{type:"error",error:{type,message}}` (Anthropic) shape naming `status` if omitted. */
  body?: unknown;
  delayMs?: number;
  /**
   * Sets x-should-retry. Defaults to false: otherwise the SDKs retry a scripted 500 up to twice, turning one error into
   * three requests.
   */
  retryable?: boolean;
}

/** One scripted response. Queue with queueStream/queueComplete/queueError so the kind shows at the call site. */
export type Script = StreamScript | CompleteScript | ErrorScript;

export interface CapturedRequest {
  format: WireFormat;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Parsed request JSON, for checking system-prompt placement (G9) and what was actually sent. */
  body: any;
  /** The resolved system-prompt text per format, or null. Convenience: body has the raw shape. */
  system: string | null;
  receivedAt: number;
  /**
   * True once the client socket closed before the response finished. C10 asserts on it: the row can be right while the
   * upstream call keeps running.
   */
  aborted: boolean;
}

export interface StreamHandle {
  /** Resolves once a real request has matched this queue slot and this fake's own response
   * headers have gone out. */
  connected: Promise<CapturedRequest>;
  /**
   * Sends one more delta at the caller's exact chunk boundary, so a marker can be split mid-way. Waits for `connected`,
   * then delayMs.
   */
  emit(text: string, delayMs?: number): Promise<void>;
  /** Ends the stream with the given (or scripted) finish reason. Safe to call more than
   * once — later calls are no-ops. */
  finish(opts?: { finish?: FinishKind; stopDetails?: StopDetailsSpec; usage?: UsageSpec }): Promise<void>;
  /** Resolves once the response has been fully written and ended (by auto-play finishing,
   * or by an explicit `finish()` call). */
  done: Promise<void>;
}

export interface CompleteHandle {
  connected: Promise<CapturedRequest>;
  done: Promise<void>;
}

export interface FakeProvider {
  /** Bare API prefix for OPENAI_BASE_URL / ANTHROPIC_BASE_URL (or LLM_<ROLE>_*); each SDK appends its own path. */
  baseUrl: string;
  requestCount(): number;
  /** Every request received so far, matched or not, in arrival order. Returns a fresh copy
   * each call. */
  requests(): CapturedRequest[];
  queueStream(script?: StreamScript): StreamHandle;
  queueComplete(script?: CompleteScript): CompleteHandle;
  queueError(script: ErrorScript): CompleteHandle;
  /** Sugar for the newest open stream handle's emit(); throws if none. Prefer the handle when juggling several streams. */
  emit(text: string, delayMs?: number): Promise<void>;
  /** Destroys every open connection, ends any still-open streams, and closes the server.
   * Safe to call once; awaiting it more than once resolves immediately. */
  close(): Promise<void>;
}


interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type QueueEntry =
  | {
      kind: "stream";
      script: StreamScript;
      resolveConnected: (r: CapturedRequest) => void;
      rejectConnected: (e: unknown) => void;
      /** The real handle, resolved when the matching request lands (queueStream returns a proxy before that). */
      handleReady: Deferred<StreamHandle>;
    }
  | {
      kind: "complete";
      script: CompleteScript;
      resolveConnected: (r: CapturedRequest) => void;
      rejectConnected: (e: unknown) => void;
      doneReady: Deferred<void>;
    }
  | {
      kind: "error";
      script: ErrorScript;
      resolveConnected: (r: CapturedRequest) => void;
      rejectConnected: (e: unknown) => void;
      doneReady: Deferred<void>;
    };

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeChunks(chunks: (string | ChunkSpec)[] | undefined): ChunkSpec[] {
  return (chunks ?? []).map((c) => (typeof c === "string" ? { text: c } : c));
}

function readHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractSystem(format: WireFormat, body: any): string | null {
  if (format === "openai") {
    const msg = Array.isArray(body?.messages)
      ? body.messages.find((m: any) => m?.role === "system")
      : undefined;
    return typeof msg?.content === "string" ? msg.content : null;
  }
  // Anthropic: `system` is either a plain string or an array of `{type:"text", text}` blocks.
  const system = body?.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const text = system
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n\n");
    return text || null;
  }
  return null;
}


function sseFrame(event: string | null, data: unknown): string {
  const json = JSON.stringify(data);
  return (event ? `event: ${event}\n` : "") + `data: ${json}\n\n`;
}

function openaiFinishReason(finish: FinishKind): "stop" | "content_filter" | "length" {
  if (finish === "refusal") {
    throw new Error(
      'fake-provider: finish "refusal" is not a valid OpenAI finish_reason — use "content_filter" ' +
        "for the OpenAI refusal shape, or queue this response on the Anthropic format.",
    );
  }
  return finish;
}

function openaiUsage(usage: UsageSpec | undefined, completionTextLength: number) {
  const promptTokens = usage?.promptTokens ?? 120;
  const completionTokens = usage?.completionTokens ?? Math.max(1, Math.ceil(completionTextLength / 4));
  const out: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  if (usage?.cacheReadTokens !== undefined) {
    out.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens };
  }
  if (usage?.cacheWriteTokens !== undefined) {
    out.prompt_tokens_details = {
      ...(out.prompt_tokens_details as object | undefined),
      cache_write_tokens: usage.cacheWriteTokens,
    };
  }
  return out;
}

function openaiChunkFrame(id: string, model: string, contentDelta: string | null, finishReason: string | null): string {
  return sseFrame(null, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: contentDelta !== null ? { content: contentDelta } : {}, finish_reason: finishReason }],
  });
}

function openaiUsageFrame(id: string, model: string, usage: unknown): string {
  return sseFrame(null, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  });
}

const OPENAI_DONE_FRAME = "data: [DONE]\n\n";

function openaiCompletionBody(id: string, model: string, text: string, finish: FinishKind, usage: UsageSpec | undefined) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text || null },
        finish_reason: openaiFinishReason(finish),
      },
    ],
    usage: openaiUsage(usage, text.length),
  };
}

function openaiErrorBody(status: number, body: unknown) {
  if (body !== undefined) return body;
  return { error: { message: `fake-provider: HTTP ${status}`, type: "fake_provider_error", param: null, code: null } };
}


function anthropicStopReason(finish: FinishKind): "end_turn" | "refusal" | "max_tokens" {
  if (finish === "content_filter") {
    throw new Error(
      'fake-provider: finish "content_filter" is not a valid Anthropic stop_reason — use ' +
        '"refusal", or queue this response on the OpenAI format.',
    );
  }
  if (finish === "length") return "max_tokens";
  return finish === "stop" ? "end_turn" : "refusal";
}

function anthropicUsage(usage: UsageSpec | undefined, completionTextLength: number) {
  const out: Record<string, unknown> = {
    input_tokens: usage?.promptTokens ?? 120,
    output_tokens: usage?.completionTokens ?? Math.max(1, Math.ceil(completionTextLength / 4)),
  };
  if (usage?.cacheReadTokens !== undefined) out.cache_read_input_tokens = usage.cacheReadTokens;
  if (usage?.cacheWriteTokens !== undefined) out.cache_creation_input_tokens = usage.cacheWriteTokens;
  return out;
}

function anthropicCompletionBody(
  id: string,
  model: string,
  text: string,
  finish: FinishKind,
  stopDetails: StopDetailsSpec | undefined,
  usage: UsageSpec | undefined,
) {
  const stopReason = anthropicStopReason(finish);
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    // Key presence, not merely value, is what "with vs. without stop_details" (G7) tests —
    // omit the key entirely rather than sending `null` when the caller didn't pass one.
    ...(stopReason === "refusal" && stopDetails !== undefined ? { stop_details: stopDetails } : {}),
    usage: anthropicUsage(usage, text.length),
  };
}

function anthropicErrorBody(status: number, body: unknown) {
  if (body !== undefined) return body;
  return { type: "error", error: { type: "fake_provider_error", message: `fake-provider: HTTP ${status}` } };
}


export async function startFakeProvider(): Promise<FakeProvider> {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const queue: QueueEntry[] = [];
  const requests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  let lastStreamHandle: StreamHandle | null = null;
  /** Force-enders for every stream currently held open, so `close()` can unblock any test
   * still awaiting a handle's `done` promise instead of hanging the process. */
  const openStreamEnders = new Set<() => void>();

  /** Tells a clean finish from a premature disconnect (res.on("close") fires for both) without patching the response. */
  const finishedFlags = new WeakMap<ServerResponse, { finished: boolean }>();

  function trackAbort(res: ServerResponse, captured: CapturedRequest): void {
    const state = { finished: false };
    finishedFlags.set(res, state);
    res.on("close", () => {
      if (!state.finished) captured.aborted = true;
    });
    res.on("error", () => {
      // A write after the client disconnected surfaces here (ECONNRESET) — already
      // recorded via the "close" handler above; nothing more to do.
    });
  }

  function markFinished(res: ServerResponse): void {
    const state = finishedFlags.get(res);
    if (state) state.finished = true;
  }

  function safeWrite(res: ServerResponse, chunk: string): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch {
      // Client gone — already reflected in the captured request's `aborted` flag.
    }
  }

  function safeEnd(res: ServerResponse): void {
    markFinished(res);
    if (res.writableEnded || res.destroyed) return;
    try {
      res.end();
    } catch {
      // Client gone.
    }
  }

  async function respondError(res: ServerResponse, format: WireFormat, script: ErrorScript): Promise<void> {
    if (script.delayMs) await sleep(script.delayMs);
    const body = format === "openai" ? openaiErrorBody(script.status, script.body) : anthropicErrorBody(script.status, script.body);
    res.writeHead(script.status, {
      "Content-Type": "application/json",
      Connection: "close",
      "x-should-retry": script.retryable ? "true" : "false",
    });
    safeWrite(res, JSON.stringify(body));
    safeEnd(res);
  }

  async function respondComplete(
    res: ServerResponse,
    format: WireFormat,
    reqModel: string,
    script: CompleteScript,
  ): Promise<void> {
    if (script.delayMs) await sleep(script.delayMs);
    const id = format === "openai" ? `chatcmpl-fake-${randomUUID()}` : `msg_fake_${randomUUID()}`;
    const model = script.model ?? reqModel ?? "fake-model";
    const text = script.text ?? "";
    const finish = script.finish ?? "stop";
    const body =
      format === "openai"
        ? openaiCompletionBody(id, model, text, finish, script.usage)
        : anthropicCompletionBody(id, model, text, finish, script.stopDetails, script.usage);
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    safeWrite(res, JSON.stringify(body));
    safeEnd(res);
  }

  function makeStreamHandle(
    res: ServerResponse,
    format: WireFormat,
    reqModel: string,
    connectedPromise: Promise<CapturedRequest>,
    script: StreamScript,
  ): StreamHandle {
    const id = format === "openai" ? `chatcmpl-fake-${randomUUID()}` : `msg_fake_${randomUUID()}`;
    const model = script.model ?? reqModel ?? "fake-model";
    let opened = false; // whether the (single, text) content block has been started — Anthropic only
    let finished = false;
    let totalTextLength = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    // message_start is mandatory and must come first, even for a zero-content response, or the real SDK rejects the stream.
    if (format === "anthropic") {
      safeWrite(
        res,
        sseFrame("message_start", {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 120, output_tokens: 0 },
          },
        }),
      );
    }

    function openIfNeeded(): void {
      if (format !== "anthropic" || opened) return;
      opened = true;
      safeWrite(
        res,
        sseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
    }

    async function emit(text: string, delayMs = 0): Promise<void> {
      await connectedPromise;
      if (finished) throw new Error("fake-provider: emit() called after finish()");
      if (delayMs) await sleep(delayMs);
      totalTextLength += text.length;
      if (format === "openai") {
        safeWrite(res, openaiChunkFrame(id, model, text, null));
      } else {
        openIfNeeded();
        safeWrite(
          res,
          sseFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          }),
        );
      }
    }

    async function finish(opts?: { finish?: FinishKind; stopDetails?: StopDetailsSpec; usage?: UsageSpec }): Promise<void> {
      await connectedPromise;
      if (finished) return;
      finished = true;
      openStreamEnders.delete(forceEnd);
      const finishKind = opts?.finish ?? script.finish ?? "stop";
      const usage = opts?.usage ?? script.usage;
      if (format === "openai") {
        safeWrite(res, openaiChunkFrame(id, model, null, openaiFinishReason(finishKind)));
        safeWrite(res, openaiUsageFrame(id, model, openaiUsage(usage, totalTextLength)));
        safeWrite(res, OPENAI_DONE_FRAME);
      } else {
        const stopReason = anthropicStopReason(finishKind);
        if (opened) {
          safeWrite(res, sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }));
        }
        const stopDetails = opts?.stopDetails ?? script.stopDetails;
        safeWrite(
          res,
          sseFrame("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: stopReason,
              stop_sequence: null,
              // Same key-presence rule as anthropicCompletionBody above.
              ...(stopReason === "refusal" && stopDetails !== undefined ? { stop_details: stopDetails } : {}),
            },
            usage: anthropicUsage(usage, totalTextLength),
          }),
        );
        safeWrite(res, sseFrame("message_stop", { type: "message_stop" }));
      }
      safeEnd(res);
      resolveDone();
    }

    function forceEnd(): void {
      if (finished) return;
      finished = true;
      safeEnd(res);
      resolveDone();
    }
    openStreamEnders.add(forceEnd);

    return { connected: connectedPromise, emit, finish, done };
  }

  async function handleStreamRequest(
    res: ServerResponse,
    format: WireFormat,
    reqModel: string,
    captured: CapturedRequest,
    entry: Extract<QueueEntry, { kind: "stream" }>,
  ): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "close",
    });
    (res as any).flushHeaders?.();
    entry.resolveConnected(captured);
    const handle = makeStreamHandle(res, format, reqModel, Promise.resolve(captured), entry.script);
    entry.handleReady.resolve(handle);

    const chunks = normalizeChunks(entry.script.chunks);
    if (entry.script.chunks !== undefined) {
      for (const chunk of chunks) {
        await handle.emit(chunk.text, chunk.delayMs);
      }
      await handle.finish();
    }
    // Manual mode (`chunks` omitted): leave the response open. The caller drives it via the
    // returned handle (or `fake.emit()`/`fake.finish()`-equivalent) and is responsible for
    // eventually calling `finish()` — `close()` force-ends anything still open at teardown.
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const format: WireFormat | null = url === "/chat/completions" ? "openai" : url === "/v1/messages" ? "anthropic" : null;

      if (!format) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "fake-provider: unknown path " + url }));
        return;
      }

      const rawBody = await readBody(req);
      let body: any = {};
      try {
        body = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "fake-provider: malformed JSON body" }));
        return;
      }

      const captured: CapturedRequest = {
        format,
        method: req.method ?? "POST",
        path: url,
        headers: readHeaders(req),
        body,
        system: extractSystem(format, body),
        receivedAt: Date.now(),
        aborted: false,
      };
      requests.push(captured);
      trackAbort(res, captured);

      const entry = queue.shift();
      const reqModel = typeof body.model === "string" ? body.model : "fake-model";
      const wantsStream = body.stream === true;

      if (!entry) {
        markFinished(res);
        res.writeHead(500, { "Content-Type": "application/json", "x-should-retry": "false" });
        res.end(
          JSON.stringify({
            error:
              "fake-provider: no scripted response was queued for this request (queue empty) — " +
              "call queueStream()/queueComplete()/queueError() before triggering the call that reaches this fake",
          }),
        );
        return;
      }

      if (entry.kind === "error") {
        entry.resolveConnected(captured);
        await respondError(res, format, entry.script);
        entry.doneReady.resolve();
        return;
      }

      if (entry.kind === "stream" && !wantsStream) {
        const err = new Error(
          `fake-provider: a streaming script was queued but the request had stream:false/absent (format=${format})`,
        );
        entry.rejectConnected(err);
        entry.handleReady.reject(err);
        markFinished(res);
        res.writeHead(500, { "Content-Type": "application/json", "x-should-retry": "false" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (entry.kind === "complete" && wantsStream) {
        const err = new Error(
          `fake-provider: a non-streaming script was queued but the request had stream:true (format=${format})`,
        );
        entry.rejectConnected(err);
        entry.doneReady.reject(err);
        markFinished(res);
        res.writeHead(500, { "Content-Type": "application/json", "x-should-retry": "false" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      if (entry.kind === "complete") {
        entry.resolveConnected(captured);
        await respondComplete(res, format, reqModel, entry.script);
        entry.doneReady.resolve();
        return;
      }

      await handleStreamRequest(res, format, reqModel, captured, entry);
    })().catch((error) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: `fake-provider: internal error: ${String(error)}` }));
      } catch {
        // Response already gone.
      }
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  function queueStream(script: StreamScript = {}): StreamHandle {
    const connectedD = deferred<CapturedRequest>();
    const handleD = deferred<StreamHandle>();
    queue.push({
      kind: "stream",
      script,
      resolveConnected: connectedD.resolve,
      rejectConnected: connectedD.reject,
      handleReady: handleD,
    });

    // Returned synchronously, before any response exists; every method waits for the real handle.
    const proxy: StreamHandle = {
      connected: connectedD.promise,
      emit: async (text, delayMs) => (await handleD.promise).emit(text, delayMs),
      finish: async (opts) => (await handleD.promise).finish(opts),
      done: handleD.promise.then((h) => h.done),
    };
    lastStreamHandle = proxy;
    return proxy;
  }

  function queueComplete(script: CompleteScript = {}): CompleteHandle {
    const connectedD = deferred<CapturedRequest>();
    const doneD = deferred<void>();
    queue.push({
      kind: "complete",
      script,
      resolveConnected: connectedD.resolve,
      rejectConnected: connectedD.reject,
      doneReady: doneD,
    });
    return { connected: connectedD.promise, done: doneD.promise };
  }

  function queueError(script: ErrorScript): CompleteHandle {
    const connectedD = deferred<CapturedRequest>();
    const doneD = deferred<void>();
    queue.push({
      kind: "error",
      script,
      resolveConnected: connectedD.resolve,
      rejectConnected: connectedD.reject,
      doneReady: doneD,
    });
    return { connected: connectedD.promise, done: doneD.promise };
  }

  return {
    baseUrl,
    requestCount: () => requests.length,
    requests: () => requests.slice(),
    queueStream,
    queueComplete,
    queueError,
    async emit(text, delayMs) {
      if (!lastStreamHandle) {
        throw new Error("fake-provider: emit() called with no stream queued — call queueStream() first");
      }
      await lastStreamHandle.emit(text, delayMs);
    },
    async close() {
      for (const end of [...openStreamEnders]) end();
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
