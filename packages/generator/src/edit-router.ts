import type { AppPlan } from "@any-app/protocol";
import { getClient, getPlannerModel, isReasoningModel, logUsage } from "./client";

export type EditTarget = { kind: "css" } | { kind: "slot"; id: string };

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

const ROUTER_PROMPT = `You decide which part of a web app an edit request is about.

Reply with EXACTLY one line and nothing else — no explanation, no punctuation:

  css
  slot <id>

Choose "css" when the request is about appearance: colour, size, spacing, typography, theme, borders, shadows, or how things are laid out visually.

Choose "slot <id>" when the request is about what is inside one region: its wording, the items it lists, the controls it offers, or the structure of its markup.

When a request could be either, prefer "css" — the stylesheet controls every visual property, and region markup carries no styling of its own.`;

export async function routeEdit(
  instruction: string,
  plan: AppPlan,
  signal?: AbortSignal,
): Promise<EditTarget> {
  const regions = plan.slots.map((s) => `slot ${s.id} — ${s.spec}`).join("\n");

  const completion = await getClient().chat.completions.create(
    {
      model: getPlannerModel(),
      // A reasoning model burns part of this on hidden reasoning before writing its
      // one-line answer — the same failure mode documented for the planner and fill calls
      // (see client.ts's isReasoningModel and .docs/open-problems.md). The classification
      // task here is much smaller than planning a whole app, so this is a smaller budget
      // than the planner's, not zero extra room.
      max_tokens: isReasoningModel() ? 4000 : 20,
      messages: [
        { role: "system", content: ROUTER_PROMPT },
        { role: "user", content: `Regions:\n${regions}\n\nRequest: ${instruction}` },
      ],
    },
    { signal },
  );

  logUsage("router", completion.usage);

  const raw = (completion.choices[0]?.message?.content ?? "").trim().toLowerCase();
  if (raw === "css") return { kind: "css" };

  const match = /^slot\s+([a-z][a-z0-9-]{0,30})$/.exec(raw);
  if (match) {
    const id = match[1]!;
    if (plan.slots.some((s) => s.id === id)) return { kind: "slot", id };
    throw new RoutingError(`router chose unknown region "${id}"`);
  }

  throw new RoutingError(`router replied with "${raw.slice(0, 60)}"`);
}
