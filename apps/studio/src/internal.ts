import { Router } from "express";
import type { Response } from "express";
import { INTERNAL_SECRET_HEADER, errorBanner } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import {
  streamApp,
  createTrailingFenceGuard,
  planApp,
  streamFill,
  createSlotStream,
  isAbortError,
} from "@any-app/generator";
import {
  getGeneration,
  claimForGeneration,
  markComplete,
  markCompleteWithPlan,
  markFailed,
  resetForRetry,
  requireEnv,
} from "@any-app/store";
import { renderShellHead, SHELL_TAIL } from "./shell";

export const internalRouter: Router = Router();

// Browsers buffer roughly the first kilobyte of an HTML response before they begin
// parsing. Without this padding the page stays blank until enough content has arrived,
// which looks exactly like broken streaming. The doctype goes first so the document
// does not fall into quirks mode. Only the linear fallback path still needs this — the
// planned shell below is comfortably past the buffer on its own.
const DOCTYPE_AND_PADDING = `<!doctype html>\n<!--${" ".repeat(1024)}-->\n`;

internalRouter.use((req, res, next) => {
  if (req.get(INTERNAL_SECRET_HEADER) !== requireEnv("INTERNAL_SECRET")) {
    res.status(403).send("forbidden");
    return;
  }
  next();
});

internalRouter.get("/generations/:id/stream", async (req, res) => {
  const id = req.params.id;
  const generation = await getGeneration(id);

  if (!generation) {
    res.status(404).send("not found");
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (generation.status === "complete" && generation.document) {
    res.send(generation.document);
    return;
  }

  // Claim the row before generating. Without this, a reload mid-generation — which is
  // not an edge case, it is what anyone does when a generation looks stuck — starts a
  // second, concurrent call for the same id.
  if (!(await claimForGeneration(id))) {
    res.send(
      DOCTYPE_AND_PADDING +
        `<meta http-equiv="refresh" content="2">
         <p style="font:15px system-ui;padding:24px;opacity:.6">Already generating…</p>`,
    );
    return;
  }

  // Abort both calls the moment the viewer disconnects, instead of continuing to pull
  // from the provider (and pay for it) for a response nobody will ever see.
  const ac = new AbortController();
  req.on("close", () => ac.abort());

  try {
    // --- Plan -------------------------------------------------------------------
    // Nothing is written to the response until this returns: the shell cannot be
    // rendered from half a stylesheet, and a partial shell cannot be taken back.
    let plan;
    try {
      plan = await planApp(generation.prompt, ac.signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.warn(`generation ${id}: planning failed, falling back to linear`, error);
      await runLinearFallback(id, generation.prompt, res, ac.signal);
      return;
    }

    // --- Shell + Fill -------------------------------------------------------------
    // `flat` accumulates exactly the bytes written to the response, in the order the
    // browser actually saw them. Saving *that* — rather than reconstructing an
    // equivalent-looking document from the plan and the collected slot content — is what
    // makes replay byte-identical to the live render: same script-then-slots ordering,
    // same swap() calls, same slot:ready events. Two code paths building "the same" page
    // is exactly how they quietly stop agreeing.
    res.flushHeaders();
    let flat = renderShellHead(plan);
    res.write(flat);

    const slotStream = createSlotStream();
    for await (const chunk of streamFill(generation.prompt, plan, ac.signal)) {
      const out = slotStream.push(chunk);
      if (out) {
        flat += out;
        res.write(out);
      }
    }
    const tail = slotStream.flush();
    if (tail) {
      flat += tail;
      res.write(tail);
    }
    flat += SHELL_TAIL;
    res.write(SHELL_TAIL);

    // --- Persist ----------------------------------------------------------------
    // Before ending the response, not after: ending it first would let `req`'s `close`
    // event fire and flip `ac.signal.aborted` to true, so a database failure right here
    // would be misread as the viewer having disconnected — discarding a generation that
    // actually succeeded instead of reporting the real error.
    //
    // `document` stays the flat assembled HTML so the replay path is unchanged. `plan`
    // carries the decomposed form for Phase 3 to edit slot by slot.
    const filled: FilledApp = { ...plan, content: slotStream.content };
    await markCompleteWithPlan(id, flat, filled);
    res.end();
  } catch (error) {
    if (isAbortError(error)) {
      // The viewer is gone and the socket is dead — there is nothing left to write.
      // A half-written document must never be saved as complete; put the row back so a
      // later request can retry it from scratch.
      await resetForRetry(id);
      return;
    }
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`generation ${id} failed:`, error);
    await markFailed(id, message);
    res.write(errorBanner(message));
    res.end();
  }
});

/**
 * Phase 1's single-call path, kept as the fallback for when planning fails or returns
 * something unparseable. A worse app beats a red banner.
 */
async function runLinearFallback(
  id: string,
  prompt: string,
  res: Response,
  signal: AbortSignal,
): Promise<void> {
  res.flushHeaders();
  res.write(DOCTYPE_AND_PADDING);

  const fenceGuard = createTrailingFenceGuard();
  let document = DOCTYPE_AND_PADDING;
  for await (const chunk of streamApp(prompt, signal)) {
    const safe = fenceGuard.push(chunk);
    if (safe) {
      document += safe;
      res.write(safe);
    }
  }
  const tail = fenceGuard.flush();
  document += tail;
  if (tail) res.write(tail);

  // Persist before ending, for the same reason as the plan/fill path above.
  await markComplete(id, document);
  res.end();
}
