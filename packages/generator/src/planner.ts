import {
  SLOT_ID_PATTERN,
  slotIdsInShell,
  COLLECTION_PATTERN,
  unmatchedSlotAttributes,
  sanitizePlaceholders,
} from "@any-app/protocol";
import type { AppPlan, SlotSpec, CollectionSpec } from "@any-app/protocol";
import { resolve } from "./resolve";
import type { ProviderCredential } from "./providers/types";
import type { UsageInfo } from "./providers/usage";
import { PLANNER_PROMPT } from "./planner-prompt";
import { parseSections } from "./section-parser";
import { stripTrailingFence } from "./fence-stripper";

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/** The `kind` field lets more diagnostics be added later; only placeholder stripping exists today. */
export interface PlanDiagnostic {
  kind: "stripped-placeholder-content";
  id: string;
  removed: string;
}

export function parsePlan(raw: string, onDiagnostic?: (d: PlanDiagnostic) => void): AppPlan {
  const sections = parseSections(stripTrailingFence(raw.replace(/^\s*```[a-z]*\n/, "")));

  const title = sections.TITLE?.trim();
  const css = sections.CSS;
  let shell = sections.SHELL;
  const script = sections.SCRIPT ?? "";
  const slotLines = sections.SLOTS;

  // Strict on purpose: an empty SLOTS body is what a truncated response looks like.
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

  // Safety net: strip content a model wrote inside a placeholder (fill overwrites it anyway).
  // The sanitised shell is the one that gets persisted.
  const sanitized = sanitizePlaceholders(shell);
  shell = sanitized.shell;
  for (const s of sanitized.stripped) {
    console.warn(
      `[parsePlan] stripped-placeholder-content: slot "${s.id}" had non-empty content in SHELL (${s.removed.length} chars removed)`,
    );
    onDiagnostic?.({ kind: "stripped-placeholder-content", id: s.id, removed: s.removed });
  }

  // The shell decides which slots exist and in what order.
  const inShell = slotIdsInShell(shell);
  if (inShell.length === 0) throw new PlanError("shell contains no slot placeholders");

  // A data-slot the scan rejected would silently vanish; PlanError falls back to the linear path.
  const unmatched = unmatchedSlotAttributes(shell);
  if (unmatched.length > 0) {
    throw new PlanError(
      `shell has data-slot attribute(s) that did not parse as placeholders: ${unmatched.join(", ")}`,
    );
  }

  // Duplicate ids would leave the second placeholder a permanent skeleton.
  const duplicates = inShell.filter((id, i) => inShell.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new PlanError(`shell repeats slot id(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  const specById = new Map(slots.map((s) => [s.id, s]));
  const ordered: SlotSpec[] = inShell.map(
    (id) => specById.get(id) ?? { id, height: 200, spec: "Content for this region." },
  );

  // Optional. A bad collection name is dropped rather than failing the whole plan.
  const collections: CollectionSpec[] = (sections.DATA ?? "")
    .split("\n")
    .map((line) => line.split("|"))
    .filter(([name]) => COLLECTION_PATTERN.test((name ?? "").trim()))
    .map(([name, ...rest]) => ({ name: name!.trim(), description: rest.join("|").trim() }));

  return { title, css, shell, script, slots: ordered, collections };
}

export async function planApp(
  prompt: string,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  // The generation id: same gateway conversation as every fill/edit of this app.
  conversationId?: string,
  // Fires with the raw text before parsePlan, so a PlanError can still be diagnosed. Never awaited.
  onRawResponse?: (raw: string) => void,
  onDiagnostic?: (d: PlanDiagnostic) => void,
  // Forwarded to the provider request; fires even when the call throws.
  onUsage?: (usage: UsageInfo) => void,
): Promise<AppPlan> {
  const { provider, model, maxTokens } = resolve("planner", credential);

  const raw = await provider.completeText(model, {
    system: PLANNER_PROMPT,
    user: prompt,
    maxTokens,
    signal,
    label: "planner",
    conversationId,
    onUsage,
  });
  onRawResponse?.(raw);

  return parsePlan(raw, onDiagnostic);
}
