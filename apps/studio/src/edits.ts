import { Router } from "express";
import { renderDocument, isSlotErrorPlaceholder } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import {
  routeEdit,
  RoutingError,
  regenerateSlot,
  regenerateCss,
  regenerateShell,
  checkShellEdit,
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
import { beginEdit } from "./activity";
import { recordMessage } from "./conversation";

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

    // Ended in the `finally` below, AFTER the usage write — the delete route refuses an app
    // that is mid-edit, and an edit's usage rows carry a generation_id foreign key, so letting
    // a delete land between the model call and that write would make it fail and the tokens
    // never count against the monthly cap.
    const endEdit = beginEdit(id);
    // The follow-up is part of the conversation from the moment it is accepted, not when it
    // succeeds — a failed edit still leaves "you asked X" followed by why it did not happen.
    // `chosen` is only what the dropdown said; an auto-routed edit's target is not known yet.
    await recordMessage(id, { role: "user", kind: "edit", target: chosen || null, body: instruction });
    /** Records an edit failure in the conversation, then answers the request with it. */
    async function problem(status: number, message: string): Promise<void> {
      await recordMessage(id, { role: "assistant", kind: "error", target: chosen || null, body: message });
      res.status(status).type("html").send(editProblem(message));
    }
    try {
      // An explicit dropdown choice skips the router call entirely.
      let target;
      if (chosen === "css") {
        target = { kind: "css" as const };
      } else if (chosen === "@shell") {
        // "@" cannot begin a region id (SLOT_ID_PATTERN), so this can never collide with one.
        target = { kind: "shell" as const };
      } else if (chosen) {
        // The router's own answer is checked against plan.slots (edit-router.ts); a
        // hand-crafted POST with an unknown id must be checked the same way here, or it
        // writes an orphan key into `content` that renderDocument never renders and the
        // swap runtime never finds a slot for — a version bump and a paid model call for
        // no visible effect.
        if (!filled.slots.some((s) => s.id === chosen)) {
          await problem(400, `Unknown region "${chosen}".`);
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
          await problem(502, "That came back as a fragment, not the whole stylesheet. Try rephrasing, or try again.");
          return;
        }
        // An identical stylesheet means the model declined (the CSS prompt tells it to return
        // it untouched when the request needs a new control or behaviour) or the request was
        // already satisfied. Either way nothing changed, so do not save a new version or claim
        // "Updated styling." — that message on a no-op is exactly what made a failed "add a dark
        // theme switch" look like it had worked.
        if (after.trim() === before.trim()) {
          await problem(
            422,
            "The stylesheet came back unchanged. Styling can only change what is already there — if you asked for a new control or feature, pick the region that should hold it instead of Styling and ask again.",
          );
          return;
        }
        next.css = after;
      } else if (target.kind === "shell") {
        const before = filled.shell;
        const raw = await regenerateShell(instruction, filled, editCred, ac.signal, id, collector("edit-shell", editResolved));
        // Region placeholders must survive exactly (see checkShellEdit); a frame that loses or
        // duplicates one loses or duplicates a whole region, and it would be saved before
        // anyone saw it.
        const checked = checkShellEdit(filled, raw);
        if (!checked.ok) {
          console.warn(`edit ${id}: shell rewrite rejected: ${checked.problem}`);
          await problem(502, checked.problem);
          return;
        }
        if (looksTruncated(before, checked.shell)) {
          await problem(502, "That came back as a fragment, not the whole page frame. Try rephrasing, or try again.");
          return;
        }
        if (checked.shell.trim() === before.trim()) {
          await problem(422, "The page frame came back unchanged. Name the text or element you mean (for example the heading, subtitle or footer) and ask again.");
          return;
        }
        next.shell = checked.shell;
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
          await problem(502, "That came back as a fragment, not the whole region. Try rephrasing, or try again.");
          return;
        }
        // Nothing changed: not saved, not reported as an update. Found live — asked to remove a
        // caption that lives in the page frame, the router picked the nearest region three times
        // and each edit "succeeded" (new version, "Updated status-bar.") while changing nothing.
        if (after.trim() === before.trim()) {
          await problem(
            422,
            `Nothing changed in "${target.id}". What you mean may not be in that region — name the part you mean, or pick a different part of the page in the target list.`,
          );
          return;
        }
        next.content[target.id] = after;
      }

      // Always the placeholder token, never a live one — see shell.ts's renderShellHead doc
      // comment. Substitution happens per-viewer, at send time, in internal.ts.
      const document = renderDocument(next, (p) => renderFullHead(p, studioOrigin), SHELL_TAIL);

      if (!(await saveEditedApp(id, owner, next, document, version))) {
        await problem(409, "This app changed while your edit was running. Try again.");
        return;
      }

      const label = target.kind === "css" ? "styling" : target.kind === "shell" ? "the page frame" : target.id;
      await recordMessage(id, {
        role: "assistant",
        kind: "edit",
        target: target.kind === "slot" ? target.id : target.kind,
        body: `Updated ${label}.`,
      });
      res.type("html").send(editApplied(id, appOrigin(id), target, next));
    } catch (error) {
      if (isAbortError(error)) return;
      if (error instanceof RoutingError) {
        console.warn(`edit ${id}: routing failed`, error);
        // Not `problem()`: this answers 200 (the form's own "pick one" hint), unlike the failures above.
        const hint = "I could not tell which part to change — pick one below.";
        await recordMessage(id, { role: "assistant", kind: "error", body: hint });
        res.type("html").send(editProblem(hint));
        return;
      }
      const message = safeMessage(error, secrets);
      console.error(`edit ${id} failed:`, message);
      await problem(500, message);
    } finally {
      try {
        await recordUsage(usageEvents);
      } catch (error) {
        console.warn(`edit ${id}: failed to record usage:`, error);
      } finally {
        endEdit();
      }
    }
  });

  return router;
}
