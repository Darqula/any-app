/**
 * Shared helpers for the security, app-data, progressive, error-states and settings specs: hand-written generated-app documents,
 * fake-provider plan/fill scripts, and Playwright navigation helpers.
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

/** The shared default server (fixed ports). Per-file isolated servers use their own servers.studioOrigin. */
export const STUDIO_ORIGIN = "http://localhost:3000";

/**
 * Filters one historical studio error: homePage's inline script once had a regex literal that lost its backslashes in the template literal
 * (a syntax error on every homepage load). H6/H7/E8 assert the app under test adds no errors, so they exclude it.
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

/** A minimal static document: attack code is injected later through frame.evaluate(), which runs in the same origin and sandbox context. */
export function buildStaticDoc(title: string): string {
  return `${DOCTYPE}<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body><p>static test document</p></body>
</html>
`;
}

/** Mirrors apps/studio/src/shell.ts's renderShellHead (an app, not importable here). Keep in sync if its shape changes. */
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

/** Builds a replayable document in the shape renderDocument produces (real shell, slots, swap(), data runtime, derived token), hand-written. */
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
  const appToken = mintAppToken(appId, "rw", appTokenSecret);
  const document = DOCTYPE + renderDocument(plan, (p) => renderHead(p, studioOrigin, appToken), SHELL_TAIL);
  return { document, plan, appToken };
}

/**
 * Seeds a row whose document and plan reference its own id, which harness/seed.ts cannot: insert to learn the id, build the document, update.
 * Raw pg, like the harness.
 */
export async function seedFilledApp(
  databaseUrl: string,
  appTokenSecret: string,
  studioOrigin: string,
  prompt: string,
  doc: HandDoc,
  /** The anonymous session that owns the row: get it from establishAnonSession first. Visibility is 'unlisted' so a direct /preview/:id needs no grant. */
  sessionId: string | null = null,
): Promise<{ id: string; document: string; plan: FilledApp; appToken: string }> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const insert = await pool.query<{ id: string }>(
      `insert into generations (prompt, status, document, visibility, session_id) values ($1, 'complete', '', 'unlisted', $2) returning id`,
      [prompt, sessionId],
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

/** Loads the home page once to establish the anonymous session (the cookie value is the session id) so a row can be seeded as its own. */
export async function establishAnonSession(page: Page, origin?: string): Promise<string> {
  await page.goto(origin ? `${origin}/` : "/");
  const cookies = await page.context().cookies();
  const cookie = cookies.find((c) => c.name === "anyapp_session");
  if (!cookie) throw new Error("expected the home page to set an anyapp_session cookie");
  return cookie.value;
}


/**
 * Finds the live frame by origin and path, ignoring the query: previewFrame mints a new view grant (?g) on every render. Pass excludeFrame
 * when reloading the same app: right after the click, page.frames() can still return the old, about-to-detach frame, which passes the
 * liveness check (reproduced under full-suite load). Excluding it by identity closes the race.
 */
export async function waitForFrameBySrc(
  page: Page,
  src: string,
  opts: { waitForLoad?: boolean; excludeFrame?: Frame } = {},
): Promise<Frame> {
  const target = new URL(src);
  const targetKey = target.origin + target.pathname;
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const matches = page.frames().filter((f) => {
      if (f.isDetached()) return false;
      if (opts.excludeFrame && f === opts.excludeFrame) return false;
      try {
        const u = new URL(f.url());
        return u.origin + u.pathname === targetKey;
      } catch {
        return false; // e.g. "about:blank" on a frame that hasn't navigated yet
      }
    });
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

/**
 * Opens home, clicks the sidebar entry and returns the loaded preview frame, for seeded (complete) rows. origin is optional: omit it for
 * the shared server, pass it for an isolated one.
 */
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

/**
 * Submits a prompt and returns the new id and frame WITHOUT waiting for load: a hand-driven streaming generation may stay open on purpose.
 * Assert on frame content instead (locators poll the live DOM).
 */
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

export function slotMarker(id: string): string {
  return `===SLOT ${id}===\n`;
}

/** A reusable two-region shell and specs for progressive/error-state cases. */
export const SHELL_2_SLOTS = `<div data-slot="alpha"></div><div data-slot="beta"></div>`;
export const SLOTS_2 = [
  { id: "alpha", height: 300, spec: "First region" },
  { id: "beta", height: 200, spec: "Second region" },
];
