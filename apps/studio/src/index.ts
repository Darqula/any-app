import express from "express";
import { loadEnv, createGeneration, getGeneration, listRecentGenerations } from "@any-app/store";
import { internalRouter } from "./internal";
import { homePage, previewFrame } from "./views";

loadEnv();

const app = express();
const port = Number(process.env.STUDIO_PORT ?? 3000);
const sandboxUrl = process.env.SANDBOX_PUBLIC_URL ?? "http://127.0.0.1:3001";

app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "studio" });
});

app.get("/", async (_req, res) => {
  const generations = await listRecentGenerations();
  res.type("html").send(homePage(generations, sandboxUrl));
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
  res.type("html").send(previewFrame(generation.id, sandboxUrl));
});

app.use("/internal", internalRouter);

app.listen(port, "localhost", () => {
  console.log(`studio listening on http://localhost:${port}`);
});
