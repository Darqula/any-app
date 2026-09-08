/**
 * S13 probe (`.docs/testing-review.md`) — two cheap, independently-runnable tiers that each
 * isolate one half of S13's prompt fix, instead of paying for a full 20-generation quality
 * sweep to answer a question only half of which a full sweep would even isolate. See
 * `tests/quality/README.md`'s "S13 probe" section for the one-paragraph version and when to
 * reach for this instead of `runner.ts`.
 *
 * Tier 1 (`--tier1`): one real PLANNER call per prompt, no fill at all. Measures: of every
 * slot placeholder in the returned shell, how many carry at least one class? Baseline
 * (independently measured, 2026-09-06 sweep): 10 of 49 (20%).
 *
 * Tier 2 (`--tier2`): real FILL calls only, no planner spend — plans are reconstructed from
 * the saved 2026-09-06 sweep artifacts (`probe-reconstruct.ts`). Measures: does the returned
 * content wrap itself in a single element carrying a planner-defined class? Baseline (this
 * file's own replay over the saved artifacts, no provider call — see `--dry-run`): 28 of 49
 * (57%).
 *
 * A `--tier2 --limit=12` run on 2026-09-07 printed that corpus-wide 28/49 next to a 12-slot
 * result and read as a 57%->17% improvement; the true, paired figure for those same 12 slots
 * was 3->2 (inconclusive, with two slots flipping the wrong way). Two fixes came out of that:
 * (1) any subset run now reports a PAIRED before/after over exactly the slots it covers, with
 * the corpus-wide number printed only as clearly-labelled background, plus an explicit
 * wrapped<->unwrapped flip count in both directions; (2) `--only-wrapped` restricts Tier 2 to
 * slots whose saved content was already wrapped — the only slots the fix can move — with the
 * exact selection printed, deterministically, before any spend. `--limit`'s sampling also
 * changed from raw (alphabetical, mode-clustering) file order to a deterministic
 * mode-interleaved, round-robin order — see `deterministicSlotOrder`'s comment for why.
 *
 * `--dry-run` proves the whole pipeline (CLI parsing, `parsePlan`, the wrapped-root
 * measurement reused from `checks-doc.ts`, disk writes, reporting) against a stub provider —
 * no network, no cost. See that function for exactly what it checks and how the expected
 * numbers are asserted, not just printed.
 *
 * **Real runs cost real money** — same cost guard convention as `runner.ts`: refuses to spend
 * without `--yes` (or `ANYAPP_PROBE_RUN=1`), and always prints the planned call count and
 * which tier(s) first.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, roleConfig, fillSlot, NoCredentialError } from "@any-app/generator";
import type { Provider } from "@any-app/generator";
import type { AppPlan, SlotSpec, FilledApp } from "@any-app/protocol";
// Deep imports: neither is part of @any-app/generator's public `exports` (only "." ->
// src/index.ts). Same established convention as tests/backend/fake-provider.test.ts and
// tests/backend/fan-out.test.ts — a relative filesystem import, not a production-code change.
import { PLANNER_PROMPT } from "../../packages/generator/src/planner-prompt";
import { parsePlan } from "../../packages/generator/src/planner";
import { REPO_ROOT } from "../harness/db";
import { QUALITY_PROMPTS } from "./prompts";
import type { QualityPrompt } from "./prompts";
import {
  definedClassesFromCss,
  analyzeSlotRoots,
  wrappedRootOffenders,
  placeholderClassTokens,
} from "./checks-doc";
import { loadArtifactDocs, asFilledApp, asAppPlan, addClassesToPlaceholder } from "./probe-reconstruct";
import type { ReconstructedDoc, FillModeName } from "./probe-reconstruct";
import {
  createStubProvider,
  TIER1_FIXTURE_WITH_CLASSES,
  TIER1_FIXTURE_WITHOUT_CLASSES,
  TIER1_FIXTURE_PARSE_FAILURE,
  tier2FixtureWrapped,
  TIER2_FIXTURE_UNWRAPPED,
} from "./probe-stub";
import type { StubScript } from "./probe-stub";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_ROOT = path.join(here, "artifacts");
/** The one saved sweep the task brief names for Tier 2's reconstructed plans — overridable
 * via `--artifacts=DIR` for a future saved run, but this is the baseline every number in this
 * file's header comment is measured against. */
const DEFAULT_TIER2_ARTIFACTS_DIR = path.join(ARTIFACTS_ROOT, "2026-09-06T17-31-26-174Z");

/** The four documents (of the 2026-09-06 sweep) whose placeholders already carried the
 * region's own class BEFORE any S13 prompt change — confirmed by direct inspection (the
 * model volunteered a styling-hook class on its own, the same behaviour
 * `packages/protocol/src/slots.ts`'s tolerant-placeholder-scan comment describes). Task brief:
 * "use those as-is" — Tier 2 does not synthesize a class onto any placeholder in these four,
 * even for a slot inside them that (like `analytics-dashboard`'s `recent-orders`) has none. */
const ALREADY_B_SHAPED_FILES = new Set([
  "parallel-analytics-dashboard.html",
  "parallel-kanban-board.html",
  "parallel-notes-app.html",
  "parallel-todo-list.html",
]);

interface ProviderConfig {
  provider: Provider;
  model: string;
  maxTokens: number;
}

// --- CLI -------------------------------------------------------------------------------------

interface CliOptions {
  tier1: boolean;
  tier2: boolean;
  dryRun: boolean;
  authorized: boolean;
  count: number;
  limit: number | null;
  /** Restricts Tier 2 to slots whose saved content was already wrapped before the fix — the
   * only slots the fix can demonstrate anything on (a slot that started unwrapped can only
   * stay flat or regress). See `deterministicSlotOrder` for how selection order interacts
   * with this. */
  onlyWrapped: boolean;
  artifactsDir: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const flags = new Set<string>();
  const kv = new Map<string, string>();
  for (const raw of argv) {
    if (raw === "--yes" || raw === "-y") {
      flags.add("yes");
      continue;
    }
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    if (m[2] !== undefined) kv.set(m[1]!, m[2]);
    else flags.add(m[1]!);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    tier1: flags.has("tier1"),
    tier2: flags.has("tier2"),
    dryRun: flags.has("dry-run"),
    authorized: flags.has("yes") || process.env.ANYAPP_PROBE_RUN === "1",
    count: kv.has("count") ? Math.max(1, Number(kv.get("count"))) : 5,
    limit: kv.has("limit") ? Math.max(0, Number(kv.get("limit"))) : null,
    onlyWrapped: flags.has("only-wrapped"),
    artifactsDir: kv.get("artifacts") ?? DEFAULT_TIER2_ARTIFACTS_DIR,
    outDir: kv.get("out") ?? path.join(ARTIFACTS_ROOT, `probe-${runId}`),
  };
}

function usage(): void {
  console.error(
    [
      "Usage: node --import tsx tests/quality/probe.ts --tier1 [--tier2] [--yes] [--count=N] [options]",
      "       node --import tsx tests/quality/probe.ts --tier2 [--yes] [--limit=N] [--only-wrapped] [options]",
      "       node --import tsx tests/quality/probe.ts --dry-run [--tier1] [--tier2] [--limit=N] [--only-wrapped]",
      "",
      "Specify --tier1 and/or --tier2 (or pass --dry-run to validate the whole pipeline with a stub provider, no cost).",
      "--only-wrapped restricts Tier 2 to slots that were already wrapped before the fix — the only slots it can move.",
      "  --limit is applied after --only-wrapped, over a deterministic mode-interleaved slot order (see probe.ts header).",
      "  The exact slot selection is always printed before any spend.",
    ].join("\n"),
  );
}

// --- Tier 1: prompt selection ------------------------------------------------------------------

/**
 * Deterministic, and always includes `contact-form` (S13's reproduction case) regardless of
 * `count`. `contact-form` goes first; the remaining `count - 1` slots are filled from
 * `QUALITY_PROMPTS` in its own fixed array order, skipping `contact-form` itself — so the
 * same `count` always selects the same prompts, run to run.
 */
export function selectTier1Prompts(count: number): QualityPrompt[] {
  const contactForm = QUALITY_PROMPTS.find((p) => p.id === "contact-form");
  if (!contactForm) {
    throw new Error("probe.ts: \"contact-form\" is missing from tests/quality/prompts.ts — QUALITY_PROMPTS changed shape");
  }
  const rest = QUALITY_PROMPTS.filter((p) => p.id !== "contact-form");
  return [contactForm, ...rest.slice(0, Math.max(0, count - 1))].slice(0, Math.max(1, count));
}

// --- Tier 1: execution + reporting -------------------------------------------------------------

interface Tier1SlotResult {
  id: string;
  classes: string[];
}

interface Tier1PromptResult {
  promptId: string;
  rawPath: string;
  parseError: string | null;
  slots: Tier1SlotResult[] | null;
}

async function runTier1(
  prompts: QualityPrompt[],
  cfg: ProviderConfig,
  outDir: string,
): Promise<Tier1PromptResult[]> {
  const results: Tier1PromptResult[] = [];
  for (const prompt of prompts) {
    const raw = await cfg.provider.completeText(cfg.model, {
      system: PLANNER_PROMPT,
      user: prompt.prompt,
      maxTokens: cfg.maxTokens,
      label: "probe:planner",
    });

    // Always write the raw response to disk FIRST — .docs/open-problems.md's Q2 lesson: a
    // failing planner response must be captured raw before anything else is attempted, or a
    // parse failure loses the only evidence of what the model actually said.
    const rawPath = path.join(outDir, `tier1-${prompt.id}.raw.txt`);
    await mkdir(outDir, { recursive: true });
    await writeFile(rawPath, raw, "utf8");

    let parseError: string | null = null;
    let slots: Tier1SlotResult[] | null = null;
    try {
      const plan = parsePlan(raw);
      slots = plan.slots.map((s) => ({ id: s.id, classes: placeholderClassTokens(plan.shell, s.id) }));
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    results.push({ promptId: prompt.id, rawPath, parseError, slots });
  }
  return results;
}

function printTier1Report(results: Tier1PromptResult[], label: string): { totalSlots: number; withClass: number } {
  console.log(`\n--- Tier 1 report (${label}) ---`);
  let totalSlots = 0;
  let withClass = 0;
  for (const r of results) {
    if (r.parseError) {
      console.log(`  ${r.promptId}: PARSE FAILED — ${r.parseError} (raw saved: ${path.relative(REPO_ROOT, r.rawPath)})`);
      continue;
    }
    const slots = r.slots!;
    const slotWithClass = slots.filter((s) => s.classes.length > 0);
    totalSlots += slots.length;
    withClass += slotWithClass.length;
    console.log(`  ${r.promptId}: ${slotWithClass.length}/${slots.length} placeholders carry a class`);
    for (const s of slots) {
      console.log(`      ${s.id}: ${s.classes.length ? s.classes.join(" ") : "(no class)"}`);
    }
  }
  const pct = totalSlots ? Math.round((withClass / totalSlots) * 1000) / 10 : 0;
  console.log(`  TOTAL: ${withClass} of ${totalSlots} placeholders carry a class (${pct}%)`);
  console.log(`  Baseline (independently measured, 2026-09-06 sweep): 10 of 49 (20%).`);
  return { totalSlots, withClass };
}

// --- Tier 2: job planning (pure reconstruction — no provider calls) ---------------------------

interface Tier2SlotJob {
  doc: ReconstructedDoc;
  slot: SlotSpec;
  plan: AppPlan;
  defined: Set<string>;
  wrappedBefore: boolean;
}

interface Tier2Job {
  docs: ReconstructedDoc[];
  skipped: { file: string; reason: string }[];
  /** Every slot in the corpus, in the deterministic selection order (see
   * `deterministicSlotOrder`), BEFORE `--only-wrapped` or `--limit` are applied. Kept so the
   * selection report (`printTier2Selection`) can state exactly which slots a filter/limit
   * excluded, not just how many. */
  orderedSlotJobs: Tier2SlotJob[];
  /** `orderedSlotJobs` after `--only-wrapped` (identical to it when the flag is off). */
  eligibleSlotJobs: Tier2SlotJob[];
  /** `eligibleSlotJobs` after `--limit` — exactly what this run calls `fillSlot` on. */
  slotJobs: Tier2SlotJob[];
  onlyWrapped: boolean;
  limit: number | null;
  totalSlotsInCorpus: number;
  wrappedBeforeCount: number;
}

/**
 * Fix 3 (2026-09-07 incident): `loadArtifactDocs` returns documents sorted alphabetically by
 * filename, which puts every `parallel-*` document before every `sequential-*` one (ASCII
 * 'p' < 's'). A raw-file-order `--limit` therefore drains one fill mode almost entirely before
 * touching the other at all — exactly what produced the all-`parallel-*` (and mostly only 2-3
 * documents') sample that made a `--limit=12` run unreadable as a corpus signal.
 *
 * Rather than randomizing (which would make a run non-reproducible and impossible to state
 * ahead of time), this reorders deterministically in two passes: first, documents are
 * interleaved by fill mode (alternating parallel/sequential rather than draining one mode
 * first); second, slots are taken round-robin across THAT document order (one slot from each
 * document per round, rather than draining one document's several slots before moving to the
 * next). The result: any prefix of this order — which is exactly what `--limit` takes — is a
 * reproducible sample spread across both fill modes and as many distinct documents/prompts as
 * the requested size allows, instead of an accident of ASCII sort order. `buildTier2Job`'s
 * caller always prints the exact slots this produces (`printTier2Selection`) before any spend,
 * so nobody has to trust this description either.
 */
function deterministicSlotOrder(docs: ReconstructedDoc[], perDocSlotJobs: Map<string, Tier2SlotJob[]>): Tier2SlotJob[] {
  const byMode = new Map<FillModeName, ReconstructedDoc[]>();
  for (const doc of docs) {
    if (!byMode.has(doc.mode)) byMode.set(doc.mode, []);
    byMode.get(doc.mode)!.push(doc);
  }
  const modes = [...byMode.keys()];

  const docOrder: ReconstructedDoc[] = [];
  for (let round = 0; ; round++) {
    let any = false;
    for (const mode of modes) {
      const group = byMode.get(mode)!;
      if (round < group.length) {
        docOrder.push(group[round]!);
        any = true;
      }
    }
    if (!any) break;
  }

  const out: Tier2SlotJob[] = [];
  for (let round = 0; ; round++) {
    let any = false;
    for (const doc of docOrder) {
      const jobs = perDocSlotJobs.get(doc.file)!;
      if (round < jobs.length) {
        out.push(jobs[round]!);
        any = true;
      }
    }
    if (!any) break;
  }
  return out;
}

function buildTier2Job(artifactsDir: string, limit: number | null, onlyWrapped: boolean): Tier2Job {
  const { docs, skipped } = loadArtifactDocs(
    artifactsDir,
    (p) => readFileSync(p, "utf8"),
    (d) => readdirSync(d),
  );

  const perDocSlotJobs = new Map<string, Tier2SlotJob[]>();
  let wrappedBeforeCount = 0;
  let totalSlotsInCorpus = 0;

  for (const doc of docs) {
    const defined = definedClassesFromCss(doc.css);
    const roots = analyzeSlotRoots(asFilledApp(doc), defined);
    const offenders = wrappedRootOffenders(roots); // the exact DIAG:fill-wrapped-root definition, reused
    const offenderById = new Map(offenders.map((o) => [o.slotId, o] as const));

    totalSlotsInCorpus += doc.slots.length;
    wrappedBeforeCount += offenders.length;

    let shell = doc.shell;
    if (!ALREADY_B_SHAPED_FILES.has(doc.file)) {
      // Synthesize the B-shape: move each wrapped slot's own root class(es) onto its
      // placeholder — exactly what the S13-fixed planner is supposed to do itself.
      for (const off of offenders) shell = addClassesToPlaceholder(shell, off.slotId, off.rootClasses);
    }
    const plan = asAppPlan(doc, shell);

    perDocSlotJobs.set(
      doc.file,
      doc.slots.map((slot) => ({ doc, slot, plan, defined, wrappedBefore: offenderById.has(slot.id) })),
    );
  }

  const orderedSlotJobs = deterministicSlotOrder(docs, perDocSlotJobs);
  const eligibleSlotJobs = onlyWrapped ? orderedSlotJobs.filter((j) => j.wrappedBefore) : orderedSlotJobs;
  const slotJobs = limit != null ? eligibleSlotJobs.slice(0, limit) : eligibleSlotJobs;

  return {
    docs,
    skipped,
    orderedSlotJobs,
    eligibleSlotJobs,
    slotJobs,
    onlyWrapped,
    limit,
    totalSlotsInCorpus,
    wrappedBeforeCount,
  };
}

function slotJobKey(j: Tier2SlotJob): string {
  return `${j.doc.file}::${j.slot.id}`;
}

/**
 * Fix 2/3 (task brief): prints exactly which slots this run covers and which it excludes, and
 * why — deterministically, before any spend, so a reader never has to assume a subset run
 * speaks for the corpus. Called for both `--dry-run` and real invocations, before the cost
 * banner and the `--yes` gate.
 */
function printTier2Selection(job: Tier2Job): void {
  console.log("\nTier 2 slot selection (deterministic — see deterministicSlotOrder's comment in probe.ts):");
  console.log(
    `  corpus: ${job.totalSlotsInCorpus} slot(s) across ${job.docs.length} document(s)` +
      (job.skipped.length
        ? `, ${job.skipped.length} artifact(s) skipped entirely (no plan): ${job.skipped.map((s) => s.file).join(", ")}`
        : ""),
  );
  if (job.onlyWrapped) {
    console.log(
      `  --only-wrapped: ${job.eligibleSlotJobs.length} of ${job.totalSlotsInCorpus} corpus slot(s) were already wrapped ` +
        "before the fix (eligible — only these can demonstrate a change)",
    );
  }
  if (job.limit != null) {
    console.log(`  --limit=${job.limit}, applied after the filter: ${job.slotJobs.length} of ${job.eligibleSlotJobs.length} eligible slot(s) selected`);
  }

  console.log(`  COVERED (${job.slotJobs.length}) — this run calls fillSlot on exactly these, in this order:`);
  for (const j of job.slotJobs) {
    console.log(`    ${j.doc.file} / ${j.slot.id} (before: ${j.wrappedBefore ? "wrapped" : "unwrapped"})`);
  }

  const coveredKeys = new Set(job.slotJobs.map(slotJobKey));
  const filteredOut = job.onlyWrapped ? job.orderedSlotJobs.filter((j) => !j.wrappedBefore) : [];
  const limitedOut = job.eligibleSlotJobs.filter((j) => !coveredKeys.has(slotJobKey(j)));

  if (filteredOut.length) {
    console.log(`  EXCLUDED by --only-wrapped (${filteredOut.length}, already unwrapped before the fix — cannot demonstrate it):`);
    for (const j of filteredOut) console.log(`    ${j.doc.file} / ${j.slot.id}`);
  }
  if (limitedOut.length) {
    console.log(`  EXCLUDED by --limit (${limitedOut.length}, eligible but beyond the requested count):`);
    for (const j of limitedOut) console.log(`    ${j.doc.file} / ${j.slot.id}`);
  }
  if (!job.onlyWrapped && job.limit == null) {
    console.log("  (no filter, no limit — this run covers the entire corpus)");
  }
}

// --- Tier 2: execution + reporting --------------------------------------------------------------

interface Tier2SlotResult {
  doc: string;
  slotId: string;
  wrappedBefore: boolean;
  wrappedAfter: boolean;
  rawPath: string;
}

async function runTier2(job: Tier2Job, cfg: ProviderConfig, outDir: string): Promise<Tier2SlotResult[]> {
  await mkdir(outDir, { recursive: true });
  const results: Tier2SlotResult[] = [];
  for (const j of job.slotJobs) {
    const promptText = QUALITY_PROMPTS.find((p) => p.id === j.doc.promptId)?.prompt ?? j.doc.promptId;
    const content = await fillSlot(cfg.provider, cfg.model, cfg.maxTokens, promptText, j.plan, j.slot);

    const rawPath = path.join(outDir, `tier2-${j.doc.mode}-${j.doc.promptId}-${j.slot.id}.html`);
    await writeFile(rawPath, content, "utf8");

    // Same reused analysis, applied to what THIS call just produced — a single-slot
    // FilledApp so analyzeSlotRoots scores only this slot's fresh content, not the saved one.
    const singleSlotApp: FilledApp = {
      title: j.doc.promptId,
      css: j.doc.css,
      shell: j.plan.shell,
      script: j.doc.script,
      slots: [j.slot],
      collections: [],
      content: { [j.slot.id]: content },
    };
    const roots = analyzeSlotRoots(singleSlotApp, j.defined);
    const wrappedAfter = wrappedRootOffenders(roots).length > 0;

    results.push({ doc: j.doc.file, slotId: j.slot.id, wrappedBefore: j.wrappedBefore, wrappedAfter, rawPath });
  }
  return results;
}

interface Tier2ReportStats {
  pairedBefore: number;
  pairedTotal: number;
  pairedAfter: number;
  flipToUnwrapped: number;
  flipToWrapped: number;
}

function pct(n: number, d: number): number {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

/**
 * Fix 1 (2026-09-07 incident): a subset run must never be reported next to the corpus-wide
 * baseline as if that were the comparison — that reads as a 57%->17% improvement when the
 * true, paired figure for the tested slots was 3->2 (inconclusive, two slots regressing). The
 * corpus-wide number is now printed once, explicitly labelled "background only", and the
 * headline comparison is always PAIRED: the same slot set's own before/after, plus how many
 * slots flipped each direction — a net figure alone hides a regression the way this incident's
 * did. Returns the computed numbers (not just prints them) so `--dry-run` can assert on them
 * directly, and returns `null` when `results` is `null` (baseline-only — before any spend).
 */
function printTier2Report(job: Tier2Job, results: Tier2SlotResult[] | null, label: string): Tier2ReportStats | null {
  console.log(`\n--- Tier 2 report (${label}) ---`);
  if (job.skipped.length) {
    console.log(`  Skipped (no plan — linear fallback): ${job.skipped.map((s) => s.file).join(", ")}`);
  }
  console.log(
    `  Background only, NOT the comparison — corpus-wide baseline across all ${job.totalSlotsInCorpus} slots in every ` +
      `saved document (reconstructed, no provider call): ${job.wrappedBeforeCount} of ${job.totalSlotsInCorpus} wrapped ` +
      `(${pct(job.wrappedBeforeCount, job.totalSlotsInCorpus)}%). This run may cover a smaller/different subset — see PAIRED below.`,
  );

  const pairedBeforeSelected = job.slotJobs.filter((j) => j.wrappedBefore).length;
  console.log(
    `  PAIRED baseline for the ${job.slotJobs.length} slot(s) THIS run covers: ${pairedBeforeSelected} of ${job.slotJobs.length} wrapped ` +
      `(${pct(pairedBeforeSelected, job.slotJobs.length)}%) — this, not the line above, is the correct "before" to compare against.`,
  );

  if (!results) return null;

  const pairedBefore = results.filter((r) => r.wrappedBefore).length;
  const pairedAfter = results.filter((r) => r.wrappedAfter).length;
  const flipToUnwrapped = results.filter((r) => r.wrappedBefore && !r.wrappedAfter).length;
  const flipToWrapped = results.filter((r) => !r.wrappedBefore && r.wrappedAfter).length;

  if (flipToWrapped > 0) {
    console.log(
      `  !!!! REGRESSION: ${flipToWrapped} slot(s) moved unwrapped -> WRAPPED (worse than before) — flagged rows below !!!!`,
    );
  }

  for (const r of results) {
    const regressed = !r.wrappedBefore && r.wrappedAfter;
    const marker = regressed ? ">>> REGRESSION >>> " : "    ";
    console.log(`  ${marker}${r.doc} / ${r.slotId}: before=${r.wrappedBefore ? "wrapped" : "unwrapped"} -> after=${r.wrappedAfter ? "WRAPPED" : "unwrapped"}`);
  }

  console.log(
    `  PAIRED comparison — same ${results.length} slot(s): before ${pairedBefore} of ${results.length} (${pct(pairedBefore, results.length)}%) ` +
      `-> after ${pairedAfter} of ${results.length} (${pct(pairedAfter, results.length)}%)`,
  );
  console.log(`  Per-slot flips: ${flipToUnwrapped} wrapped->unwrapped, ${flipToWrapped} unwrapped->WRAPPED`);
  console.log(
    `  TOTAL after fresh fillSlot calls: ${pairedAfter} of ${results.length} wrapped (${pct(pairedAfter, results.length)}%)`,
  );

  return { pairedBefore, pairedTotal: results.length, pairedAfter, flipToUnwrapped, flipToWrapped };
}

// --- Dry run: small test helper -------------------------------------------------------------

/** Runs `fn` with `console.log` captured (still visible on the console afterward — the caller
 * re-prints the captured lines), so a dry-run self-check can assert the report's actual
 * printed text (e.g. "does the REGRESSION marker appear"), not just its returned numbers. */
function captureConsole<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
}

// --- Dry run: stub-provider self-test -----------------------------------------------------------

/**
 * Exercises the entire path — CLI plumbing aside — against a stub provider. No network, no
 * `resolve()`, no real credential needed. Covers every case the task brief lists as a minimum:
 * a planner response with classes on every placeholder, one with none, one that fails
 * `parsePlan`, a fill response that wraps, and one that does not — then asserts the resulting
 * numbers explicitly (not just prints them), and separately replays Tier 2's baseline
 * measurement over the REAL saved artifacts (still no provider call) to confirm it reproduces
 * 28 of 49.
 *
 * Also covers the three paths added after the 2026-09-07 misread: a subset run (`--limit=12`)
 * reporting a PAIRED baseline instead of the corpus-wide one, the `--only-wrapped` filter
 * (expected to select exactly 28 slots — the corpus-wide wrapped count), and a synthetic
 * regression case (one slot forced unwrapped -> WRAPPED) proving the regression marker
 * actually appears in the printed output, not just in a returned number.
 */
async function runDryRun(opts: CliOptions): Promise<void> {
  console.log("=".repeat(78));
  console.log("DRY RUN — stub provider only. No network call, no cost, nothing spent.");
  console.log("=".repeat(78));

  const runTier1Dry = opts.tier1 || !(opts.tier1 || opts.tier2);
  const runTier2Dry = opts.tier2 || !(opts.tier1 || opts.tier2);

  await mkdir(opts.outDir, { recursive: true });
  let allOk = true;

  if (runTier1Dry) {
    const scripts: StubScript[] = [
      { text: TIER1_FIXTURE_WITH_CLASSES },
      { text: TIER1_FIXTURE_WITHOUT_CLASSES },
      { text: TIER1_FIXTURE_PARSE_FAILURE },
    ];
    const stub = createStubProvider(scripts);
    const prompts: QualityPrompt[] = [
      { id: "stub-with-classes", prompt: "(stub) contact form, planner puts classes on placeholders", tags: [] },
      { id: "stub-without-classes", prompt: "(stub) contact form, planner leaves placeholders bare", tags: [] },
      { id: "stub-parse-failure", prompt: "(stub) planner response missing required sections", tags: [] },
    ];
    const results = await runTier1(prompts, { provider: stub, model: "stub-model", maxTokens: 1000 }, opts.outDir);
    printTier1Report(results, "DRY RUN");

    console.log("\n  Dry-run self-checks (Tier 1):");
    const withClasses = results[0]!;
    const withoutClasses = results[1]!;
    const parseFailure = results[2]!;
    const check = (label: string, ok: boolean) => {
      console.log(`    [${ok ? "PASS" : "FAIL"}] ${label}`);
      if (!ok) allOk = false;
    };
    check(
      "with-classes fixture: 2/2 placeholders carry a class",
      withClasses.parseError === null && (withClasses.slots ?? []).every((s) => s.classes.length > 0) && withClasses.slots?.length === 2,
    );
    check(
      "without-classes fixture: 0/2 placeholders carry a class",
      withoutClasses.parseError === null && (withoutClasses.slots ?? []).every((s) => s.classes.length === 0) && withoutClasses.slots?.length === 2,
    );
    check("parse-failure fixture: parsePlan threw and was captured as parseError, not a crash", parseFailure.parseError !== null);
    check("parse-failure fixture: raw response was written to disk before the parse attempt", !!parseFailure.rawPath);
  }

  if (runTier2Dry) {
    const check = (label: string, ok: boolean) => {
      console.log(`    [${ok ? "PASS" : "FAIL"}] ${label}`);
      if (!ok) allOk = false;
    };

    const job = buildTier2Job(opts.artifactsDir, opts.limit, opts.onlyWrapped);
    printTier2Selection(job);
    printTier2Report(job, null, "baseline only, no provider call yet");

    console.log("\n  Dry-run self-check (Tier 2 baseline replay):");
    check(
      `reconstructed corpus-wide baseline reproduces 28 of 49 (got ${job.wrappedBeforeCount} of ${job.totalSlotsInCorpus})`,
      job.wrappedBeforeCount === 28 && job.totalSlotsInCorpus === 49,
    );

    // Stub fillSlot: alternate wrapped/unwrapped per slot, in job order — guarantees the
    // scripted set covers both required cases regardless of how many slots are in play, and
    // makes the expected "after" count exactly computable (ceil(n/2) wrapped).
    const scripts: StubScript[] = job.slotJobs.map((j, idx) => {
      if (idx % 2 === 0) {
        const anyDefinedClass = [...j.defined][0] ?? "stub-defined-class";
        return { text: tier2FixtureWrapped(anyDefinedClass) };
      }
      return { text: TIER2_FIXTURE_UNWRAPPED };
    });
    const stub = createStubProvider(scripts);
    const results = await runTier2(job, { provider: stub, model: "stub-model", maxTokens: 1000 }, opts.outDir);
    const stats = printTier2Report(job, results, "DRY RUN, stub fillSlot");

    const expectedWrapped = Math.ceil(results.length / 2);
    console.log("\n  Dry-run self-checks (Tier 2 stub fill):");
    check(
      `alternating wrapped/unwrapped stub content measured as ${expectedWrapped} of ${results.length} wrapped`,
      stats?.pairedAfter === expectedWrapped,
    );
    check("at least one stub response measured as wrapped", results.some((r) => r.wrappedAfter));
    check("at least one stub response measured as NOT wrapped", results.some((r) => !r.wrappedAfter));
    check("PAIRED total equals the number of slots this run actually covered", stats?.pairedTotal === job.slotJobs.length);

    // --- Fix 1 demo: a subset run must report a PAIRED baseline, never the corpus-wide one ---
    console.log("\n  Dry-run self-check (subset run reports a PAIRED baseline, not the corpus-wide one):");
    const subsetJob = buildTier2Job(opts.artifactsDir, 12, false);
    const subsetPairedBefore = subsetJob.slotJobs.filter((j) => j.wrappedBefore).length;
    printTier2Selection(subsetJob);
    const { lines: subsetLines } = captureConsole(() =>
      printTier2Report(subsetJob, null, "SUBSET demo, --limit=12, no filter, baseline only"),
    );
    for (const l of subsetLines) console.log(l);
    check("subset (--limit=12) selects exactly 12 slots", subsetJob.slotJobs.length === 12);
    check(
      `subset's paired baseline (${subsetPairedBefore} of 12) differs from the corpus-wide baseline (28 of 49) ` +
        "— proves the report cannot silently reuse the corpus figure as the comparison",
      subsetPairedBefore !== 28,
    );
    check(
      'subset output labels the corpus figure as background, not the comparison (contains "Background only")',
      subsetLines.some((l) => l.includes("Background only")),
    );
    check(
      "subset output prints a PAIRED baseline line scoped to exactly the 12 covered slots",
      subsetLines.some((l) => l.includes("PAIRED baseline") && l.includes("12 slot(s)")),
    );

    // --- Fix 2 demo: --only-wrapped selects exactly the corpus's already-wrapped slots ---
    console.log("\n  Dry-run self-check (--only-wrapped filter):");
    const filterJob = buildTier2Job(opts.artifactsDir, null, true);
    printTier2Selection(filterJob);
    check(
      "--only-wrapped selects exactly 28 slots, all already wrapped before the fix",
      filterJob.slotJobs.length === 28 && filterJob.slotJobs.every((j) => j.wrappedBefore),
    );
    check(
      "--only-wrapped eligible count equals the corpus-wide wrapped count (28)",
      filterJob.eligibleSlotJobs.length === filterJob.wrappedBeforeCount,
    );

    // --- Fix 2 demo: an unwrapped -> WRAPPED regression must be impossible to miss ---
    console.log("\n  Dry-run self-check (regression surfacing — 'impossible to miss', not just readable line-by-line):");
    const wrappedExample = job.orderedSlotJobs.find((j) => j.wrappedBefore);
    const unwrappedExample = job.orderedSlotJobs.find((j) => !j.wrappedBefore);
    if (!wrappedExample || !unwrappedExample) {
      check("regression-surfacing demo has both a wrapped-before and an unwrapped-before example slot to use", false);
    } else {
      const regressionResults: Tier2SlotResult[] = [
        { doc: wrappedExample.doc.file, slotId: wrappedExample.slot.id, wrappedBefore: true, wrappedAfter: false, rawPath: "(synthetic, not written)" },
        { doc: unwrappedExample.doc.file, slotId: unwrappedExample.slot.id, wrappedBefore: false, wrappedAfter: true, rawPath: "(synthetic, not written)" },
      ];
      const regressionJob: Tier2Job = { ...job, slotJobs: [wrappedExample, unwrappedExample] };
      const { result: regressionStats, lines: regressionLines } = captureConsole(() =>
        printTier2Report(regressionJob, regressionResults, "SYNTHETIC regression demo"),
      );
      for (const l of regressionLines) console.log(l);
      check("synthetic demo: exactly 1 unwrapped -> WRAPPED flip counted", regressionStats?.flipToWrapped === 1);
      check("synthetic demo: exactly 1 wrapped -> unwrapped flip counted", regressionStats?.flipToUnwrapped === 1);
      check(
        'synthetic demo: printed output flags the regression prominently (a line contains "REGRESSION")',
        regressionLines.some((l) => l.includes("REGRESSION")),
      );
      check(
        "synthetic demo: the regressed slot's own row is individually marked, not just counted in a total",
        regressionLines.some((l) => l.includes(unwrappedExample.slot.id) && l.includes("REGRESSION")),
      );
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log(allOk ? "DRY RUN: all self-checks passed." : "DRY RUN: SOME SELF-CHECKS FAILED — see [FAIL] lines above.");
  console.log("=".repeat(78));
  if (!allOk) process.exitCode = 1;
}

// --- Real-run cost guard + banner ---------------------------------------------------------------

function safeRoleConfig(role: "planner" | "fill"): { provider: string; model: string; maxTokens: number } | null {
  try {
    return roleConfig(role);
  } catch {
    return null;
  }
}

function printCostBanner(
  opts: CliOptions,
  tier1Prompts: QualityPrompt[] | null,
  tier2Job: Tier2Job | null,
  plannerCfg: ReturnType<typeof safeRoleConfig>,
  fillCfg: ReturnType<typeof safeRoleConfig>,
): void {
  console.log("=".repeat(78));
  console.log("S13 probe — REAL PROVIDER, REAL MONEY (not the full quality sweep — see README.md)");
  console.log("=".repeat(78));
  if (tier1Prompts) {
    console.log(`Tier 1 (planner only): ${tier1Prompts.length} call(s), prompts: ${tier1Prompts.map((p) => p.id).join(", ")}`);
    console.log(`  provider: ${plannerCfg?.provider ?? "(unresolved — see error below)"}  model: ${plannerCfg?.model ?? "(unresolved)"}`);
  }
  if (tier2Job) {
    console.log(
      `Tier 2 (fill only): ${tier2Job.slotJobs.length} call(s) (1 per slot, over ${tier2Job.docs.length} reconstructed documents` +
        `${tier2Job.skipped.length ? `, ${tier2Job.skipped.length} artifact(s) skipped — no plan` : ""})` +
        `${tier2Job.onlyWrapped ? " [--only-wrapped]" : ""}${tier2Job.limit != null ? ` [--limit=${tier2Job.limit}]` : ""}`,
    );
    console.log(`  provider: ${fillCfg?.provider ?? "(unresolved — see error below)"}  model: ${fillCfg?.model ?? "(unresolved)"}`);
    console.log("  (exact slot selection printed above, before this banner)");
  }
  console.log(`artifacts + raw responses will be written under: ${path.relative(REPO_ROOT, opts.outDir)}`);
  console.log("=".repeat(78));
}

// --- Entry point ------------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.dryRun) {
    await runDryRun(opts);
    return;
  }

  if (!opts.tier1 && !opts.tier2) {
    usage();
    process.exitCode = 2;
    return;
  }

  // Loads .env into process.env once, same file runner.ts's readProviderEnv() reads — but
  // unlike that function (which deliberately never touches its OWN process.env, only a
  // spawned child's), this probe calls resolve()/roleConfig() in-process, and both read
  // process.env directly (see packages/generator/src/resolve.ts). There is no spawned server
  // here for a mutated process.env to leak into, so loading it directly is the correct
  // (and only) way to make a real run work — same call already used by
  // packages/store/src/env.ts's loadEnv().
  try {
    process.loadEnvFile(path.join(REPO_ROOT, ".env"));
  } catch {
    // No .env — fall through; resolve() below will raise a clear NoCredentialError.
  }

  const tier1Prompts = opts.tier1 ? selectTier1Prompts(opts.count) : null;
  if (tier1Prompts) console.log(`Tier 1 prompt selection (count=${opts.count}): ${tier1Prompts.map((p) => p.id).join(", ")}`);

  const tier2Job = opts.tier2 ? buildTier2Job(opts.artifactsDir, opts.limit, opts.onlyWrapped) : null;
  // Selection must be printed before any spend, and before the --yes gate below.
  if (tier2Job) printTier2Selection(tier2Job);

  const plannerCfg = opts.tier1 ? safeRoleConfig("planner") : null;
  const fillCfg = opts.tier2 ? safeRoleConfig("fill") : null;

  printCostBanner(opts, tier1Prompts, tier2Job, plannerCfg, fillCfg);

  if (!opts.authorized) {
    console.error(
      "\nRefusing to run: this probe drives real provider calls against a real, billed provider.\n" +
        "Pass --yes (or set ANYAPP_PROBE_RUN=1) to authorize the spend shown above.\n",
    );
    process.exitCode = 2;
    return;
  }

  await mkdir(opts.outDir, { recursive: true });

  try {
    if (opts.tier1) {
      const resolved = resolve("planner", null);
      const results = await runTier1(tier1Prompts!, resolved, opts.outDir);
      printTier1Report(results, "REAL");
    }
    if (opts.tier2) {
      const resolved = resolve("fill", null);
      const results = await runTier2(tier2Job!, resolved, opts.outDir);
      printTier2Report(tier2Job!, results, "REAL");
    }
  } catch (error) {
    if (error instanceof NoCredentialError) {
      console.error(`\nNo credential configured: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error("\nS13 PROBE ABORTED:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
