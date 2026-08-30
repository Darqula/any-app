import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadEnv } from "@any-app/store";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";

loadEnv();

const app = express();
const port = Number(process.env.SANDBOX_PORT ?? 3001);
const studioUrl = process.env.STUDIO_INTERNAL_URL ?? "http://localhost:3000";
const internalSecret = process.env.INTERNAL_SECRET ?? "";

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "sandbox" });
});

app.get("/preview/:id", async (req, res) => {
  // Abort the upstream call the moment the viewer's connection closes, so a closed tab
  // stops a generation instead of leaving it running to completion for no one.
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const upstream = await fetch(
    `${studioUrl}/internal/generations/${encodeURIComponent(req.params.id)}/stream`,
    { headers: { [INTERNAL_SECRET_HEADER]: internalSecret }, signal: ac.signal },
  );

  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status).type("html").send("<p>Preview unavailable.</p>");
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
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
