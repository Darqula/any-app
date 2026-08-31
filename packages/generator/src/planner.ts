import { SLOT_ID_PATTERN, slotIdsInShell } from "@any-app/protocol";
import type { AppPlan, SlotSpec } from "@any-app/protocol";
import { resolve } from "./resolve";
import type { ProviderCredential } from "./providers/types";
import { PLANNER_PROMPT } from "./planner-prompt";
import { parseSections } from "./section-parser";
import { stripTrailingFence } from "./fence-stripper";

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

function parsePlan(raw: string): AppPlan {
  const sections = parseSections(stripTrailingFence(raw.replace(/^\s*```[a-z]*\n/, "")));

  const title = sections.TITLE?.trim();
  const css = sections.CSS;
  const shell = sections.SHELL;
  const script = sections.SCRIPT ?? "";
  const slotLines = sections.SLOTS;

  if (!title || !css || !shell || !slotLines) {
    throw new PlanError(
      `plan is missing sections (got: ${Object.keys(sections).join(", ") || "none"})`,
    );
  }

  const slots: SlotSpec[] = [];
  for (const line of slotLines.split("\n")) {
    if (!line.trim()) continue;
    const [rawId, rawHeight, ...rest] = line.split("|");
    const id = rawId?.trim() ?? "";
    if (!SLOT_ID_PATTERN.test(id)) continue;
    const height = Number.parseInt(rawHeight?.trim() ?? "", 10);
    slots.push({
      id,
      height: Number.isFinite(height) ? Math.min(Math.max(height, 40), 2000) : 200,
      spec: rest.join("|").trim(),
    });
  }

  // The shell is the source of truth for which slots exist and in what order — it is what
  // actually gets rendered. A slot listed in SLOTS but absent from SHELL would never be
  // placed; one present in SHELL but absent from SLOTS gets a default-sized skeleton.
  const inShell = slotIdsInShell(shell);
  if (inShell.length === 0) throw new PlanError("shell contains no slot placeholders");

  // Two placeholders sharing an id would render as two elements with the same DOM id —
  // swap() would only ever fill the first, leaving the second a permanent skeleton. Reject
  // it here rather than let it surface as an inexplicable stuck loading state.
  const duplicates = inShell.filter((id, i) => inShell.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new PlanError(`shell repeats slot id(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  const specById = new Map(slots.map((s) => [s.id, s]));
  const ordered: SlotSpec[] = inShell.map(
    (id) => specById.get(id) ?? { id, height: 200, spec: "Content for this region." },
  );

  return { title, css, shell, script, slots: ordered };
}

export async function planApp(
  prompt: string,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
): Promise<AppPlan> {
  const { provider, model, maxTokens } = resolve("planner", credential);

  const raw = await provider.completeText(model, {
    system: PLANNER_PROMPT,
    user: prompt,
    maxTokens,
    signal,
    label: "planner",
  });

  return parsePlan(raw);
}
