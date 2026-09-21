import type { AppPlan } from "@any-app/protocol";
import { resolve } from "./resolve";
import { RefusalError, TruncationError } from "./providers/types";
import type { ProviderCredential } from "./providers/types";
import type { UsageInfo } from "./providers/usage";
import { safeMessage } from "./scrub";

export type EditTarget = { kind: "css" } | { kind: "shell" } | { kind: "slot"; id: string };

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Routing history: an old "prefer css" tie-break sent "add a dark theme switch" to the stylesheet, and
 * the frame (heading, caption, footer) belongs to no region, so it needs its own answer.
 * Limit: a request needing both a control and its styling still gets one target.
 */
const ROUTER_PROMPT = `You decide which part of a web app an edit request is about.

Reply with EXACTLY one line and nothing else — no explanation, no punctuation:

  css
  slot <id>
  shell

The app has three kinds of part. The regions are listed under "Regions". The frame is the fixed markup around the regions — the page heading, subtitles and captions, footer lines, wrappers; it is shown under "The frame", and anything visible that is not inside a listed region lives there. The stylesheet controls how everything looks.

A stylesheet can only change how things that ALREADY EXIST look. It cannot add an element, and it cannot make anything happen. A region's own markup and script can do both.

Choose "css" when the request only changes the appearance of what is already on the page: colour, size, spacing, typography, borders, shadows, fonts, or how existing things are laid out. Changing the whole app's colour scheme ("make it dark", "use a green palette") is "css".

Choose "slot <id>" when the request is about content or behaviour: wording, the items a region lists, the structure of its markup — and ANYTHING that adds or changes a control or feature. That includes a button, switch, toggle, input, menu, filter, counter, timer, sorting, or any request phrased like "add a ...", "let the user ...", "show a ...", "make it so that ...". Pick the region where that control most naturally belongs, judging by the region descriptions.

When a request needs both a new control and a look for it (for example "add a dark mode switch"), choose the region that will hold the control — the control is what is missing. Styling for it can be requested afterwards.

Choose "shell" when the request is about text or elements in the frame: removing, rewording or adding a heading, subtitle, caption or footer line, or changing the wrappers around the regions. Look at the frame markup you are shown — if the text or element the request names appears there, the answer is "shell", not a region and not "css", even when a region's description sounds related.

Only when a request is genuinely vague and purely about looks ("make it nicer", "more modern") choose "css".`;

export async function routeEdit(
  instruction: string,
  plan: AppPlan,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  // The generation id — see planApp's matching parameter. Edits reuse the same conversation
  // the app's own generation used, so a routed edit can still hit the cached prefix.
  conversationId?: string,
  onUsage?: (usage: UsageInfo) => void,
): Promise<EditTarget> {
  // Stable across edits of one app (cacheable prefix, with the frame); only the instruction varies.
  const regions = plan.slots.map((s) => `slot ${s.id} — ${s.spec}`).join("\n");
  // The frame is stable across edits to one app until a shell edit lands, so it stays in the
  // cached `context` half with the regions.
  const { provider, model, maxTokens, secrets } = resolve("router", credential);

  let response: string;
  try {
    response = await provider.completeText(model, {
      system: ROUTER_PROMPT,
      context: `Regions:\n${regions}\n\nThe frame (fixed markup around the regions; each data-slot element is where a region goes):\n${plan.shell}`,
      user: `Request: ${instruction}`,
      maxTokens,
      signal,
      label: "router",
      conversationId,
      onUsage,
    });
  } catch (error) {
    // A truncated reply means "could not determine the target", which edits.ts turns into a retry hint.
    if (error instanceof TruncationError) {
      console.warn(
        `router: reply truncated at max_tokens=${maxTokens} before it produced a usable answer —`,
        safeMessage(error, secrets),
      );
      throw new RoutingError(`router reply truncated at max_tokens=${maxTokens} (not an unparseable answer)`);
    }
    // An empty reply (reasoning ate the budget) means the same. A real decline (kind "declined") must
    // propagate, so discriminate on kind, not on reason text.
    if (error instanceof RefusalError && error.kind === "empty") {
      console.warn(`router: reply was empty (no content, no explicit refusal) —`, safeMessage(error, secrets));
      throw new RoutingError(`router reply was empty at max_tokens=${maxTokens} (not an unparseable answer)`);
    }
    throw error;
  }

  const raw = response.trim().toLowerCase();

  if (raw === "css") return { kind: "css" };
  if (raw === "shell") return { kind: "shell" };

  const match = /^slot\s+([a-z][a-z0-9-]{0,30})$/.exec(raw);
  if (match) {
    const id = match[1]!;
    if (plan.slots.some((s) => s.id === id)) return { kind: "slot", id };
    throw new RoutingError(`router chose unknown region "${id}"`);
  }

  throw new RoutingError(`router replied with "${raw.slice(0, 60)}"`);
}
