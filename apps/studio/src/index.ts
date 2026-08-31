import express from "express";
import {
  loadEnv,
  createGeneration,
  getGeneration,
  getFilledApp,
  listRecentGenerations,
  assertCredentialKeyConfigured,
} from "@any-app/store";
import { internalRouter } from "./internal";
import { editsRouter } from "./edits";
import { settingsRouter } from "./settings";
import { homePage, previewFrame, editForm } from "./views";
import { sessionId } from "./session";
import { missingCredentials } from "./credential-resolve";

loadEnv();
// A missing or malformed CREDENTIAL_KEY should fail the boot, not surface silently on the
// first credential save (or worse, on the first read of one saved by an older key).
assertCredentialKeyConfigured();

const app = express();
const port = Number(process.env.STUDIO_PORT ?? 3000);
const sandboxUrl = process.env.SANDBOX_PUBLIC_URL ?? "http://127.0.0.1:3001";
// Baked into every generated document's swap runtime, which checks it against
// `event.origin` on every postMessage edit. Must match exactly — see shell.ts. `event.origin`
// never carries a trailing slash, so a `STUDIO_PUBLIC_URL` with one (or any path/query) would
// make the check fail forever with nothing logged on either side — normalising through `URL`
// here means a misconfigured env var still resolves to a working origin.
const studioOrigin = new URL(process.env.STUDIO_PUBLIC_URL ?? "http://localhost:3000").origin;

app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "studio" });
});

app.get("/", async (req, res) => {
  const generations = await listRecentGenerations();
  const sid = sessionId(req, res);
  const missing = await missingCredentials(sid);
  res.type("html").send(homePage(generations, sandboxUrl, missing));
});

app.post("/generations", async (req, res) => {
  const prompt = String(req.body.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).type("html").send(`<p class="placeholder">A prompt is required.</p>`);
    return;
  }
  const generation = await createGeneration(prompt);
  res.type("html").send(previewFrame(generation.id, sandboxUrl));
});

app.get("/generations/:id/frame", async (req, res) => {
  const generation = await getGeneration(req.params.id);
  if (!generation) {
    res.status(404).type("html").send(`<p class="placeholder">Not found.</p>`);
    return;
  }
  // Only a complete, decomposed app can be edited — getFilledApp returns null for anything
  // still streaming, failed, or predating Phase 2's plan column.
  const loaded = await getFilledApp(generation.id);
  const form = loaded ? editForm(generation.id, loaded.filled.slots) : "";
  res.type("html").send(previewFrame(generation.id, sandboxUrl) + form);
});

app.use("/internal", internalRouter(studioOrigin));
app.use(editsRouter(studioOrigin));
app.use(settingsRouter());

app.listen(port, "localhost", () => {
  console.log(`studio listening on http://localhost:${port}`);
});
