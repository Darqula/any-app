import { Router } from "express";
import { renderDocument, isSlotErrorPlaceholder } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import {
  routeEdit,
  RoutingError,
  regenerateSlot,
  regenerateCss,
  fillSlot,
  isAbortError,
  resolve,
  NoCredentialError,
  safeMessage,
} from "@any-app/generator";
import type { Resolved, UsageInfo } from "@any-app/generator";
import {
  getFilledApp,
  saveEditedApp,
  getGeneration,
  recordUsage,
  monthlyLimitFor,
  billableTokensThisMonth,
} from "@any-app/store";
import type { UsageEvent } from "@any-app/store";
import { renderFullHead, SHELL_TAIL } from "./shell";
import { editApplied, editProblem } from "./views";
import { currentOwner } from "./session";
import { credentialForRole } from "./credential-resolve";

/**
 * Guards against a slot edit that came back as a diff-shaped fragment instead of the whole
 * region — confirmed live: asked to "add a small icon before the Search label" against a
 * multi-part filter bar, the model returned only `<label>...</label><input ...>`, silently
 * dropping every other control (including one a *previous* edit had just added). The prompt
 * already says "output the new HTML for that region and nothing else" and "this is an edit,
 * not a rewrite" — neither stopped it. A length-ratio heuristic is not a correctness proof,
 * but replacing a real region with an obvious fragment is worse than asking the user to
 * rephrase or retry, so this is a floor, not a tuned threshold.
 */
function looksTruncated(before: string, after: string): boolean {
  return before.length > 200 && after.length < before.length * 0.3;
}

export function editsRouter(studioOrigin: string, appOrigin: (id: string) => string): Router {
  const router = Router();

  router.post("/generations/:id/edits", async (req, res) => {
    const id = req.params.id;
    const instruction = String(req.body.instruction ?? "").trim();
    const chosen = String(req.body.target ?? "").trim();

    if (!instruction) {
      res.status(400).type("html").send(editProblem("Describe the change you want."));
      return;
    }

    const owner = await currentOwner(req, res);

    // internal.ts checks this before a fresh generation, but an edit
    // costs one or two model calls too (plus a whole fillSlot on the placeholder-recovery
    // branch) and was previously not checked here at all — an account over its cap could not
    // start a new generation but could still issue unlimited edits. Scoped to the EDITOR, not
    // the app's owner: the person spending the tokens is the one whose allowance it is, and
    // this route is only ever reachable by the owner anyway (see the getFilledApp check below).
    if (owner.kind === "user") {
      const limit = await monthlyLimitFor(owner.userId);
      if (limit !== null && (await billableTokensThisMonth(owner.userId)) >= limit) {
        res.status(503).type("html").send(editProblem("Monthly token limit reached."));
        return;
      }
    }

    // Owner-scoped — editing an app you don't own is the same class of bug as listing it in
    // your sidebar (see .docs/impl-phase-6.md step 2). A non-owner (including a shared
    // unlisted/public viewer) gets the same 404 a nonexistent app would.
    const loaded = await getFilledApp(id, owner);
    if (!loaded) {
      res.status(404).type("html").send(editProblem("This app cannot be edited yet."));
      return;
    }
    const { filled, version } = loaded;

    const ac = new AbortController();
    req.on("close", () => ac.abort());

    // Same reasoning as internal.ts: resolve every role this request might touch up front,
    // both to fail fast on a missing credential and to have the secrets ready for scrubbing
    // if a later provider error needs to be shown or stored.
    const routerCred = await credentialForRole("router", owner);
    const editCred = await credentialForRole("edit", owner);
    // Deliberately NOT resolving "fill" here too, even though the placeholder-recovery
    // branch below needs it: doing so eagerly would make every edit — including a plain CSS
    // edit that never touches a placeholder — fail if the fill role alone is misconfigured.
    // It's resolved (and its secrets folded in) only where it's actually used.
    let routerResolved: Resolved;
    let editResolved: Resolved;
    let secrets: string[];
    try {
      routerResolved = resolve("router", routerCred);
      editResolved = resolve("edit", editCred);
      secrets = [...routerResolved.secrets, ...editResolved.secrets];
    } catch (error) {
      if (error instanceof NoCredentialError) {
        res.status(503).type("html").send(editProblem(error.message));
        return;
      }
      throw error;
    }

    // Same "generator emits, studio persists" split as internal.ts — see usage.ts's ordering
    // invariant. `owner.userId` is null for an anonymous editor, which `recordUsage` accepts
    // (it just never counts toward any account's cap).
    const usageEvents: UsageEvent[] = [];
    function collector(role: string, resolved: Resolved): (usage: UsageInfo) => void {
      return (usage) => {
        usageEvents.push({
          ownerId: owner.kind === "user" ? owner.userId : null,
          generationId: id,
          role,
          provider: resolved.provider.id,
          model: resolved.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cacheReadTokens ?? 0,
          billable: resolved.usedPlatformCredential,
        });
      };
    }

    try {
      // An explicit dropdown choice skips the router call entirely.
      let target;
      if (chosen === "css") {
        target = { kind: "css" as const };
      } else if (chosen) {
        // The router's own answer is checked against plan.slots (edit-router.ts); a
        // hand-crafted POST with an unknown id must be checked the same way here, or it
        // writes an orphan key into `content` that renderDocument never renders and the
        // swap runtime never finds a slot for — a version bump and a paid model call for
        // no visible effect.
        if (!filled.slots.some((s) => s.id === chosen)) {
          res.status(400).type("html").send(editProblem(`Unknown region "${chosen}".`));
          return;
        }
        target = { kind: "slot" as const, id: chosen };
      } else {
        target = await routeEdit(instruction, filled, routerCred, ac.signal, id, collector("router", routerResolved));
      }

      const next: FilledApp = { ...filled, content: { ...filled.content } };
      if (target.kind === "css") {
        const before = filled.css;
        const after = await regenerateCss(instruction, filled, editCred, ac.signal, id, collector("edit-css", editResolved));
        // A truncated CSS edit is the riskier half of this guard, not an afterthought: a
        // short stylesheet does not damage one region like a short slot does, it unstyles
        // the whole app — and it would be saved before anyone sees it.
        if (looksTruncated(before, after)) {
          console.warn(
            `edit ${id}: css rewrite came back as ${after.length} chars against ${before.length} before — looks like a fragment, not a full stylesheet. Discarding.`,
          );
          res
            .status(502)
            .type("html")
            .send(editProblem("That came back as a fragment, not the whole stylesheet. Try rephrasing, or try again."));
          return;
        }
        next.css = after;
      } else {
        const before = filled.content[target.id] ?? "";
        // A placeholder is missing content, not content to edit — regenerateSlot would hand
        // the model an apology paragraph and its own prompt's "this is an edit, not a
        // rewrite" rule, which argues for keeping that paragraph intact. Fill it from
        // scratch instead, the same way the original generation would have.
        const slot = filled.slots.find((s) => s.id === target.id);
        const after = isSlotErrorPlaceholder(before) && slot
          ? await (async () => {
              const [generation, fillCred] = await Promise.all([
                getGeneration(id),
                credentialForRole("fill", owner),
              ]);
              const fillResolved = resolve("fill", fillCred);
              secrets = [...secrets, ...fillResolved.secrets];
              return fillSlot(
                fillResolved.provider,
                fillResolved.model,
                fillResolved.maxTokens,
                generation?.prompt ?? "",
                filled,
                slot,
                ac.signal,
                id,
                collector("fill", fillResolved),
              );
            })()
          : await regenerateSlot(instruction, filled, target.id, before, editCred, ac.signal, id, collector("edit-slot", editResolved));
        if (looksTruncated(before, after)) {
          console.warn(
            `edit ${id}: slot "${target.id}" came back as ${after.length} chars against ${before.length} before — looks like a fragment, not a full region. Discarding.`,
          );
          res
            .status(502)
            .type("html")
            .send(editProblem("That came back as a fragment, not the whole region. Try rephrasing, or try again."));
          return;
        }
        next.content[target.id] = after;
      }

      // Always the placeholder token, never a live one — see shell.ts's renderShellHead doc
      // comment. Substitution happens per-viewer, at send time, in internal.ts.
      const document = renderDocument(next, (p) => renderFullHead(p, studioOrigin), SHELL_TAIL);

      if (!(await saveEditedApp(id, owner, next, document, version))) {
        res
          .status(409)
          .type("html")
          .send(editProblem("This app changed while your edit was running. Try again."));
        return;
      }

      res.type("html").send(editApplied(id, appOrigin(id), target, next));
    } catch (error) {
      if (isAbortError(error)) return;
      if (error instanceof RoutingError) {
        console.warn(`edit ${id}: routing failed`, error);
        res
          .type("html")
          .send(editProblem("I could not tell which part to change — pick one below."));
        return;
      }
      const message = safeMessage(error, secrets);
      console.error(`edit ${id} failed:`, message);
      res.status(500).type("html").send(editProblem(message));
    } finally {
      try {
        await recordUsage(usageEvents);
      } catch (error) {
        console.warn(`edit ${id}: failed to record usage:`, error);
      }
    }
  });

  return router;
}
