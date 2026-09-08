import { Router } from "express";
import type { Response } from "express";
import { INTERNAL_SECRET_HEADER, errorBanner, renderDocument, slotOpen, slotClose, mintAppToken } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import {
  streamApp,
  createTrailingFenceGuard,
  planApp,
  streamFill,
  createSlotStream,
  fillAllSlots,
  isAbortError,
  resolve,
  NoCredentialError,
  safeMessage,
} from "@any-app/generator";
import type { ProviderCredential } from "@any-app/generator";
import {
  getGeneration,
  claimForGeneration,
  markComplete,
  markCompleteWithPlan,
  markFailed,
  resetForRetry,
  requireEnv,
} from "@any-app/store";
import { renderShellHead, renderFullHead, DOCTYPE_AND_PADDING, SHELL_TAIL } from "./shell";
import { sessionId } from "./session";
import { credentialForRole } from "./credential-resolve";

export function internalRouter(studioOrigin: string): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (req.get(INTERNAL_SECRET_HEADER) !== requireEnv("INTERNAL_SECRET")) {
      res.status(403).send("forbidden");
      return;
    }
    next();
  });

  router.get("/generations/:id/stream", async (req, res) => {
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

    // Session-scoped credentials, resolved once up front. `resolve()` throws before any
    // HTTP call if a role's configured provider has no credential anywhere (session or
    // platform) — catching that here, before a byte is written, is what "an unconfigured
    // role fails before any HTTP call" (Phase 3.5 acceptance) actually means. It also
    // gathers every secret that could appear in a later error, for the scrub in the catch
    // block below — planner and fill can be different providers with different keys.
    const sid = sessionId(req, res);
    const plannerCred = await credentialForRole("planner", sid);
    const fillCred = await credentialForRole("fill", sid);
    let secrets: string[];
    try {
      secrets = [...resolve("planner", plannerCred).secrets, ...resolve("fill", fillCred).secrets];
    } catch (error) {
      if (error instanceof NoCredentialError) {
        await resetForRetry(id);
        res.send(DOCTYPE_AND_PADDING + errorBanner(error.message));
        return;
      }
      throw error;
    }

    try {
      // --- Plan -------------------------------------------------------------------
      // The doctype goes out immediately, before planning even starts — undici's ~300s
      // inactivity timeout does not care that we have a good reason to be quiet, and a
      // reasoning-heavy planner model can take that long. The heartbeat comment is
      // live-only noise: it is never folded into `flat` below, because a replay of a
      // *finished* generation has no planning wait to fill.
      res.flushHeaders();
      res.write(DOCTYPE_AND_PADDING);
      const heartbeat = setInterval(() => res.write("<!-- planning -->\n"), 15_000);

      let plan;
      try {
        plan = await planApp(generation.prompt, plannerCred, ac.signal, id);
      } catch (error) {
        if (isAbortError(error)) throw error;
        // Scrubbed even though this is a console line, not a stored or rendered one — a
        // raw provider error can quote a credential back (confirmed historically; see
        // scrub.ts), and `secrets` is already in hand here regardless of which provider
        // actually threw.
        console.warn(`generation ${id}: planning failed, falling back to linear:`, safeMessage(error, secrets));
        await runLinearFallback(id, generation.prompt, fillCred, res, ac.signal);
        return;
      } finally {
        clearInterval(heartbeat);
      }

      // --- Shell ---------------------------------------------------------------------
      // Derived, not looked up — see mintAppToken's doc comment. Minting it here and again
      // in the persist step below (rather than caching it once) still reproduces the exact
      // same string, because it is a pure function of `id`.
      const appToken = mintAppToken(id, requireEnv("APP_TOKEN_SECRET"));
      res.write(renderShellHead(plan, studioOrigin, appToken));

      // --- Fill ------------------------------------------------------------------
      // Two modes, switchable via LLM_FILL_MODE without a code change, specifically so
      // parallel fan-out output can be compared against Phase 3.5's single coherent call —
      // one call can make every region agree by construction, N calls cannot.
      // Defaults to sequential, not the plan's literal "parallel" default — Phase 4's own
      // measurement found parallel slower and ~5.6x more completion tokens on this
      // project's model (see .docs/open-problems.md). A fresh clone should not silently run
      // the mode the phase concluded is currently a regression.
      const fillMode = (process.env.LLM_FILL_MODE ?? "sequential").toLowerCase();
      let filled: FilledApp;

      if (fillMode === "sequential") {
        // Unchanged from Phase 3.5: one call, slots land in plan order, any failure here
        // fails the whole document (caught by the outer catch below, same as before).
        const slotStream = createSlotStream();
        for await (const chunk of streamFill(generation.prompt, plan, fillCred, ac.signal, id)) {
          const out = slotStream.push(chunk);
          if (out) res.write(out);
        }
        const tail = slotStream.flush();
        if (tail) res.write(tail);
        filled = { ...plan, content: slotStream.content };
      } else {
        // Slots can all be in flight for a while with nothing written — same undici
        // inactivity problem the planner heartbeat solves, same fix.
        const concurrency = Number(process.env.LLM_FILL_CONCURRENCY ?? 4);
        const content: Record<string, string> = {};
        let succeeded = 0;
        const fillHeartbeat = setInterval(() => res.write("<!-- filling -->\n"), 15_000);
        try {
          for await (const result of fillAllSlots(
            generation.prompt,
            plan,
            fillCred,
            concurrency,
            ac.signal,
            id,
          )) {
            content[result.slot.id] = result.html;
            if (!result.failed) succeeded++;
            // One write, not `slotOpen` then `html` then `slotClose` separately — a
            // <template> must be contiguous in the response.
            res.write(slotOpen(result.slot.id) + result.html + slotClose(result.slot.id));
          }
        } finally {
          clearInterval(fillHeartbeat);
        }

        if (succeeded === 0) {
          // A shell full of apologies is not a generated app.
          res.write(SHELL_TAIL);
          await markFailed(id, "every region failed to generate");
          res.end();
          return;
        }
        filled = { ...plan, content };
      }

      res.write(SHELL_TAIL);

      // --- Persist ----------------------------------------------------------------
      // Before ending the response, not after: ending it first would let `req`'s `close`
      // event fire and flip `ac.signal.aborted` to true, so a database failure right here
      // would be misread as the viewer having disconnected — discarding a generation that
      // actually succeeded instead of reporting the real error.
      //
      // `renderFullHead` is the same function editing uses (edits.ts) — one producer of
      // "the document" either way. `plan` carries the decomposed form both read.
      //
      // No streamed-vs-rendered consistency check here anymore (Phase 3's `flat`/
      // `document !== flat`) — completion order means the parallel path's live bytes and
      // `renderDocument`'s plan-ordered output are no longer expected to match, and that is
      // correct: swap() has always been order-independent.
      const document = renderDocument(filled, (p) => renderFullHead(p, studioOrigin, appToken), SHELL_TAIL);
      await markCompleteWithPlan(id, document, filled);
      res.end();
    } catch (error) {
      if (isAbortError(error)) {
        // The viewer is gone and the socket is dead — there is nothing left to write.
        // A half-written document must never be saved as complete; put the row back so a
        // later request can retry it from scratch.
        await resetForRetry(id);
        return;
      }
      const message = safeMessage(error, secrets);
      console.error(`generation ${id} failed:`, message);
      await markFailed(id, message);
      res.write(errorBanner(message));
      res.end();
    }
  });

  return router;
}

/**
 * Phase 1's single-call path, kept as the fallback for when planning fails or returns
 * something unparseable. A worse app beats a red banner.
 *
 * The doctype and `res.flushHeaders()` already happened in the caller (see the heartbeat
 * comment above) — this continues the same response, it does not start a new one.
 */
async function runLinearFallback(
  id: string,
  prompt: string,
  credential: ProviderCredential | null,
  res: Response,
  signal: AbortSignal,
): Promise<void> {
  const fenceGuard = createTrailingFenceGuard();
  let document = DOCTYPE_AND_PADDING;
  for await (const chunk of streamApp(prompt, credential, signal, id)) {
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
