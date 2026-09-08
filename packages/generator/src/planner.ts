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
import { PLANNER_PROMPT } from "./planner-prompt";
import { parseSections } from "./section-parser";
import { stripTrailingFence } from "./fence-stripper";

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/** One diagnostic `parsePlan` can report through its optional callback. Only one kind exists
 * today (`sanitizePlaceholders` stripping real content out of a placeholder); the `kind`
 * field is there so a future diagnostic can be added without changing this shape. */
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

  // Reverted (testing-review.md S5): an earlier version of this check read `slotLines ===
  // undefined` instead of `!slotLines`, on the theory that a SHELL whose placeholders are
  // all left to defaults is a valid plan with a legitimately-empty SLOTS body. Review caught
  // two problems with that: the "natural" reading of A4.2's spec (mirroring A4.3 exactly) is
  // one slot present and one omitted, not every slot omitted, and already passed under the
  // original `!slotLines` with no source change — so the change was never required. Worse,
  // a totally-empty SLOTS section is also exactly what a response truncated right after
  // `===SLOTS===` looks like (see open-problems.md's known truncation failure mode), and the
  // loosened check would have accepted that silently instead of raising `PlanError` and
  // falling back to the linear path — trading a loud, recoverable failure for a quiet
  // low-quality one, on this project's most fragile call. Kept strict; see A4.2's fixture
  // for the case this is actually meant to cover.
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

  // Deterministic safety net (not the primary repair — see sanitizePlaceholders' own doc
  // comment): strip real content the model wrote inside a data-slot element before the
  // unmatched-attribute check below runs, rather than reject the whole plan over it. Anything
  // stripped here was destined to be overwritten by the fill call anyway, so this cannot lose
  // content that was ever going to be user-visible. The SANITIZED shell — not the raw one — is
  // what continues through slotIdsInShell/unmatchedSlotAttributes below and what ends up in
  // the returned AppPlan, since it is what gets persisted and rendered.
  const sanitized = sanitizePlaceholders(shell);
  shell = sanitized.shell;
  for (const s of sanitized.stripped) {
    console.warn(
      `[parsePlan] stripped-placeholder-content: slot "${s.id}" had non-empty content in SHELL (${s.removed.length} chars removed)`,
    );
    onDiagnostic?.({ kind: "stripped-placeholder-content", id: s.id, removed: s.removed });
  }

  // The shell is the source of truth for which slots exist and in what order — it is what
  // actually gets rendered. A slot listed in SLOTS but absent from SHELL would never be
  // placed; one present in SHELL but absent from SLOTS gets a default-sized skeleton.
  const inShell = slotIdsInShell(shell);
  if (inShell.length === 0) throw new PlanError("shell contains no slot placeholders");

  // A region can vanish silently if it has a `data-slot="x"` attribute the tolerant scan
  // could not treat as a complete placeholder (real content inside the element, a mismatched
  // closing tag, a malformed quote) — that slot would just never be requested from fill and
  // never appear, with no error anywhere. Fail loudly instead: a PlanError here falls back to
  // the working linear path, which is strictly better than silently shipping a broken app.
  const unmatched = unmatchedSlotAttributes(shell);
  if (unmatched.length > 0) {
    throw new PlanError(
      `shell has data-slot attribute(s) that did not parse as placeholders: ${unmatched.join(", ")}`,
    );
  }

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

  // Optional, unlike every other section — most apps are static, and this is the common,
  // cheap case (see planner-prompt.ts's "if in doubt, leave it out"). A line that fails
  // COLLECTION_PATTERN is dropped rather than rejecting the whole plan; the model getting
  // one collection name wrong should not turn a good shell into a linear-fallback failure.
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
  // The generation id, so this call shares the opencode.ai gateway's `x-opencode-session`
  // conversation with every fill/edit call belonging to the same app — see
  // ProviderRequest.conversationId's doc comment.
  conversationId?: string,
  // Fired with the exact text the provider returned, BEFORE `parsePlan` is attempted — same
  // ordering `tests/quality/probe.ts` already uses ("write the raw response to disk FIRST").
  // Optional and synchronous-call-only (never awaited): a caller that doesn't care about the
  // raw text on a `PlanError` (i.e. everyone but `internal.ts`'s diagnostic capture) simply
  // omits it, and this function's behavior for them is unchanged byte-for-byte.
  onRawResponse?: (raw: string) => void,
  // Threaded straight through to parsePlan — see PlanDiagnostic's doc comment. Optional and
  // synchronous, same contract as onRawResponse; omitting it changes nothing.
  onDiagnostic?: (d: PlanDiagnostic) => void,
): Promise<AppPlan> {
  const { provider, model, maxTokens } = resolve("planner", credential);

  const raw = await provider.completeText(model, {
    system: PLANNER_PROMPT,
    user: prompt,
    maxTokens,
    signal,
    label: "planner",
    conversationId,
  });
  onRawResponse?.(raw);

  return parsePlan(raw, onDiagnostic);
}
