/**
 * Turns the raw per-generation results the runner accumulates into the two outputs the task
 * asks for: a readable stdout table, and a JSON file that can be diffed run over run.
 *
 * This module never runs anything and never decides pass/fail — it only aggregates
 * `CheckResult`s that `checks-doc.ts`/`checks-rendered.ts` already produced.
 */
import { writeFile } from "node:fs/promises";
import type { CheckResult } from "./checks-doc";

export type FillMode = "sequential" | "parallel";

export interface GenerationRecord {
  promptId: string;
  mode: FillMode;
  /** Wall-clock ms for the generation call itself (POST + drive-to-completion). */
  generationMs: number | null;
  /** Set when the whole generation attempt threw before any checks could run — network
   * failure, DB error, unexpected exception. The generation still counts in the totals; every
   * check for it is recorded as an "error" row rather than silently omitted (requirement 5:
   * partial results must survive one bad generation, not silently shrink the denominator). */
  attemptError: string | null;
  docChecks: CheckResult[];
  renderedChecks: CheckResult[];
  artifacts: { screenshot: string | null; html: string | null } | null;
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

function tallyChecks(records: GenerationRecord[], mode: FillMode, source: "doc" | "rendered"): CaseTally[] {
  const byId = new Map<string, CaseTally>();
  for (const rec of records) {
    if (rec.mode !== mode) continue;
    const checks = source === "doc" ? rec.docChecks : rec.renderedChecks;
    if (rec.attemptError) {
      // The generation itself never produced anything to check — every case this source
      // would have covered gets a hard "error" mark rather than being left out entirely.
      const ids = source === "doc" ? DOC_CASE_IDS : RENDERED_CASE_IDS;
      for (const id of ids) {
        const t = byId.get(id) ?? { id, label: id, pass: 0, fail: 0, skip: 0, error: 0 };
        t.error++;
        byId.set(id, t);
      }
      continue;
    }
    for (const c of checks) {
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
      tallyChecks(seq, "sequential", "doc"),
      tallyChecks(par, "parallel", "doc"),
    ),
  );
  lines.push("");
  lines.push(
    renderTable(
      "Frontend section F — generated-app quality (rendered)",
      tallyChecks(seq, "sequential", "rendered"),
      tallyChecks(par, "parallel", "rendered"),
    ),
  );
  lines.push("");
  lines.push("Per-generation detail:");
  for (const g of report.generations) {
    const durS = g.generationMs != null ? `${(g.generationMs / 1000).toFixed(0)}s` : "n/a";
    lines.push(`  [${g.mode}] ${g.promptId} (${durS})${g.attemptError ? "  *** ERRORED: " + g.attemptError : ""}`);
    if (!g.attemptError) {
      const failedDoc = g.docChecks.filter((c) => c.status === "fail").map((c) => c.id);
      const failedRendered = g.renderedChecks.filter((c) => c.status === "fail").map((c) => c.id);
      if (failedDoc.length) lines.push(`      doc fails: ${failedDoc.join(", ")}`);
      if (failedRendered.length) lines.push(`      rendered fails: ${failedRendered.join(", ")}`);
      if (!failedDoc.length && !failedRendered.length) lines.push("      all scored checks passed");
    }
    if (g.artifacts?.screenshot) lines.push(`      screenshot: ${g.artifacts.screenshot}`);
  }

  return lines.join("\n");
}

export async function writeJsonReport(report: SweepReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}
