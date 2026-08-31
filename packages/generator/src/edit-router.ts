import type { AppPlan } from "@any-app/protocol";
import { resolve } from "./resolve";
import type { ProviderCredential } from "./providers/types";

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
  credential: ProviderCredential | null,
  signal?: AbortSignal,
): Promise<EditTarget> {
  // `regions` is stable across every routed edit against this app in one session — this is
  // exactly the repeated-prefix shape confirmed live during Phase 3.5 testing (two router
  // calls, identical system+context, cache_read_input_tokens stayed 0 — because context
  // wasn't wired up yet; see open-problems.md). Only `instruction` is genuinely volatile.
  const regions = plan.slots.map((s) => `slot ${s.id} — ${s.spec}`).join("\n");
  const { provider, model, maxTokens } = resolve("router", credential);

  const raw = (
    await provider.completeText(model, {
      system: ROUTER_PROMPT,
      context: `Regions:\n${regions}`,
      user: `Request: ${instruction}`,
      maxTokens,
      signal,
      label: "router",
    })
  )
    .trim()
    .toLowerCase();

  if (raw === "css") return { kind: "css" };

  const match = /^slot\s+([a-z][a-z0-9-]{0,30})$/.exec(raw);
  if (match) {
    const id = match[1]!;
    if (plan.slots.some((s) => s.id === id)) return { kind: "slot", id };
    throw new RoutingError(`router chose unknown region "${id}"`);
  }

  throw new RoutingError(`router replied with "${raw.slice(0, 60)}"`);
}
