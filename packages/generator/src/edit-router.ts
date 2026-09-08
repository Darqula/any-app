import type { AppPlan } from "@any-app/protocol";
import { resolve } from "./resolve";
import { RefusalError, TruncationError } from "./providers/types";
import type { ProviderCredential } from "./providers/types";
import { safeMessage } from "./scrub";

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
  // The generation id — see planApp's matching parameter. Edits reuse the same conversation
  // the app's own generation used, so a routed edit can still hit the cached prefix.
  conversationId?: string,
): Promise<EditTarget> {
  // `regions` is stable across every routed edit against this app in one session — this is
  // exactly the repeated-prefix shape confirmed live during Phase 3.5 testing (two router
  // calls, identical system+context, cache_read_input_tokens stayed 0 — because context
  // wasn't wired up yet; see open-problems.md). Only `instruction` is genuinely volatile.
  const regions = plan.slots.map((s) => `slot ${s.id} — ${s.spec}`).join("\n");
  const { provider, model, maxTokens, secrets } = resolve("router", credential);

  let response: string;
  try {
    response = await provider.completeText(model, {
      system: ROUTER_PROMPT,
      context: `Regions:\n${regions}`,
      user: `Request: ${instruction}`,
      maxTokens,
      signal,
      label: "router",
      conversationId,
    });
  } catch (error) {
    // A truncated router reply is not a provider failure the caller should see as a raw
    // 500 — it genuinely means "we could not determine the target," exactly what
    // RoutingError means, and edits.ts already turns that into the friendly retry prompt.
    // Only this call is treated this way (testing-review.md S14's regression); nothing
    // upstream of routeEdit gets a blanket TruncationError catch.
    if (error instanceof TruncationError) {
      console.warn(
        `router: reply truncated at max_tokens=${maxTokens} before it produced a usable answer —`,
        safeMessage(error, secrets),
      );
      throw new RoutingError(`router reply truncated at max_tokens=${maxTokens} (not an unparseable answer)`);
    }
    // Same reasoning as the TruncationError case above, for the sibling failure mode: on
    // this project's configured (heavily-reasoning) model, hidden reasoning consuming the
    // whole budget before any visible output is *more* likely than a mid-answer cutoff, and
    // it also means "we could not determine the target." Discriminate on RefusalError's
    // typed `kind`, not on `reason` text — `kind: "empty"` is the "no content, no explicit
    // refusal signal" case; `kind: "declined"` (content_filter, Anthropic's stop_reason:
    // "refusal") is a real decline and must propagate untouched, not be disguised as "I
    // couldn't tell which part to change."
    if (error instanceof RefusalError && error.kind === "empty") {
      console.warn(`router: reply was empty (no content, no explicit refusal) —`, safeMessage(error, secrets));
      throw new RoutingError(`router reply was empty at max_tokens=${maxTokens} (not an unparseable answer)`);
    }
    throw error;
  }

  const raw = response.trim().toLowerCase();

  if (raw === "css") return { kind: "css" };

  const match = /^slot\s+([a-z][a-z0-9-]{0,30})$/.exec(raw);
  if (match) {
    const id = match[1]!;
    if (plan.slots.some((s) => s.id === id)) return { kind: "slot", id };
    throw new RoutingError(`router chose unknown region "${id}"`);
  }

  throw new RoutingError(`router replied with "${raw.slice(0, 60)}"`);
}
