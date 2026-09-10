import { Router } from "express";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { verifyAppToken } from "@any-app/protocol";
import {
  COLLECTION_PATTERN,
  UUID_PATTERN,
  createRecord,
  listRecords,
  getRecord,
  updateRecord,
  replaceRecord,
  deleteRecord,
  encodeCursor,
  decodeCursor,
  checkRate,
  MAX_RECORD_BYTES,
} from "@any-app/records";

/**
 * The entire query surface: equality on a top-level key (repeatable, ANDed), `limit`, and an
 * opaque `cursor`. No `$or`, no ranges, no regex, no nested paths, no sort key — every one of
 * those is a reasonable thing to want and every one of them is an unindexed scan the moment a
 * model writes it. See .docs/impl-phase-5.md step 5: the API is deliberately exactly as wide
 * as `records_data_idx` (a jsonb_path_ops GIN index) can serve.
 *
 * `where[key]=value` arrives, via express's query parser, as `req.query.where` being an
 * object of string values — anything that arrives as an array or nested object under `where`
 * (e.g. `where[a][b]=1` or a repeated `where[a]=1&where[a]=2`) is dropped rather than
 * threaded through, which is what keeps this a flat equality filter and nothing richer.
 */
function parseWhere(query: unknown): Record<string, string | number | boolean> {
  const raw = (query as Record<string, unknown> | undefined) ?? {};
  const where: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    where[key] = coerceWhereValue(value);
  }
  return where;
}

// `where[done]=true` arrives as the string "true", which does not match the stored boolean
// `true` under jsonb containment (`@>` is type-sensitive). Coerce the obvious cases here so
// a filter that looks right to whoever wrote it actually matches. See
// .docs/impl-phase-5.md's troubleshooting section.
function coerceWhereValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 25;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The data API, mounted at `/data` on the sandbox origin. Every route is scoped by `appId`
 * from `res.locals`, set by the auth middleware below from the verified token — never from
 * the URL, the host, or the request body. See .docs/architecture.md's data-API rules.
 */
export function dataRouter(secret: string, appOriginTemplate: string): Router {
  const router = Router();

  // 64KB is a generous row and a stingy request. The limit is on the parser, before any
  // JSON is built, so an oversized body costs no memory beyond the socket.
  router.use(express.json({ limit: `${MAX_RECORD_BYTES}b` }));

  router.use((req, res, next) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const verified = verifyAppToken(token, secret);
    if (!verified) {
      res.status(401).json({ error: "invalid or missing app token" });
      return;
    }
    const { appId, mode } = verified;

    // Defence in depth, not the authorization check. `appId` above already decided scope;
    // this only catches an app calling with a token that is not its own, which should be
    // impossible now that origins are per-app and would mean something upstream is broken.
    const expectedHost = new URL(appOriginTemplate.replace("{id}", appId)).host;
    if (req.headers.host !== expectedHost) {
      console.warn(`data: token for ${appId} presented on host ${req.headers.host}`);
      res.status(403).json({ error: "token does not match this app's origin" });
      return;
    }

    // A shared (non-owner) viewer's token is read-only (Phase 6 step 7) — a public app's data
    // is world-readable via its own link, and that must not also mean world-writable. `app_id`
    // still comes from the token and from nothing else; this only narrows what the verified
    // token may do.
    const isWrite = req.method !== "GET";
    if (mode === "ro" && isWrite) {
      res.status(403).json({ error: "this token is read-only" });
      return;
    }

    if (!checkRate(appId, isWrite ? "write" : "read")) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }

    res.locals.appId = appId;
    res.locals.mode = mode;
    next();
  });

  // Validated once per param, not once per route (Phase 5 review S2 folded the previous
  // five copies of the collection check into this). `:collection` fails 400 — it's a name
  // the caller chose and got wrong. `:id` fails 404, not 400 or a raw DB error — a malformed
  // id and an id that's simply never existed should look identical from the outside; both
  // used to reach `where ... and id = $3` against a uuid column unvalidated, which failed as
  // a Postgres `invalid input syntax for type uuid` error instead (see the error handler
  // below for why that no longer becomes a stack trace in the response either).
  router.param("collection", (req, res, next, collection: string) => {
    if (!COLLECTION_PATTERN.test(collection)) {
      res.status(400).json({ error: "invalid collection name" });
      return;
    }
    next();
  });
  router.param("id", (req, res, next, id: string) => {
    if (!UUID_PATTERN.test(id)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    next();
  });

  router.post("/:collection", async (req, res) => {
    const { collection } = req.params;
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: "body must be a JSON object" });
      return;
    }
    const record = await createRecord(res.locals.appId, collection, req.body);
    if (!record) {
      res.status(409).json({ error: "this app has reached its record quota" });
      return;
    }
    res.status(201).json(record);
  });

  router.get("/:collection", async (req, res) => {
    const { collection } = req.params;

    let before: { createdAt: string; id: string } | undefined;
    if (typeof req.query.cursor === "string" && req.query.cursor) {
      const decoded = decodeCursor(req.query.cursor);
      if (!decoded) {
        res.status(400).json({ error: "invalid cursor" });
        return;
      }
      before = decoded;
    }

    const limit = parseLimit(req.query.limit);
    const where = parseWhere(req.query.where);
    const records = await listRecords(res.locals.appId, collection, where, limit, before);
    const last = records[records.length - 1];
    // Fewer rows than asked for means this is the last page — nextCursor stays null rather
    // than pointing at a page that would come back empty.
    const nextCursor = records.length === limit && last ? encodeCursor(last) : null;
    res.status(200).json({ records, nextCursor });
  });

  router.get("/:collection/:id", async (req, res) => {
    const { collection, id } = req.params;
    const record = await getRecord(res.locals.appId, collection, id);
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json(record);
  });

  router.patch("/:collection/:id", async (req, res) => {
    const { collection, id } = req.params;
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: "body must be a JSON object" });
      return;
    }
    const record = await updateRecord(res.locals.appId, collection, id, req.body);
    if (!record) {
      // Zero rows back is ambiguous by design (see updateRecord's doc comment) — a cheap
      // existence check is what turns it into the right status: the record was never there
      // (404), or it was, and merging in this patch would have pushed it over
      // MAX_RECORD_BYTES (413). Each PATCH body is already capped at that same size by
      // express.json (see MAX_RECORD_BYTES above), but the merge is cumulative — that limit
      // bounds one request, not the row it lands on.
      const existing = await getRecord(res.locals.appId, collection, id);
      if (!existing) {
        res.status(404).json({ error: "not found" });
      } else {
        res.status(413).json({ error: "merged record would exceed the size limit" });
      }
      return;
    }
    res.status(200).json(record);
  });

  router.put("/:collection/:id", async (req, res) => {
    const { collection, id } = req.params;
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: "body must be a JSON object" });
      return;
    }
    const record = await replaceRecord(res.locals.appId, collection, id, req.body);
    if (!record) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json(record);
  });

  router.delete("/:collection/:id", async (req, res) => {
    const { collection, id } = req.params;
    const removed = await deleteRecord(res.locals.appId, collection, id);
    if (!removed) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(204).end();
  });

  // Terminal error handler (Phase 5 review S2). Express 5 forwards a rejected async route
  // handler's promise to error-handling middleware automatically; without one of our own,
  // that lands on Express's default handler, which writes a stack trace — absolute file
  // paths, internal frames — straight into the response body whenever NODE_ENV isn't
  // "production" (nothing in this repo sets it, so this project runs in that mode by
  // default). Recognized as error middleware by its arity (4 params), not its name.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error("data API error:", err);
    // A 4xx is a statement about the *request* (e.g. express.json's own
    // PayloadTooLargeError, .status === 413, when a body exceeds MAX_RECORD_BYTES) and is
    // safe to pass through as-is; only 5xx needs to stay opaque so nothing internal (a
    // stack trace, a driver error string) leaks into the response body. See
    // testing-review.md S2 — this used to collapse every forwarded error to 500, including
    // ones that already knew their own correct status.
    const status = (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : "bad request";
      res.status(status).json({ error: message });
      return;
    }
    res.status(500).json({ error: "internal error" });
  });

  return router;
}
