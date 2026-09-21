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
// Same reasoning: a missing APP_TOKEN_SECRET must not silently default to "", which would
// make every app's data-API token forgeable by anyone who reads this file. Both studio
// (which mints, here) and sandbox (which verifies, apps/sandbox/src/index.ts) require it.
requireEnv("APP_TOKEN_SECRET");

const app = express();
const port = Number(process.env.STUDIO_PORT ?? 3000);
// Baked into every generated document's swap runtime, which checks it against
// `event.origin` on every postMessage edit. Must match exactly — see shell.ts. `event.origin`
// never carries a trailing slash, so a `STUDIO_PUBLIC_URL` with one (or any path/query) would
// make the check fail forever with nothing logged on either side — normalising through `URL`
// here means a misconfigured env var still resolves to a working origin.
const studioOrigin = new URL(process.env.STUDIO_PUBLIC_URL ?? "http://localhost:3000").origin;

const appOriginTemplate =
  process.env.SANDBOX_APP_ORIGIN_TEMPLATE ?? "http://{id}.apps.localhost:3001";

/** The origin one generated app is served from. Also the exact string `postMessage` pins. */
function appOrigin(id: string): string {
  return new URL(appOriginTemplate.replace("{id}", id)).origin;
}

/** True when `owner` is exactly this generation's owner (a signed-in user's own row, or the
 *  anonymous session that created it). Used both to gate a private app and to decide whether
 *  the viewer gets the "rw" data-API mode (see mintViewGrant's doc comment). */
function isOwner(generation: Generation, owner: Owner): boolean {
  return owner.kind === "user"
    ? generation.owner_id === owner.userId
    : generation.owner_id === null && generation.session_id === owner.sessionId;
}

/** May this viewer see the app at all? Private apps are owner-only; unlisted/public apps are
 *  visible to anyone who has (or is given) the link. */
function mayView(generation: Generation, owner: Owner): boolean {
  if (generation.visibility !== "private") return true;
  return isOwner(generation, owner);
}

app.use(express.urlencoded({ extended: false }));

// SameSite alone (session.ts's COOKIE_ATTRS) does not keep a generated
// app's own fetch() calls from carrying this session's cookie back to the studio, in the
// real production deployment shape (studio on example.com, apps on
// <id>.apps.example.com — same registrable domain, so same-site). Without this, a
// model-written script running in ANY generated app — public, unlisted, or the current
// viewer's own — could POST to /settings/credentials with credentials:"include" and replace
// the viewer's stored provider key (and baseUrl) with an attacker-controlled endpoint, or
// spend their token cap, or publish/fork their apps.
//
// Rejects only a POSITIVE cross-site signal — `Sec-Fetch-Site` present and not
// same-origin/none, or `Origin` present and not this studio — rather than requiring one of
// them to be present at all. That is deliberate, not a loophole: `Sec-Fetch-Site` is a Fetch
// Metadata header every evergreen browser attaches to every fetch/XHR/form submission and a
// page's own JS cannot suppress it, and `Origin` has been sent on every cross-origin
// non-GET request since long before Fetch Metadata existed — so a REAL browser-driven attack
// (the threat this guard exists for) can never present with BOTH absent. Only a non-browser
// caller (curl, a server-to-server call, this project's own backend test suite) sends
// neither — and a non-browser caller was never sitting in the victim's browser with the
// victim's HttpOnly cookie to begin with, so there is nothing for it to forge here. This is
// also the one place `Origin` may be read at all, and only as an allowlist check against a
// known value, never reflected and never on a `/data/*` route — refusing on it is the safe
// direction the "never trust Origin" rule is about *granting* scope from, not about
// refusing on.
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

// The sidebar's live refresh (see homePage's script): the same fragment the page renders the
// list from, re-fetched so new apps and status changes show up without a reload. Owner-scoped
// by listRecentGenerations; no-store so a proxy or the browser never serves a stale list.
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
      previewFrame(generation.id, appOrigin(generation.id), grant) +
        oobSlot("edit-slot", "") +
        oobSlot("owner-slot", "") +
        chatLogOob(generation.id, messageItems([firstMessage(generation)], pendingText(generation))),
    );
});

// Incremental conversation for the bottom panel: only messages after `after` (the highest seq
// the page already has), plus the transient "working" row. Owner-only — the log is the owner's
// working history, not part of what a shared link exposes — and a 404 for anyone else, like
// every other owner-scoped route here. The first message (the prompt) is never included: the
// frame/create responses render it, and repeating it would duplicate it on every poll.
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
  // Unscoped lookup + an explicit `mayView` check, not `getGenerationForOwner` — a shared
  // (unlisted/public) app must render for a viewer who is not its owner. `mayView`/`404` is
  // deliberately the only signal a non-owner ever gets: "not found" for both "does not
  // exist" and "exists but is private", never a distinguishing 403.
  const generation = await getGeneration(req.params.id);
  if (!generation || !mayView(generation, owner)) {
    res.status(404).type("html").send(`<p class="placeholder">Not found.</p>`);
    return;
  }

  const mode: TokenMode = isOwner(generation, owner) ? "rw" : "ro";
  const grant = mintViewGrant(generation.id, mode, Date.now() + VIEW_GRANT_TTL_MS, requireEnv("APP_TOKEN_SECRET"));

  // Only a complete, decomposed app can be edited — getFilledApp returns null for anything
  // still streaming, failed, predating Phase 2's plan column, or not owned by this viewer.
  const loaded = mode === "rw" ? await getFilledApp(generation.id, owner) : null;
  const editFormHtml = loaded ? editForm(generation.id, loaded.filled.slots) : "";
  // Points at the real, standalone share page — /generations/:id/frame
  // is an htmx fragment with no doctype/stylesheet/htmx script of its own, so a recipient
  // opening it directly gets an unstyled ~300x150 iframe and a "Remix" button that does
  // nothing (no htmx loaded to intercept its hx-post).
  const shareUrl = `${studioOrigin}/apps/${generation.id}`;
  const ownerHtml = mode === "rw" ? ownerControls(generation.id, generation.visibility, shareUrl) : remixControl(generation.id);

  const chatHtml =
    mode === "rw"
      ? chatLogOob(generation.id, messageItems(await fullConversation(generation), pendingText(generation)))
      : chatLogOob("", "");
  res
    .type("html")
    .send(
      previewFrame(generation.id, appOrigin(generation.id), grant) +
        oobSlot("edit-slot", editFormHtml) +
        oobSlot("owner-slot", ownerHtml) +
        chatHtml,
    );
});

// The page a shared link actually opens — see sharedAppPage's doc comment for why the frame
// route's fragment cannot serve as one. Same mayView/mode logic as that route; a separate one
// (rather than content-negotiating the frame route) so the frame route can stay a plain
// fragment for htmx's own hx-target="#stage" swap.
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

// Owner-only, like visibility: another owner's app answers 404, never a distinguishing 403.
// The sidebar's delete control targets #edit-result, so the messages below surface as the
// same toast an edit problem does; a 200 sends an empty body and the page removes the row.
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
  // `isFilledApp`, not just `plan !== null` — the guard has to be at
  // least as strong as the cast `forkGeneration` makes (`source.plan as FilledApp`, handed
  // straight to `renderDocument`). A Phase-2-era row, or any complete row whose plan never
  // got slot content, has a non-null `plan` that is not a `FilledApp`; without this it would
  // pass this check and then throw inside `renderDocument`, turning a case this route already
  // has the right answer for (409) into a 500.
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
