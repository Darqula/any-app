import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadEnv } from "@any-app/records";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";
import { dataRouter } from "./data";

// From @any-app/records, not @any-app/store: importing the store pulls in its privileged pool and credential code.
loadEnv();

const app = express();
// Required: Express 5's default parser has no bracket notation, so where[k]=v would silently match every row.
app.set("query parser", "extended");
const port = Number(process.env.SANDBOX_PORT ?? 3001);
const studioUrl = process.env.STUDIO_INTERNAL_URL ?? "http://localhost:3000";
const internalSecret = process.env.INTERNAL_SECRET ?? "";
// A plain number, not a credential. Bounds a runaway generation; studio's heartbeat covers a slow one.
const previewTimeoutMs = Number(process.env.PREVIEW_TIMEOUT_MS ?? 900_000);

// Must fail the boot when missing: an empty secret would make every app token forgeable.
const appTokenSecret = process.env.APP_TOKEN_SECRET;
if (!appTokenSecret) {
  throw new Error("Missing required environment variable: APP_TOKEN_SECRET");
}
const appOriginTemplate =
  process.env.SANDBOX_APP_ORIGIN_TEMPLATE ?? "http://{id}.apps.localhost:3001";

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sandbox" });
});

// Mounted on the app's own origin, so it is same-origin and needs no CORS header.
app.use("/data", dataRouter(appTokenSecret, appOriginTemplate));

app.get("/preview/:id", async (req, res) => {
  // Abort the upstream call the moment the viewer's connection closes, so a closed tab
  // stops a generation instead of leaving it running to completion for no one.
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  // The view grant, forwarded blind: only studio's internal route verifies it.
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
  // The grant is in this URL; keep it out of the Referer sent to CDNs the generated app loads.
  res.setHeader("Referrer-Policy", "no-referrer");
  res.flushHeaders();

  await pipeline(Readable.fromWeb(upstream.body), res).catch((error) => {
    console.error(`preview ${req.params.id} pipe failed:`, error);
    res.end();
  });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`sandbox listening on http://127.0.0.1:${port}`);
});
