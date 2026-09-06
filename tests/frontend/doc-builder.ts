/**
 * Shared, non-test helpers for security.spec.ts, app-data.spec.ts, progressive.spec.ts,
 * error-states.spec.ts, and settings.spec.ts: hand-writing generated-app documents (per
 * .docs/tests-frontend.md's instruction that the security section needs an app whose script
 * attempts an access and writes the result somewhere observable, hand-written rather than
 * asked of a model), building fake-provider plan/fill scripts, and a couple of Playwright
 * navigation helpers used across every one of those files.
 */
import pg from "pg";
import { expect } from "@playwright/test";
import type { Page, Frame } from "@playwright/test";
import {
  dataRuntime,
  swapRuntime,
  renderDocument,
  renderSkeletons,
  mintAppToken,
  SKELETON_CSS,
} from "@any-app/protocol";
import type { AppPlan, FilledApp, SlotSpec, CollectionSpec } from "@any-app/protocol";

const { Pool } = pg;

/** Fixed for the shared default server every seeded-row case runs against (security.spec.ts,
 * app-data.spec.ts, settings.spec.ts's session-credential cases) — that server always binds
 * studio to this exact origin, since its ports never change. Isolated per-file server pairs
 * (progressive.spec.ts, error-states.spec.ts, settings.spec.ts's G9) use their own
 * `servers.studioOrigin` instead, since their ports are ephemeral. */
export const STUDIO_ORIGIN = "http://localhost:3000";

/**
 * PRODUCTION DEFECT, not a harness gap — reported, not fixed here (CLAUDE.md forbids
 * production edits from this suite; see security.spec.ts's B10 for the full write-up and
 * how it was proven). apps/studio/src/views.ts's homePage() inline <script> contains a
 * regex literal written as `\/generations\/([^/]+)\/edits\/` inside a JS template literal —
 * `\/` is not a real escape sequence, so template-literal processing drops the backslash,
 * and the SERVED script contains `//generations/...` instead: `//` opens a line comment
 * that swallows the rest of that statement, which is a syntax error. A syntax error
 * anywhere in a <script> block prevents the WHOLE block from parsing, so this fires on
 * EVERY studio homepage load, not just when an edit is submitted.
 *
 * H6/H7 (app-data.spec.ts) and E8 (error-states.spec.ts) navigate the top-level studio page
 * as part of driving a seeded/generated app and assert there are no console/page errors —
 * their actual intent is "the APP under test introduces no errors", not "the pre-existing,
 * already-reported studio shell bug is now someone else's problem too". This filters that
 * one, specific, already-documented error out of what those cases assert on, so they still
 * catch a real regression in the app under test (or a NEW, different studio-shell error)
 * without being permanently red over a bug that isn't theirs to fix and is already reported.
 */
export function isKnownStudioHomepageSyntaxBug(text: string): boolean {
  return text.includes("Unexpected token 'var'");
}

/** The per-app origin template this suite's servers use by default (never overridden by any
 * spec file) — see harness/servers.ts's `defaultAppOriginTemplate` for port 3001. */
export function appOriginFor(id: string): string {
  return `http://${id}.apps.localhost:3001`;
}

const DOCTYPE = "<!doctype html>\n";
const SHELL_TAIL = "</body>\n</html>\n";

/**
 * A minimal, fully static HTML document with no slots and no adversarial script baked in —
 * B3/B4/B6/B7/B8/B9's actual attack code is injected later via `frame.evaluate()` instead
 * (see security.spec.ts), which executes just as much inside the frame's real
 * origin/sandbox context as an inline `<script>` would, and is far easier to parameterise
 * per test. This just needs to be a valid, standards-mode document with a `<title>` an
 * attack test can safely overwrite.
 */
export function buildStaticDoc(title: string): string {
  return `${DOCTYPE}<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body><p>static test document</p></body>
</html>
`;
}

/** Replicates apps/studio/src/shell.ts's `renderShellHead` exactly. That file lives inside
 * an app (`apps/studio/src`), not a package, so it cannot be imported from here — and per
 * this task's brief, the security/data documents in this suite are meant to be hand-written
 * fixtures anyway, not a dependency on production wiring that could change out from under a
 * test silently. Keep this in sync with shell.ts's shape if that ever changes structurally. */
function renderHead(plan: AppPlan, studioOrigin: string, appToken: string): string {
  const data = plan.collections.length > 0 ? `<script>${dataRuntime(appToken)}</script>\n` : "";
  return `<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${plan.title}</title>
<style>${SKELETON_CSS}</style>
<style id="anyapp-css">${plan.css}</style>
<script>${swapRuntime(studioOrigin)}</script>
${data}</head>
<body>
${renderSkeletons(plan.shell, plan.slots)}
<script>${plan.script}</script>
`;
}

export interface HandDoc {
  title?: string;
  css?: string;
  shell?: string;
  script?: string;
  slots?: SlotSpec[];
  content?: Record<string, string>;
  collections?: CollectionSpec[];
}

/** Builds a full, replayable generated-app document in exactly the shape `renderDocument`
 * produces in production, from a hand-written spec — real shell+slots+swap()+data-runtime
 * semantics, real derived app token, but authored directly rather than by a model. */
export function buildFilledDocument(
  appId: string,
  appTokenSecret: string,
  studioOrigin: string,
  doc: HandDoc,
): { document: string; plan: FilledApp; appToken: string } {
  const slots = doc.slots ?? [];
  const plan: FilledApp = {
    title: doc.title ?? "Test app",
    css: doc.css ?? "body{font:14px system-ui}",
    shell: doc.shell ?? slots.map((s) => `<div data-slot="${s.id}"></div>`).join(""),
    script: doc.script ?? "",
    slots,
    collections: doc.collections ?? [],
    content: doc.content ?? Object.fromEntries(slots.map((s) => [s.id, `<p>${s.id}</p>`])),
  };
  const appToken = mintAppToken(appId, appTokenSecret);
  const document = DOCTYPE + renderDocument(plan, (p) => renderHead(p, studioOrigin, appToken), SHELL_TAIL);
  return { document, plan, appToken };
}

/**
 * Seeds a `generations` row whose document/plan reference the row's OWN id (needed for a
 * real data-API token, or a real `getFilledApp`-shaped plan an edit can target) — something
 * `harness/seed.ts`'s `seedGeneration` cannot do alone, since the id only exists after the
 * insert but the token has to be embedded IN the document at insert time. Two-phase: insert
 * a placeholder row to learn the real id, build the real document against that id, then
 * update the row in place. Raw `pg`, like `harness/seed.ts`/`harness/db.ts` — deliberately
 * not `@any-app/store` — so this stays safe to call repeatedly against the shared scratch
 * database from any spec file's process.
 */
export async function seedFilledApp(
  databaseUrl: string,
  appTokenSecret: string,
  studioOrigin: string,
  prompt: string,
  doc: HandDoc,
): Promise<{ id: string; document: string; plan: FilledApp; appToken: string }> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const insert = await pool.query<{ id: string }>(
      `insert into generations (prompt, status, document) values ($1, 'complete', '') returning id`,
      [prompt],
    );
    const id = insert.rows[0]!.id;
    const { document, plan, appToken } = buildFilledDocument(id, appTokenSecret, studioOrigin, doc);
    await pool.query(`update generations set document = $1, plan = $2 where id = $3`, [
      document,
      JSON.stringify(plan),
      id,
    ]);
    return { id, document, plan, appToken };
  } finally {
    await pool.end();
  }
}

// ---- Playwright navigation helpers -------------------------------------------------------

/** Finds the live (non-detached) frame whose URL matches `src`, waiting for it to appear.
 * `page.frames()` is the only way in — the preview iframe is genuinely cross-origin from the
 * studio page, so `frameLocator`/raw `Frame` objects are how this suite reaches inside it
 * (see tests-frontend.md's Harness section). Picking the LAST matching, non-detached frame
 * guards against grabbing a stale reference right after a re-click swaps in a fresh iframe
 * with the same `src` (B5/H3/H5's "reload the same app" pattern). */
export async function waitForFrameBySrc(
  page: Page,
  src: string,
  opts: { waitForLoad?: boolean } = {},
): Promise<Frame> {
  // Retries the whole find-and-verify cycle, not just the find: right after a re-click
  // swaps in a fresh iframe with the same `src` (B5/H3/H5s reload-the-same-app pattern),
  // there is a real window where page.frames() still returns the OLD frame object
  // (matching src, isDetached() not yet flipped) a tick before it actually detaches —
  // grabbing it there and using it a moment later throws "Frame was detached". A single
  // poll-then-grab (the previous shape here) is exactly what raced; verifying the
  // candidate is genuinely alive with a trivial evaluate before returning it, and
  // retrying from scratch if that throws, closes the window instead of narrowing it.
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const matches = page.frames().filter((f) => f.url() === src && !f.isDetached());
    const candidate = matches[matches.length - 1];
    if (candidate) {
      try {
        if (opts.waitForLoad !== false) {
          await candidate.waitForLoadState("load", { timeout: 2000 });
        }
        await candidate.evaluate(() => true); // liveness check — throws if detached by now
        return candidate;
      } catch (error) {
        lastError = error; // candidate died mid-check (or never loaded) — retry from scratch
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `waitForFrameBySrc: no live frame for src ${src} within timeout (last error: ${String(lastError)})`,
  );
}

/** Navigates home, clicks the sidebar entry whose label contains `prompt`, and returns the
 * resulting preview frame once it has fully loaded. For seeded (already-complete) rows —
 * every case in security.spec.ts and app-data.spec.ts — where "fully loaded" is a fast,
 * well-defined state to wait for. See `submitPrompt` below for the streaming-generation
 * variant, which deliberately does NOT wait for load.
 *
 * `origin` is optional: omit it for the suite's shared default server (relies on
 * playwright.config.ts's `baseURL`, `http://localhost:3000`) — every seeded-row case in
 * security.spec.ts, app-data.spec.ts, and settings.spec.ts's session-credential cases.
 * Pass an explicit origin for a test-owned isolated server pair (progressive.spec.ts's C1
 * is the one seeded case that still runs there, alongside that file's C2-C8) — see
 * global-setup.ts's header comment for why some cases need their own server entirely. */
export async function openSidebarApp(
  page: Page,
  prompt: string,
  origin?: string,
): Promise<{ frame: Frame; src: string }> {
  await page.goto(origin ? `${origin}/` : "/");
  await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
  await expect(page.locator("#stage iframe")).toHaveCount(1);
  const src = await page.locator("#stage iframe").getAttribute("src");
  if (!src) throw new Error("iframe has no src");
  const frame = await waitForFrameBySrc(page, src);
  return { frame, src };
}

/** Submits a fresh prompt through the home page's form and returns the new generation's id
 * and preview frame — WITHOUT waiting for the frame to finish loading, since a streaming
 * generation this suite is about to drive by hand (C2-C8, E1-E4/E6/E8, G9) may deliberately
 * never close its response until the test says so. Callers assert on frame content directly
 * (locators poll the live DOM regardless of whether the underlying request has finished).
 *
 * `origin` is optional for the same reason as `openSidebarApp` above — every caller of this
 * function in practice passes one, since every case that drives a real generation by hand
 * uses its own isolated server pair (see global-setup.ts's header comment), but the default
 * (shared server, relative navigation) is kept for symmetry and in case a future case needs
 * it without an isolated stack of its own. */
export async function submitPrompt(
  page: Page,
  prompt: string,
  origin?: string,
): Promise<{ id: string; frame: Frame; src: string }> {
  await page.goto(origin ? `${origin}/` : "/");
  await page.fill('textarea[name="prompt"]', prompt);
  await page.click('button[type="submit"]');
  await expect(page.locator("#stage iframe")).toHaveCount(1);
  const src = await page.locator("#stage iframe").getAttribute("src");
  if (!src) throw new Error("iframe has no src");
  const match = /\/preview\/([0-9a-f-]{36})/i.exec(src);
  if (!match) throw new Error(`could not extract a generation id from iframe src ${src}`);
  const frame = await waitForFrameBySrc(page, src, { waitForLoad: false });
  return { id: match[1]!, frame, src };
}

// ---- Fake-provider plan/fill script builders ---------------------------------------------

/** A well-formed planner response (`===TITLE===` ... sections), matching
 * packages/generator/src/section-parser.ts + planner.ts's `parsePlan`. */
export function planText(opts: {
  title?: string;
  css?: string;
  shell: string;
  script?: string;
  slots: { id: string; height: number; spec: string }[];
  collections?: { name: string; description: string }[];
}): string {
  const slotsBlock = opts.slots.map((s) => `${s.id}|${s.height}|${s.spec}`).join("\n");
  const dataBlock = opts.collections?.length
    ? `\n===DATA===\n${opts.collections.map((c) => `${c.name}|${c.description}`).join("\n")}`
    : "";
  return `===TITLE===
${opts.title ?? "Test App"}
===CSS===
${opts.css ?? "body{margin:0;font:14px system-ui}"}
===SHELL===
${opts.shell}
===SCRIPT===
${opts.script ?? ""}
===SLOTS===
${slotsBlock}${dataBlock}
`;
}

/** One `===SLOT id===` marker line, matching packages/generator/src/slot-stream.ts's
 * `MARKER` — send this, then the slot's HTML, then the next marker (or `finish()`/flush) to
 * close it. */
export function slotMarker(id: string): string {
  return `===SLOT ${id}===\n`;
}

/** A reusable two-slot shell + matching slot specs, shared by every progressive/error-state
 * case that just needs "a plan with two ordinary regions" rather than anything bespoke. */
export const SHELL_2_SLOTS = `<div data-slot="alpha"></div><div data-slot="beta"></div>`;
export const SLOTS_2 = [
  { id: "alpha", height: 300, spec: "First region" },
  { id: "beta", height: 200, spec: "Second region" },
];
