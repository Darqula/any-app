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
 * The whole query surface: top-level equality (ANDed), limit, opaque cursor. Nothing wider, since anything more
 * is an unindexed scan. Arrays and nested objects under `where` are dropped.
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

// Query strings are text; coerce true/false/numbers so filters match stored jsonb values (containment is type-sensitive).
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
 * The data API, mounted at /data. Every route is scoped by appId from the verified token, never from the URL,
 * host or body.
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

    // Defence in depth, not authorisation: appId already decided scope.
    const expectedHost = new URL(appOriginTemplate.replace("{id}", appId)).host;
    if (req.headers.host !== expectedHost) {
      console.warn(`data: token for ${appId} presented on host ${req.headers.host}`);
      res.status(403).json({ error: "token does not match this app's origin" });
      return;
    }

    // A shared viewer's token is read-only: a public app's data must not also be world-writable.
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

  // Validated once per param. A bad :collection is a 400; a bad :id is a 404, so it looks like one that never
  // existed (a malformed uuid would otherwise fail inside Postgres).
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
      // Zero rows back is ambiguous: missing (404) or the merge would exceed MAX_RECORD_BYTES (413).
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

  // Terminal handler, so Express's default never writes a stack trace into the response (NODE_ENV is unset here).
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error("data API error:", err);
    // A 4xx describes the request and is passed through (e.g. 413); a 5xx stays opaque.
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
