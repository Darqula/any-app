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
 * Rejects a slot edit that came back as a fragment: models have dropped every other control in a region.
 * A length floor, not a tuned threshold.
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

    // Edits cost tokens too, so the monthly cap applies to the editor, as it does to generations.
    if (owner.kind === "user") {
      const limit = await monthlyLimitFor(owner.userId);
      if (limit !== null && (await billableTokensThisMonth(owner.userId)) >= limit) {
        res.status(503).type("html").send(editProblem("Monthly token limit reached."));
        return;
      }
    }

    // Owner-scoped: a non-owner gets the same 404 as a missing app.
    const loaded = await getFilledApp(id, owner);
    if (!loaded) {
      res.status(404).type("html").send(editProblem("This app cannot be edited yet."));
      return;
    }
    const { filled, version } = loaded;

    const ac = new AbortController();
    req.on("close", () => ac.abort());

    // Resolve the roles up front: fail fast, and have the secrets ready for scrubbing.
    const routerCred = await credentialForRole("router", owner);
    const editCred = await credentialForRole("edit", owner);
    // "fill" is resolved lazily, only for placeholder recovery, so a misconfigured fill role does not
    // break every edit.
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

    // The generator emits usage, the studio persists it. Anonymous editors record with a null owner.
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

    // Ended in the finally, after the usage write: a delete in between would fail that write and skip the cap.
    const endEdit = beginEdit(id);
    // Recorded when accepted, not on success, so a failed edit still shows what was asked.
    await recordMessage(id, { role: "user", kind: "edit", target: chosen || null, body: instruction });
    async function problem(status: number, message: string): Promise<void> {
      await recordMessage(id, { role: "assistant", kind: "error", target: chosen || null, body: message });
      res.status(status).type("html").send(editProblem(message));
    }
    try {
      let target;
      if (chosen === "css") {
        target = { kind: "css" as const };
      } else if (chosen === "@shell") {
        // "@" cannot begin a region id (SLOT_ID_PATTERN), so this can never collide with one.
        target = { kind: "shell" as const };
      } else if (chosen) {
        // An unknown region id would write an orphan key into content and cost a model call for nothing.
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
        // A truncated stylesheet unstyles the whole app and would be saved before anyone sees it.
        if (looksTruncated(before, after)) {
          console.warn(
            `edit ${id}: css rewrite came back as ${after.length} chars against ${before.length} before — looks like a fragment, not a full stylesheet. Discarding.`,
          );
          await problem(502, "That came back as a fragment, not the whole stylesheet. Try rephrasing, or try again.");
          return;
        }
        // An identical stylesheet means the model declined or the request was already met. Say so; do not
        // save a version or report an update.
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
        // Regions must survive the rewrite, or a whole region is lost or duplicated.
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
        // A placeholder is missing content, not content to edit: fill it from scratch.
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
