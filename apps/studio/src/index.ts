import express from "express";
import {
  loadEnv,
  requireEnv,
  createGeneration,
  getGeneration,
  getFilledApp,
  listRecentGenerations,
  listMessages,
  setVisibility,
  deleteGeneration,
  forkGeneration,
  assertCredentialKeyConfigured,
} from "@any-app/store";
import type { Generation, Owner } from "@any-app/store";
import { mintViewGrant, VIEW_GRANT_TTL_MS, renderDocument, isFilledApp } from "@any-app/protocol";
import type { TokenMode } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import { internalRouter } from "./internal";
import { editsRouter } from "./edits";
import { settingsRouter } from "./settings";
import { authRouter } from "./auth";
import { homePage, previewFrame, oobSlot, chatLogOob, messageItems, editProblem, generationList, editForm, ownerControls, remixControl, sharedAppPage, notFoundPage } from "./views";
import { currentOwner } from "./session";
import { isEditing } from "./activity";
import { firstMessage, fullConversation, pendingText } from "./conversation";
import { missingCredentials } from "./credential-resolve";
import { renderFullHead, SHELL_TAIL } from "./shell";

loadEnv();
// A missing or malformed CREDENTIAL_KEY should fail the boot, not surface silently on the
// first credential save (or worse, on the first read of one saved by an older key).
assertCredentialKeyConfigured();
// A missing secret must fail the boot, not default to "" (every token would be forgeable).
requireEnv("APP_TOKEN_SECRET");

const app = express();
const port = Number(process.env.STUDIO_PORT ?? 3000);
// Baked into every document's swap runtime and compared with event.origin, which has no trailing slash:
// normalising through URL keeps a sloppy env var working.
const studioOrigin = new URL(process.env.STUDIO_PUBLIC_URL ?? "http://localhost:3000").origin;

const appOriginTemplate =
  process.env.SANDBOX_APP_ORIGIN_TEMPLATE ?? "http://{id}.apps.localhost:3001";

/** The origin one generated app is served from. Also the exact string `postMessage` pins. */
function appOrigin(id: string): string {
  return new URL(appOriginTemplate.replace("{id}", id)).origin;
}

function isOwner(generation: Generation, owner: Owner): boolean {
  return owner.kind === "user"
    ? generation.owner_id === owner.userId
    : generation.owner_id === null && generation.session_id === owner.sessionId;
}

function mayView(generation: Generation, owner: Owner): boolean {
  if (generation.visibility !== "private") return true;
  return isOwner(generation, owner);
}

app.use(express.urlencoded({ extended: false }));

// Rejects mutating requests with a positive cross-site signal (Sec-Fetch-Site or Origin). SameSite alone does
// not stop a generated app's fetch() on a same-site deployment. Non-browser callers send neither header and
// are not the threat.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  const site = req.get("sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    res.status(403).type("html").send(`<p class="problem">Cross-origin request refused.</p>`);
    return;
  }
  const origin = req.get("origin");
  if (origin !== undefined && origin !== studioOrigin) {
    res.status(403).type("html").send(`<p class="problem">Cross-origin request refused.</p>`);
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "studio" });
});

app.get("/", async (req, res) => {
  const owner = await currentOwner(req, res);
  const generations = await listRecentGenerations(owner);
  const missing = await missingCredentials(owner);
  res.type("html").send(homePage(generations, missing, owner));
});

// The sidebar's live refresh: the list fragment, owner-scoped, never cached.
app.get("/generations", async (req, res) => {
  const owner = await currentOwner(req, res);
  const generations = await listRecentGenerations(owner);
  res.set("Cache-Control", "no-store").type("html").send(generationList(generations));
});

app.post("/generations", async (req, res) => {
  const owner = await currentOwner(req, res);
  const prompt = String(req.body.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).type("html").send(`<p class="placeholder">A prompt is required.</p>`);
    return;
  }
  const generation = await createGeneration(prompt, owner);
  const grant = mintViewGrant(generation.id, "rw", Date.now() + VIEW_GRANT_TTL_MS, requireEnv("APP_TOKEN_SECRET"));
  // The composer/owner slots live outside #stage, so a new (still streaming) app has to clear
  // the previous app's edit form and owner controls out-of-band — see oobSlot.
  res
    .type("html")
    .send(
      previewFrame(generation.id, appOrigin(generation.id), grant, true) +
        oobSlot("edit-slot", "") +
        oobSlot("owner-slot", "") +
        chatLogOob(generation.id, messageItems([firstMessage(generation)], pendingText(generation))),
    );
});

// Messages after `after`, plus the transient working row. Owner-only (404 otherwise). The prompt (message zero)
// is rendered by frame/create, so it is never repeated here.
app.get("/generations/:id/messages", async (req, res) => {
  const owner = await currentOwner(req, res);
  const generation = await getGeneration(req.params.id);
  if (!generation || !isOwner(generation, owner)) {
    res.status(404).type("html").send("");
    return;
  }
  const after = Math.max(0, Math.floor(Number(req.query.after ?? 0)) || 0);
  const rows = await listMessages(generation.id, after);
  res.set("Cache-Control", "no-store").type("html").send(messageItems(rows, pendingText(generation)));
});

app.get("/generations/:id/frame", async (req, res) => {
  const owner = await currentOwner(req, res);
  // Unscoped lookup plus mayView: a shared app must render for a non-owner. 404 is the only signal, never a 403,
  // so a private app is indistinguishable from a missing one.
  const generation = await getGeneration(req.params.id);
  if (!generation || !mayView(generation, owner)) {
    res.status(404).type("html").send(`<p class="placeholder">Not found.</p>`);
    return;
  }

  const mode: TokenMode = isOwner(generation, owner) ? "rw" : "ro";
  const grant = mintViewGrant(generation.id, mode, Date.now() + VIEW_GRANT_TTL_MS, requireEnv("APP_TOKEN_SECRET"));

  // Only a complete, decomposed app can be edited.
  const loaded = mode === "rw" ? await getFilledApp(generation.id, owner) : null;
  const editFormHtml = loaded ? editForm(generation.id, loaded.filled.slots) : "";
  // The standalone share page: the frame route's fragment is unusable on its own.
  const shareUrl = `${studioOrigin}/apps/${generation.id}`;
  const ownerHtml = mode === "rw" ? ownerControls(generation.id, generation.visibility, shareUrl) : remixControl(generation.id);

  const chatHtml =
    mode === "rw"
      ? chatLogOob(generation.id, messageItems(await fullConversation(generation), pendingText(generation)))
      : chatLogOob("", "");
  res
    .type("html")
    .send(
      // A pending row starts generating when its frame loads; any other status is served at once.
      previewFrame(generation.id, appOrigin(generation.id), grant, generation.status === "pending") +
        oobSlot("edit-slot", editFormHtml) +
        oobSlot("owner-slot", ownerHtml) +
        chatHtml,
    );
});

// What a shared link opens. A separate route keeps the frame route a plain fragment for htmx.
app.get("/apps/:id", async (req, res) => {
  const owner = await currentOwner(req, res);
  const generation = await getGeneration(req.params.id);
  if (!generation || !mayView(generation, owner)) {
    res.status(404).type("html").send(notFoundPage());
    return;
  }
  const mode: TokenMode = isOwner(generation, owner) ? "rw" : "ro";
  const grant = mintViewGrant(generation.id, mode, Date.now() + VIEW_GRANT_TTL_MS, requireEnv("APP_TOKEN_SECRET"));
  const title = isFilledApp(generation.plan) ? generation.plan.title : generation.prompt.slice(0, 80);
  res.type("html").send(sharedAppPage(generation.id, title, appOrigin(generation.id), grant, mode));
});

app.post("/generations/:id/visibility", async (req, res) => {
  const owner = await currentOwner(req, res);
  const visibility = String(req.body.visibility ?? "");
  if (visibility !== "private" && visibility !== "unlisted" && visibility !== "public") {
    res.status(400).type("html").send(`<p class="problem">Unknown visibility.</p>`);
    return;
  }
  const ok = await setVisibility(req.params.id, owner, visibility);
  if (!ok) {
    res.status(404).type("html").send(`<p class="problem">Not found.</p>`);
    return;
  }
  res.type("html").send(`<p class="edit-ok">Set to ${visibility}.</p>`);
});

// Owner-only (404 for others). A 200 empty body makes the page remove the row; problems show as the toast.
app.delete("/generations/:id", async (req, res) => {
  const owner = await currentOwner(req, res);
  const result = await deleteGeneration(req.params.id, owner, isEditing);
  if (result === "missing") {
    res.status(404).type("html").send(editProblem("That app no longer exists."));
    return;
  }
  if (result === "busy") {
    res.status(409).type("html").send(editProblem("Still generating or updating — delete it once that finishes."));
    return;
  }
  res.status(200).type("html").send("");
});

app.post("/generations/:id/fork", async (req, res) => {
  const owner = await currentOwner(req, res);
  // Unscoped + mayView, exactly like the frame route: forking a shared app you don't own
  // must work, forking a private one you don't own must 404 like it doesn't exist.
  const source = await getGeneration(req.params.id);
  if (!source || !mayView(source, owner)) {
    res.status(404).type("html").send(`<p class="placeholder">Not found.</p>`);
    return;
  }
  // isFilledApp, not plan !== null: forkGeneration casts the plan, so anything weaker turns a 409 into a 500.
  if (source.status !== "complete" || !isFilledApp(source.plan)) {
    res.status(409).type("html").send(`<p class="problem">This app cannot be remixed yet.</p>`);
    return;
  }

  const fork = await forkGeneration(source, owner, (filled) =>
    renderDocument(filled, (p) => renderFullHead(p, studioOrigin), SHELL_TAIL),
  );
  res.setHeader("HX-Redirect", `/generations/${fork.id}/frame`);
  res.status(200).end();
});

app.use(authRouter());
app.use("/internal", internalRouter(studioOrigin));
app.use(editsRouter(studioOrigin, appOrigin));
app.use(settingsRouter());

app.listen(port, "localhost", () => {
  console.log(`studio listening on http://localhost:${port}`);
});
