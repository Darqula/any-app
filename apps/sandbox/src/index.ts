import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadEnv } from "@any-app/records";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";
import { dataRouter } from "./data";

// Phase 5 review S1: this used to be `@any-app/store`'s loadEnv. Importing even one named
// export off @any-app/store pulls in that package's whole module graph — including a
// privileged Postgres pool built at module scope from DATABASE_URL, plus getCredential/
// saveCredential. The sandbox must depend on nothing that can reach a table besides
// `records`; @any-app/records carries its own loadEnv (packages/records/src/db.ts) for
// exactly this reason, so the sandbox no longer needs @any-app/store at all.
loadEnv();

const app = express();
// Express 5 defaults this to "simple" (Node's querystring), which has no bracket-notation
// support — `where[finished]=true` would parse as a flat key literally named
// "where[finished]", req.query.where would be undefined, and the data API's `where` filter
// would silently match everything. "extended" (qs) is what data.ts's parseWhere assumes.
// Confirmed live during Phase 5 verification: without this line, every list request that
// filters on a field returns every row instead.
app.set("query parser", "extended");
const port = Number(process.env.SANDBOX_PORT ?? 3001);
const studioUrl = process.env.STUDIO_INTERNAL_URL ?? "http://localhost:3000";
const internalSecret = process.env.INTERNAL_SECRET ?? "";
// A plain numeric timeout, not a provider credential — reading it here does not violate
// the sandbox's "no generator dependency, no credential" rule. Bounds a genuine runaway
// generation; studio's own heartbeat (internal.ts) is what stops undici's ~300s
// inactivity timeout from firing during a merely slow one.
const previewTimeoutMs = Number(process.env.PREVIEW_TIMEOUT_MS ?? 900_000);

// Signs/verifies per-app data-API tokens (studio mints, sandbox verifies — same secret,
// same .env). A missing value must fail the boot, not silently default to "", which would
// make every app's token forgeable by anyone who reads this file. Plain env vars, not
// provider credentials — reading them here does not violate the sandbox's "no generator
// dependency, no credential" rule.
const appTokenSecret = process.env.APP_TOKEN_SECRET;
if (!appTokenSecret) {
  throw new Error("Missing required environment variable: APP_TOKEN_SECRET");
}
const appOriginTemplate =
  process.env.SANDBOX_APP_ORIGIN_TEMPLATE ?? "http://{id}.apps.localhost:3001";

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sandbox" });
});

// Mounted before /preview/:id, on the app's own origin (Phase 5) rather than the shared
// sandbox origin — same-origin by construction, so no CORS header is ever needed or added.
app.use("/data", dataRouter(appTokenSecret, appOriginTemplate));

app.get("/preview/:id", async (req, res) => {
  // Abort the upstream call the moment the viewer's connection closes, so a closed tab
  // stops a generation instead of leaving it running to completion for no one.
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  // The Phase 6 view grant (packages/protocol/src/view-grant.ts). Forwarded blind — this
  // process never inspects or verifies it, only studio's internal route does (see
  // architecture.md decision #10 and internal.ts). Sandbox learns nothing new about the
  // viewer beyond "pass this opaque string along."
  const grant = typeof req.query.g === "string" ? req.query.g : "";
  const upstream = await fetch(
    `${studioUrl}/internal/generations/${encodeURIComponent(req.params.id)}/stream` +
      (grant ? `?g=${encodeURIComponent(grant)}` : ""),
    {
      headers: { [INTERNAL_SECRET_HEADER]: internalSecret },
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(previewTimeoutMs)]),
    },
  );

  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status).type("html").send("<p>Preview unavailable.</p>");
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // The grant travels in this URL. Generated apps load libraries from a CDN, and without
  // this the browser would send `Referer: http://<id>.apps.localhost:3001/preview/<id>?g=...`
  // to a third party on every one of those requests (Phase 6 step 4).
  res.setHeader("Referrer-Policy", "no-referrer");
  res.flushHeaders();

  // Node's fetch gives a web ReadableStream; Readable.fromWeb bridges it to a Node stream.
  await pipeline(Readable.fromWeb(upstream.body), res).catch((error) => {
    console.error(`preview ${req.params.id} pipe failed:`, error);
    res.end();
  });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`sandbox listening on http://127.0.0.1:${port}`);
});
