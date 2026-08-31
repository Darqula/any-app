import { Router } from "express";
import { renderDocument } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import {
  routeEdit,
  RoutingError,
  regenerateSlot,
  regenerateCss,
  isAbortError,
  resolve,
  NoCredentialError,
  safeMessage,
} from "@any-app/generator";
import { getFilledApp, saveEditedApp } from "@any-app/store";
import { renderFullHead, SHELL_TAIL } from "./shell";
import { editApplied, editProblem } from "./views";
import { sessionId } from "./session";
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

export function editsRouter(studioOrigin: string): Router {
  const router = Router();

  router.post("/generations/:id/edits", async (req, res) => {
    const id = req.params.id;
    const instruction = String(req.body.instruction ?? "").trim();
    const chosen = String(req.body.target ?? "").trim();

    if (!instruction) {
      res.status(400).type("html").send(editProblem("Describe the change you want."));
      return;
    }

    const loaded = await getFilledApp(id);
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
    const sid = sessionId(req, res);
    const routerCred = await credentialForRole("router", sid);
    const editCred = await credentialForRole("edit", sid);
    let secrets: string[];
    try {
      secrets = [...resolve("router", routerCred).secrets, ...resolve("edit", editCred).secrets];
    } catch (error) {
      if (error instanceof NoCredentialError) {
        res.status(503).type("html").send(editProblem(error.message));
        return;
      }
      throw error;
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
        target = await routeEdit(instruction, filled, routerCred, ac.signal);
      }

      const next: FilledApp = { ...filled, content: { ...filled.content } };
      if (target.kind === "css") {
        const before = filled.css;
        const after = await regenerateCss(instruction, filled, editCred, ac.signal);
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
        const after = await regenerateSlot(instruction, filled, target.id, before, editCred, ac.signal);
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

      const document = renderDocument(next, (p) => renderFullHead(p, studioOrigin), SHELL_TAIL);

      if (!(await saveEditedApp(id, next, document, version))) {
        res
          .status(409)
          .type("html")
          .send(editProblem("This app changed while your edit was running. Try again."));
        return;
      }

      res.type("html").send(editApplied(id, target, next));
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
    }
  });

  return router;
}
