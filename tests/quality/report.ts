/** Aggregates the runner's per-generation results into a stdout table and a diffable JSON file. Never runs anything or decides pass/fail. */
import { writeFile } from "node:fs/promises";
import type { CheckResult } from "./checks-doc";
import { F8_MODIFIER_DIAGNOSTIC_ID, F_WRAPPED_ROOT_DIAGNOSTIC_ID, F_DOUBLED_CLASS_DIAGNOSTIC_ID } from "./checks-doc";
import { FORM_SUBMIT_DIAGNOSTIC_ID } from "./checks-rendered";

export type FillMode = "sequential" | "parallel";

export interface GenerationRecord {
  /** The generation's database id, for correlating with planner-fail-<id>.json and server logs; null if it failed before one existed. */
  id: string | null;
  promptId: string;
  mode: FillMode;
  /** Wall-clock ms for the generation call itself (POST + drive-to-completion). */
  generationMs: number | null;
  /** Set when the attempt threw before checks ran. Every check is then recorded as an "error" row, so one bad generation does not shrink the denominator. */
  attemptError: string | null;
  docChecks: CheckResult[];
  renderedChecks: CheckResult[];
  artifacts: { screenshot: string | null; html: string | null } | null;
  /** The PlanError reason and the path of the raw capture; the raw response stays out of report.json. */
  plannerFailure: { reason: string; rawPath: string } | null;
}

export interface SweepReport {
  model: { provider: string; model: string; baseUrl: string };
  startedAt: string;
  finishedAt: string;
  prompts: { id: string; prompt: string; tags: string[] }[];
  modesRun: FillMode[];
  generations: GenerationRecord[];
}

interface CaseTally {
  id: string;
  label: string;
  pass: number;
  fail: number;
  skip: number;
  error: number;
}

/** Tallies per-id counts restricted to idFilter, so the F1-F8 table and the diagnostic tables never bleed into each other. */
function tallyChecks(
  records: GenerationRecord[],
  mode: FillMode,
  source: "doc" | "rendered",
  idFilter: readonly string[],
): CaseTally[] {
  const allowed = new Set(idFilter);
  const byId = new Map<string, CaseTally>();
  for (const rec of records) {
    if (rec.mode !== mode) continue;
    const checks = source === "doc" ? rec.docChecks : rec.renderedChecks;
    if (rec.attemptError) {
      // The generation itself never produced anything to check — every case this table
      // covers gets a hard "error" mark rather than being left out entirely.
      for (const id of idFilter) {
        const t = byId.get(id) ?? { id, label: id, pass: 0, fail: 0, skip: 0, error: 0 };
        t.error++;
        byId.set(id, t);
      }
      continue;
    }
    for (const c of checks) {
      if (!allowed.has(c.id)) continue;
      const t = byId.get(c.id) ?? { id: c.id, label: c.label, pass: 0, fail: 0, skip: 0, error: 0 };
      if (c.status === "pass") t.pass++;
      else if (c.status === "fail") t.fail++;
      else t.skip++;
      t.label = c.label;
      byId.set(c.id, t);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const DOC_CASE_IDS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"];
const RENDERED_CASE_IDS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8"];
/** Non-spec diagnostics on docChecks, kept apart from DOC_CASE_IDS (which also drives the attemptError fallback) so they never look like a ninth case. */
const DOC_DIAGNOSTIC_CASE_IDS = [F8_MODIFIER_DIAGNOSTIC_ID, F_WRAPPED_ROOT_DIAGNOSTIC_ID, F_DOUBLED_CLASS_DIAGNOSTIC_ID];
/** Same for renderedChecks: kept apart from RENDERED_CASE_IDS. */
const RENDERED_DIAGNOSTIC_CASE_IDS = [FORM_SUBMIT_DIAGNOSTIC_ID];

function rate(t: CaseTally): string {
  const scored = t.pass + t.fail; // skip/error excluded from the rate itself, shown alongside
  if (scored === 0) return "n/a";
  return `${t.pass}/${scored} (${Math.round((100 * t.pass) / scored)}%)`;
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function renderTable(title: string, seqTallies: CaseTally[], parTallies: CaseTally[]): string {
  const ids = [...new Set([...seqTallies.map((t) => t.id), ...parTallies.map((t) => t.id)])].sort();
  const bySeq = new Map(seqTallies.map((t) => [t.id, t]));
  const byPar = new Map(parTallies.map((t) => [t.id, t]));

  const lines: string[] = [];
  lines.push(title);
  lines.push(
    padRight("Case", 6) + padRight("sequential", 22) + padRight("parallel", 22) + "delta (seq - par)",
  );
  for (const id of ids) {
    const s = bySeq.get(id);
    const p = byPar.get(id);
    const sRate = s ? rate(s) : "n/a";
    const pRate = p ? rate(p) : "n/a";
    let delta = "n/a";
    if (s && p && s.pass + s.fail > 0 && p.pass + p.fail > 0) {
      const sPct = (100 * s.pass) / (s.pass + s.fail);
      const pPct = (100 * p.pass) / (p.pass + p.fail);
      const d = sPct - pPct;
      delta = `${d > 0 ? "+" : ""}${d.toFixed(0)}pp`;
    }
    const label = s?.label ?? p?.label ?? id;
    lines.push(padRight(id, 6) + padRight(sRate, 22) + padRight(pRate, 22) + delta);
    const notes: string[] = [];
    if (s && s.skip) notes.push(`seq skip=${s.skip}`);
    if (s && s.error) notes.push(`seq error=${s.error}`);
    if (p && p.skip) notes.push(`par skip=${p.skip}`);
    if (p && p.error) notes.push(`par error=${p.error}`);
    if (notes.length) lines.push("      " + label + " — " + notes.join(", "));
  }
  return lines.join("\n");
}

export function renderStdoutReport(report: SweepReport): string {
  const lines: string[] = [];
  lines.push("=".repeat(78));
  lines.push("any-app generated-app quality sweep");
  lines.push("=".repeat(78));
  lines.push(`model:    ${report.model.provider} / ${report.model.model} (${report.model.baseUrl || "default"})`);
  lines.push(`started:  ${report.startedAt}`);
  lines.push(`finished: ${report.finishedAt}`);
  lines.push(`prompts:  ${report.prompts.length} (${report.prompts.map((p) => p.id).join(", ")})`);
  lines.push(`modes:    ${report.modesRun.join(", ")}`);
  lines.push(`total generations attempted: ${report.generations.length}`);
  const errored = report.generations.filter((g) => g.attemptError);
  if (errored.length) {
    lines.push(`generations that errored before producing checkable output: ${errored.length}`);
    for (const g of errored) lines.push(`  - ${g.mode}/${g.promptId}: ${g.attemptError}`);
  }
  lines.push("");

  const seq = report.modesRun.includes("sequential") ? report.generations : [];
  const par = report.modesRun.includes("parallel") ? report.generations : [];

  lines.push(
    renderTable(
      "Backend section F — provider-output contract (doc-level)",
      tallyChecks(seq, "sequential", "doc", DOC_CASE_IDS),
      tallyChecks(par, "parallel", "doc", DOC_CASE_IDS),
    ),
  );
  lines.push("");
  lines.push(
    renderTable(
      "Backend diagnostics (INFORMATIONAL — not part of any spec F-case pass rate; see" +
        " checks-doc.ts's checkF8ModifierDiagnostic)",
      tallyChecks(seq, "sequential", "doc", DOC_DIAGNOSTIC_CASE_IDS),
      tallyChecks(par, "parallel", "doc", DOC_DIAGNOSTIC_CASE_IDS),
    ),
  );
  lines.push("");
  lines.push(
    renderTable(
      "Frontend section F — generated-app quality (rendered)",
      tallyChecks(seq, "sequential", "rendered", RENDERED_CASE_IDS),
      tallyChecks(par, "parallel", "rendered", RENDERED_CASE_IDS),
    ),
  );
  lines.push("");
  lines.push(
    renderTable(
      "Frontend diagnostics (INFORMATIONAL — not part of any spec F-case pass rate; see" +
        " checks-rendered.ts's checkFormSubmitDiagnostic)",
      tallyChecks(seq, "sequential", "rendered", RENDERED_DIAGNOSTIC_CASE_IDS),
      tallyChecks(par, "parallel", "rendered", RENDERED_DIAGNOSTIC_CASE_IDS),
    ),
  );
  lines.push("");
  lines.push("Per-generation detail:");
  for (const g of report.generations) {
    const durS = g.generationMs != null ? `${(g.generationMs / 1000).toFixed(0)}s` : "n/a";
    lines.push(`  [${g.mode}] ${g.promptId} (${durS})${g.attemptError ? "  *** ERRORED: " + g.attemptError : ""}`);
    if (!g.attemptError) {
      const failedDoc = g.docChecks.filter((c) => c.status === "fail" && DOC_CASE_IDS.includes(c.id)).map((c) => c.id);
      const failedDiagnostics = g.docChecks
        .filter((c) => c.status === "fail" && DOC_DIAGNOSTIC_CASE_IDS.includes(c.id))
        .map((c) => c.id);
      const failedRendered = g.renderedChecks
        .filter((c) => c.status === "fail" && RENDERED_CASE_IDS.includes(c.id))
        .map((c) => c.id);
      const failedRenderedDiagnostics = g.renderedChecks
        .filter((c) => c.status === "fail" && RENDERED_DIAGNOSTIC_CASE_IDS.includes(c.id))
        .map((c) => c.id);
      if (failedDoc.length) {
        lines.push(`      doc fails: ${failedDoc.join(", ")}`);
        // F4's detail (when present) is the live PlanError reason — surfaced inline rather
        // than making a reader open report.json to see why planning fell back to linear.
        for (const c of g.docChecks) {
          if (c.status === "fail" && DOC_CASE_IDS.includes(c.id) && c.detail) {
            lines.push(`        ${c.id}: ${c.detail}`);
          }
        }
      }
      if (failedDiagnostics.length) {
        lines.push(`      doc diagnostics (informational, NOT a spec fail): ${failedDiagnostics.join(", ")}`);
      }
      if (failedRendered.length) lines.push(`      rendered fails: ${failedRendered.join(", ")}`);
      if (failedRenderedDiagnostics.length) {
        lines.push(`      rendered diagnostics (informational, NOT a spec fail): ${failedRenderedDiagnostics.join(", ")}`);
      }
      if (!failedDoc.length && !failedRendered.length) lines.push("      all scored checks passed");
    }
    if (g.plannerFailure) lines.push(`      planner raw response saved: ${g.plannerFailure.rawPath}`);
    if (g.artifacts?.screenshot) lines.push(`      screenshot: ${g.artifacts.screenshot}`);
  }

  return lines.join("\n");
}

export async function writeJsonReport(report: SweepReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}
