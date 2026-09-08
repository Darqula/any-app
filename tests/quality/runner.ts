/**
 * Orchestrates the section-F generated-app quality sweep: N real prompts x the fill modes
 * requested, against a real provider, on a scratch database that is always dropped.
 *
 * This is a REPORT, not a test suite — see `tests/quality/README.md`. It exits 0 whenever the
 * sweep ran to completion, no matter the pass rates, and non-zero only when the harness
 * itself is broken (server wouldn't start, DB unreachable, provider auth failed, or the
 * runner was invoked without authorization to spend real money).
 *
 * Usage (see README.md for the full contract):
 *   node --import tsx tests/quality/runner.ts --yes
 *   node --import tsx tests/quality/runner.ts --yes --prompts=1 --modes=sequential
 *
 * ANYAPP_QUALITY_RUN=1 in the environment is equivalent to --yes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";
import { createScratchDatabase, readSuperuserDatabaseUrl, REPO_ROOT } from "../harness/db";
import { startServers } from "../harness/servers";
import type { RunningServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { QUALITY_PROMPTS } from "./prompts";
import type { QualityPrompt } from "./prompts";
import { runDocChecks } from "./checks-doc";
import type { GenerationRow } from "./checks-doc";
import { attachErrorListeners, runRenderedChecks } from "./checks-rendered";
import { renderStdoutReport, writeJsonReport } from "./report";
import type { FillMode, GenerationRecord, SweepReport } from "./report";

const { Pool } = pg;

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_ROOT = path.join(here, "artifacts");

// --- CLI -----------------------------------------------------------------------------------

interface CliOptions {
  authorized: boolean;
  modes: FillMode[];
  prompts: QualityPrompt[];
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  let yes = false;
  for (const raw of argv) {
    if (raw === "--yes" || raw === "-y") {
      yes = true;
      continue;
    }
    const m = /^--([a-z]+)=(.*)$/.exec(raw);
    if (m) args.set(m[1]!, m[2]!);
  }

  const authorized = yes || process.env.ANYAPP_QUALITY_RUN === "1";

  let modes: FillMode[] = ["sequential", "parallel"];
  if (args.has("modes")) {
    modes = args
      .get("modes")!
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is FillMode => s === "sequential" || s === "parallel");
  }

  let prompts = QUALITY_PROMPTS;
  if (args.has("prompts")) {
    const raw = args.get("prompts")!;
    if (/^\d+$/.test(raw)) {
      prompts = QUALITY_PROMPTS.slice(0, Number(raw));
    } else {
      const ids = new Set(raw.split(",").map((s) => s.trim()));
      prompts = QUALITY_PROMPTS.filter((p) => ids.has(p.id));
    }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.get("out") ?? path.join(ARTIFACTS_ROOT, runId);

  return { authorized, modes, prompts, outDir };
}

function printCostBanner(opts: CliOptions, providerEnv: Record<string, string>): void {
  const total = opts.prompts.length * opts.modes.length;
  console.log("=".repeat(78));
  console.log("any-app generated-app quality sweep — REAL PROVIDER, REAL MONEY");
  console.log("=".repeat(78));
  console.log(`provider:  ${providerEnv.LLM_PROVIDER ?? "openai"}`);
  console.log(`model:     ${providerEnv.LLM_MODEL ?? "(unset)"}`);
  console.log(`base url:  ${providerEnv.OPENAI_BASE_URL || providerEnv.ANTHROPIC_BASE_URL || "(provider default)"}`);
  console.log(`prompts:   ${opts.prompts.length} (${opts.prompts.map((p) => p.id).join(", ")})`);
  console.log(`modes:     ${opts.modes.join(", ")}`);
  console.log(`total generations this run will attempt: ${total} (~2-3 min each, so roughly ${Math.round((total * 2.5) / 6) / 10}h wall clock)`);
  console.log(`artifacts + report will be written under: ${path.relative(REPO_ROOT, ARTIFACTS_ROOT)}`);
  console.log("=".repeat(78));
}

// --- .env reading (never sets process.env — see harness/db.ts's readSuperuserDatabaseUrl for
// the same pattern and why) ------------------------------------------------------------------

function readProviderEnv(): Record<string, string> {
  const envPath = path.join(REPO_ROOT, ".env");
  const parsed = parseEnv(readFileSync(envPath, "utf8"));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (/^(LLM_|OPENAI_|ANTHROPIC_)/.test(key) && value) out[key] = value;
  }
  if (!out.LLM_MODEL) {
    throw new Error(
      `.env at ${envPath} has no LLM_MODEL configured — this sweep uses the real platform ` +
        `credential/model from .env and refuses to fall back to a placeholder.`,
    );
  }
  return out;
}

// --- Harness-level failure detection --------------------------------------------------------

/** Patterns that mean "the provider rejected our credentials" or "no credential is
 * configured at all" — a broken *harness* (misconfigured .env, expired key), not a bad
 * generation. See the task brief: "provider auth failed" is explicitly a harness-break
 * example, not data to fold into a pass rate. */
function looksLikeAuthFailure(text: string): boolean {
  return /no credential configured|unauthorized|invalid[_ ]api[_ ]key|incorrect api key|\b401\b|authentication ?fail/i.test(
    text,
  );
}

/** A raw transport failure (server process died, port unreachable) rather than any kind of
 * application-level response — also a harness break, not a per-generation data point. */
function looksLikeTransportFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|net::ERR_|ERR_CONNECTION_/i.test(msg);
}

class HarnessBrokenError extends Error {}

// --- One generation --------------------------------------------------------------------------

interface DriveResult {
  id: string;
  rawStreamBody: string;
  generationMs: number;
}

async function driveGeneration(
  studioOrigin: string,
  internalSecret: string,
  prompt: QualityPrompt,
): Promise<DriveResult> {
  const createRes = await fetch(`${studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt: prompt.prompt }).toString(),
  });
  if (!createRes.ok) {
    throw new Error(`POST /generations returned HTTP ${createRes.status}`);
  }
  const createBody = await createRes.text();
  const idMatch = createBody.match(/\/preview\/([0-9a-f-]{36})"/);
  if (!idMatch) throw new Error(`could not find a generation id in the /generations response`);
  const id = idMatch[1]!;

  const start = Date.now();
  // Generous but bounded — real generations run 2-3 minutes; 10 minutes catches a genuinely
  // stuck call without waiting out the rest of an hour-long sweep on one prompt.
  const streamRes = await fetch(`${studioOrigin}/internal/generations/${id}/stream`, {
    headers: { [INTERNAL_SECRET_HEADER]: internalSecret },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const rawStreamBody = await streamRes.text();
  const generationMs = Date.now() - start;

  if (looksLikeAuthFailure(rawStreamBody)) {
    throw new HarnessBrokenError(`provider credential rejected: ${rawStreamBody.slice(0, 300)}`);
  }

  return { id, rawStreamBody, generationMs };
}

async function loadGenerationRow(databaseUrl: string, id: string): Promise<GenerationRow> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<GenerationRow>(
      `select status, document, plan, error from generations where id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error(`generation ${id} vanished from the database`);
    return row;
  } finally {
    await pool.end();
  }
}

/**
 * Reads back the raw-planner-failure capture `internal.ts`'s `capturePlannerFailure` writes
 * under `ANYAPP_PLANNER_RAW_DIR` (this run's own `runOutDir` — see `runMode`) when a
 * `PlanError` fired for this generation. Absent for the common case (planning succeeded), so
 * this is a plain best-effort read, not an assertion — a missing file just means no PlanError
 * happened, which is most generations.
 */
async function readPlannerFailure(
  runOutDir: string,
  id: string,
): Promise<{ reason: string; rawPath: string } | null> {
  const rawPath = path.join(runOutDir, `planner-fail-${id}.json`);
  try {
    const text = await readFile(rawPath, "utf8");
    const parsed = JSON.parse(text) as { reason?: string };
    return { reason: parsed.reason ?? "(planner-fail capture had no reason field)", rawPath };
  } catch {
    return null;
  }
}

/**
 * Writes the studio/sandbox children's captured stdout+stderr to `<runOutDir>/studio-<mode>.log`
 * / `sandbox-<mode>.log` — previously this went nowhere useful once the process exited, which
 * is exactly why a moved `PlanError`, a usage line, or a stack trace could only be recovered by
 * spending on a second run. `servers.logs()` is a rolling buffer capped at 1000 chunks
 * (`tests/harness/proc.ts`) — a very chatty run can lose its oldest lines, same limitation the
 * existing C15/H5 backend tests already live with; still far more than "nowhere" for the
 * common case of a handful of prompts per mode. Best-effort: a write failure here must not
 * abort the sweep.
 */
async function writeServerLogs(mode: FillMode, servers: RunningServers, runOutDir: string): Promise<void> {
  try {
    await mkdir(runOutDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(runOutDir, `studio-${mode}.log`), servers.logs("studio"), "utf8"),
      writeFile(path.join(runOutDir, `sandbox-${mode}.log`), servers.logs("sandbox"), "utf8"),
    ]);
  } catch (error) {
    console.warn(`[${mode}] failed to write server logs: ${String(error)}`);
  }
}

// --- One mode's worth of the sweep ------------------------------------------------------------

async function runMode(
  mode: FillMode,
  prompts: QualityPrompt[],
  providerEnv: Record<string, string>,
  browser: Browser,
  runOutDir: string,
  onRecord: (record: GenerationRecord) => Promise<void>,
): Promise<void> {
  console.log(`\n--- starting mode: ${mode} ---`);
  const scratch = await createScratchDatabase();
  try {
    const [studioPort, sandboxPort] = await findFreePorts(2);
    const internalSecret = randomBytes(16).toString("hex");
    await mkdir(runOutDir, { recursive: true });
    const servers = await startServers({
      databaseUrl: scratch.databaseUrl,
      sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
      ports: { studio: studioPort!, sandbox: sandboxPort! },
      env: {
        ...providerEnv,
        LLM_FILL_MODE: mode,
        INTERNAL_SECRET: internalSecret,
        // Makes internal.ts's capturePlannerFailure write every PlanError's raw response
        // (plus its reason) into this run's own artifact directory — see that function's
        // doc comment for why this is opt-in via env var rather than unconditional logging.
        // Only this sweep sets it; a plain `npm run dev` never does.
        ANYAPP_PLANNER_RAW_DIR: runOutDir,
      },
    });
    try {
      for (const [i, prompt] of prompts.entries()) {
        console.log(`[${mode}] (${i + 1}/${prompts.length}) generating "${prompt.id}"...`);
        const record: GenerationRecord = {
          id: null,
          promptId: prompt.id,
          mode,
          generationMs: null,
          attemptError: null,
          docChecks: [],
          renderedChecks: [],
          artifacts: null,
          plannerFailure: null,
        };
        try {
          const { id, rawStreamBody, generationMs } = await driveGeneration(
            servers.studioOrigin,
            internalSecret,
            prompt,
          );
          record.id = id;
          record.generationMs = generationMs;
          console.log(`[${mode}] (${i + 1}/${prompts.length}) "${prompt.id}" generated in ${(generationMs / 1000).toFixed(0)}s, checking...`);

          const row = await loadGenerationRow(scratch.databaseUrl, id);
          record.plannerFailure = await readPlannerFailure(runOutDir, id);
          record.docChecks = runDocChecks(row, rawStreamBody, mode, record.plannerFailure?.reason);

          if (row.status === "complete" && row.document) {
            const page = await browser.newPage();
            try {
              const listeners = attachErrorListeners(page);
              const url = `${servers.appOrigin(id)}/preview/${id}`;
              await page.goto(url, { waitUntil: "load", timeout: 30_000 });
              await page.waitForTimeout(5000); // F1's "5s of idle"
              record.renderedChecks = await runRenderedChecks(page, listeners, { tags: prompt.tags });

              await mkdir(runOutDir, { recursive: true });
              const base = `${mode}-${prompt.id}`;
              const screenshotPath = path.join(runOutDir, `${base}.png`);
              const htmlPath = path.join(runOutDir, `${base}.html`);
              await page.screenshot({ path: screenshotPath, fullPage: true }).catch((e) => {
                console.warn(`[${mode}] "${prompt.id}": screenshot failed: ${String(e)}`);
              });
              await writeFile(htmlPath, row.document ?? "", "utf8");
              record.artifacts = { screenshot: screenshotPath, html: htmlPath };
            } finally {
              await page.close();
            }
          } else {
            console.log(`[${mode}] (${i + 1}/${prompts.length}) "${prompt.id}": row not complete (status: ${row.status}) — skipping rendered checks`);
          }
        } catch (error) {
          if (error instanceof HarnessBrokenError) throw error;
          if (looksLikeTransportFailure(error)) {
            throw new HarnessBrokenError(
              `transport failure talking to the server (looks like it died mid-sweep): ${String(error)}`,
            );
          }
          record.attemptError = error instanceof Error ? error.message : String(error);
          console.warn(`[${mode}] (${i + 1}/${prompts.length}) "${prompt.id}" errored, recording and continuing: ${record.attemptError}`);
        }
        await onRecord(record);
      }
    } finally {
      // Studio/sandbox stdout+stderr, captured by `startServers` in-memory the whole run
      // (see servers.ts's `logs()` doc comment) — written out here so a run's server logs
      // sit beside its report.json and screenshots instead of vanishing with the process.
      // Written before `stop()` (though `logs()` would still work after — it's just an
      // in-memory array on an object this closure still holds) so a failure in `stop()`
      // itself can't skip it.
      await writeServerLogs(mode, servers, runOutDir);
      await servers.stop();
    }
  } finally {
    await scratch.drop();
  }
}

// --- Post-sweep sanity: no scratch databases left behind --------------------------------------

async function warnIfScratchDatabasesSurvived(): Promise<void> {
  const superuserUrl = readSuperuserDatabaseUrl();
  const pool = new Pool({ connectionString: superuserUrl });
  try {
    const { rows } = await pool.query<{ datname: string }>(
      `select datname from pg_database where datname like 'anyapp_test_%'`,
    );
    if (rows.length) {
      console.warn(
        `WARNING: ${rows.length} scratch database(s) survived this run and were not dropped: ` +
          rows.map((r) => r.datname).join(", "),
      );
    } else {
      console.log("verified: no anyapp_test_* scratch databases survived this run.");
    }
  } finally {
    await pool.end();
  }
}

// --- Entry point -------------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.authorized) {
    let providerEnv: Record<string, string> = {};
    try {
      providerEnv = readProviderEnv();
    } catch {
      // Fall through — the banner below still explains the cost even if .env can't be read.
    }
    printCostBanner(opts, providerEnv);
    console.error(
      "\nRefusing to run: this sweep drives real generations against a real, billed provider.\n" +
        "Pass --yes (or set ANYAPP_QUALITY_RUN=1) to authorize the spend shown above.\n",
    );
    process.exitCode = 2;
    return;
  }

  if (opts.prompts.length === 0) {
    console.error("No prompts matched --prompts — nothing to do.");
    process.exitCode = 2;
    return;
  }
  if (opts.modes.length === 0) {
    console.error("No valid fill modes in --modes (expected sequential and/or parallel).");
    process.exitCode = 2;
    return;
  }

  const providerEnv = readProviderEnv();
  printCostBanner(opts, providerEnv);

  const startedAt = new Date().toISOString();
  const report: SweepReport = {
    model: {
      provider: providerEnv.LLM_PROVIDER ?? "openai",
      model: providerEnv.LLM_MODEL ?? "",
      baseUrl: providerEnv.OPENAI_BASE_URL ?? providerEnv.ANTHROPIC_BASE_URL ?? "",
    },
    startedAt,
    finishedAt: "",
    prompts: opts.prompts.map((p) => ({ id: p.id, prompt: p.prompt, tags: p.tags })),
    modesRun: opts.modes,
    generations: [],
  };

  await mkdir(opts.outDir, { recursive: true });
  const jsonPath = path.join(opts.outDir, "report.json");

  const browser = await chromium.launch();
  try {
    for (const mode of opts.modes) {
      await runMode(mode, opts.prompts, providerEnv, browser, opts.outDir, async (record) => {
        report.generations.push(record);
        // Written after every single generation — requirement 5: a later throw must not lose
        // the generations that already completed.
        report.finishedAt = new Date().toISOString();
        await writeJsonReport(report, jsonPath);
      });
    }
  } finally {
    await browser.close();
  }

  report.finishedAt = new Date().toISOString();
  await writeJsonReport(report, jsonPath);

  console.log("\n" + renderStdoutReport(report));
  console.log(`\nFull JSON report: ${jsonPath}`);

  await warnIfScratchDatabasesSurvived();
}

main().catch((error) => {
  console.error("\nQUALITY SWEEP ABORTED — the harness itself failed, not a generation:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
