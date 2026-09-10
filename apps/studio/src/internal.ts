import { Router } from "express";
import type { Response } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INTERNAL_SECRET_HEADER,
  errorBanner,
  renderDocument,
  slotOpen,
  slotClose,
  mintAppToken,
  withAppToken,
  verifyViewGrant,
} from "@any-app/protocol";
import type { FilledApp, TokenMode } from "@any-app/protocol";
import {
  streamApp,
  createTrailingFenceGuard,
  planApp,
  PlanError,
  streamFill,
  createSlotStream,
  fillAllSlots,
  isAbortError,
  resolve,
  NoCredentialError,
  safeMessage,
  scrub,
} from "@any-app/generator";
import type { ProviderCredential, Resolved, UsageInfo } from "@any-app/generator";
import {
  getGeneration,
  claimForGeneration,
  markComplete,
  markCompleteWithPlan,
  markFailed,
  resetForRetry,
  requireEnv,
  recordUsage,
  billableTokensThisMonth,
  monthlyLimitFor,
} from "@any-app/store";
import type { UsageEvent, Owner } from "@any-app/store";
import { renderShellHead, renderFullHead, DOCTYPE_AND_PADDING, SHELL_TAIL } from "./shell";
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

    // No cookie reaches this route — it is a server-to-server call from the sandbox, never
    // the browser directly (see architecture.md decision #10). The view grant is the only
    // signal about who is looking and what they may do: `mode: "rw"` only when studio's
    // frame route (which DOES know the viewer) decided this viewer is the app's owner; every
    // other case — a shared visitor, a missing/invalid grant — is treated as `"ro"`.
    // Private apps additionally 404 outright without a valid grant for this exact id.
    const grantParam = typeof req.query.g === "string" ? req.query.g : "";
    const grantResult = grantParam
      ? verifyViewGrant(grantParam, requireEnv("APP_TOKEN_SECRET"))
      : ({ status: "invalid" } as const);
    // A grant's appId must match THIS app's id — a grant that verified fine for a DIFFERENT
    // app (see view-grant.test.ts / M6) is exactly as useless here as no grant at all.
    const forThisApp = grantResult.status !== "invalid" && grantResult.appId === id;
    const granted = forThisApp && grantResult.status === "valid";
    if (generation.visibility === "private" && !granted) {
      res.status(404).send("not found");
      return;
    }

    // An expired-but-well-signed grant for THIS app is a different
    // situation from no grant at all — it used to fall through to the same `mode: "ro"`
    // default, so an owner's tab left open past VIEW_GRANT_TTL_MS with the page never
    // reloaded would silently start answering read-only to its own writes on an unlisted/
    // public app, with nothing on screen to explain why. (A private app can't reach this
    // branch — it already 404'd above, which is visible and reads as an error.) Surface it
    // instead of guessing.
    if (forThisApp && grantResult.status === "expired") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      // Set here too, not only after this early return —
      // this used to be the one HTML response the studio sent without it.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(
        DOCTYPE_AND_PADDING +
          // Owner-shaped advice ("open this app again") is wrong for a shared visitor, who
          // has no any-app of their own to go back to — their only route back is the link
          // they were sent. Phrased to work for both.
          `<p style="font:15px system-ui;padding:24px">This preview link has expired. ` +
          `Reload the page you got this link from, or ask its owner for a new one.</p>`,
      );
      return;
    }

    const mode: TokenMode = granted && grantResult.status === "valid" && grantResult.mode === "rw" ? "rw" : "ro";
    const appToken = mintAppToken(id, mode, requireEnv("APP_TOKEN_SECRET"));

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (generation.status === "complete" && generation.document) {
      // The stored document carries APP_TOKEN_PLACEHOLDER, never a live token (Phase 6 step
      // 7) — the same row is replayed to every viewer, and viewers get different modes.
      res.send(withAppToken(generation.document, appToken));
      return;
    }

    // Enforced before claimForGeneration: no point locking the row for a generation attempt
    // that is about to be refused, and a reload must not be able to slip past the cap by
    // retrying before the row is claimed.
    if (generation.owner_id) {
      const limit = await monthlyLimitFor(generation.owner_id);
      if (limit !== null && (await billableTokensThisMonth(generation.owner_id)) >= limit) {
        await markFailed(id, "Monthly token limit reached.");
        res.send(DOCTYPE_AND_PADDING + errorBanner("Monthly token limit reached."));
        return;
      }
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

    // Credentials resolved once up front — `resolve()` throws before any HTTP call if a
    // role's configured provider has no credential anywhere.
    //
    // No cookie reaches this route — it is a server-to-server call from
    // the sandbox, never the browser directly — so there is no session to read. An earlier
    // version of this line called `currentOwner(req, res)` anyway, which (on a cookie-less
    // request) always took the create-a-session branch: one throwaway `insert into sessions`
    // row per generation attempt, never read again, plus a `Set-Cookie` on an internal
    // response (harmless only because the sandbox never forwards upstream headers). Worse
    // than the wasted row: it meant a signed-in user's own BYOK credential could never be
    // found here even though `generation.owner_id` names exactly whose key to look for — so
    // a real generation on a user's own key was billed to them as if the platform paid for
    // it. The row already knows who owns it; derive Owner from THAT, not from a request that
    // structurally cannot carry one.
    const owner: Owner = generation.owner_id
      ? { kind: "user", userId: generation.owner_id, sessionId: "" }
      : { kind: "anon", sessionId: generation.session_id ?? "" };
    const plannerCred = await credentialForRole("planner", owner);
    const fillCred = await credentialForRole("fill", owner);
    let plannerResolved: Resolved;
    let fillResolved: Resolved;
    let secrets: string[];
    try {
      plannerResolved = resolve("planner", plannerCred);
      fillResolved = resolve("fill", fillCred);
      secrets = [...plannerResolved.secrets, ...fillResolved.secrets];
    } catch (error) {
      if (error instanceof NoCredentialError) {
        await resetForRetry(id);
        res.send(DOCTYPE_AND_PADDING + errorBanner(error.message));
        return;
      }
      throw error;
    }

    // Collected across the whole generation (planner, then fill — sequential or parallel)
    // and written once at the end, win or lose — packages/generator must not write to the
    // database, so it only emits via onUsage; this route persists. See usage.ts's ordering
    // invariant: a call that throws (e.g. TruncationError) still reaches onUsage before the
    // throw in both adapters, so it is captured here regardless of how the generation ends.
    const usageEvents: UsageEvent[] = [];
    // Captured into a plain local, not read as `generation.owner_id` inside the closure
    // below — `generation`'s null-check narrowing does not survive into a nested function
    // body, since TS can't prove the closure only runs after the check above.
    const generationOwnerId = generation.owner_id;
    function collector(role: string, resolved: Resolved): (usage: UsageInfo) => void {
      return (usage) => {
        usageEvents.push({
          ownerId: generationOwnerId,
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
    async function flushUsage(): Promise<void> {
      try {
        await recordUsage(usageEvents);
      } catch (error) {
        console.warn(`generation ${id}: failed to record usage:`, error);
      }
    }

    try {
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
        let rawPlannerResponse: string | undefined;
        try {
          // `onRawResponse` fires with the exact provider text before `parsePlan` is even
          // attempted (planner.ts), so it is populated here whenever the call reached a
          // response at all — including the case below where `parsePlan` then throws.
          plan = await planApp(
            generation.prompt,
            plannerCred,
            ac.signal,
            id,
            (raw) => {
              rawPlannerResponse = raw;
            },
            undefined,
            collector("planner", plannerResolved),
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          // Scrubbed even though this is a console line, not a stored or rendered one — a
          // raw provider error can quote a credential back (confirmed historically; see
          // scrub.ts), and `secrets` is already in hand here regardless of which provider
          // actually threw.
          console.warn(`generation ${id}: planning failed, falling back to linear:`, safeMessage(error, secrets));
          await capturePlannerFailure(id, error, rawPlannerResponse, secrets);
          await runLinearFallback(id, generation.prompt, fillCred, res, ac.signal, collector("linear", fillResolved));
          return;
        } finally {
          clearInterval(heartbeat);
        }

        // --- Shell ---------------------------------------------------------------------
        // Always the placeholder — see renderShellHead's doc comment. The live bytes going
        // to THIS viewer get the real, per-viewer token substituted in immediately before
        // the write; the stored document (below, at persist time) keeps the placeholder.
        res.write(withAppToken(renderShellHead(plan, studioOrigin), appToken));

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
          for await (const chunk of streamFill(generation.prompt, plan, fillCred, ac.signal, id, collector("fill", fillResolved))) {
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
              collector("fill", fillResolved),
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
        // "the document" either way. `plan` carries the decomposed form both read. Always
        // the placeholder token — see renderShellHead's doc comment.
        //
        // No streamed-vs-rendered consistency check here anymore (Phase 3's `flat`/
        // `document !== flat`) — completion order means the parallel path's live bytes and
        // `renderDocument`'s plan-ordered output are no longer expected to match, and that is
        // correct: swap() has always been order-independent.
        const document = renderDocument(filled, (p) => renderFullHead(p, studioOrigin), SHELL_TAIL);
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
    } finally {
      await flushUsage();
    }
  });

  return router;
}

/**
 * Diagnostic-only capture of a failed planner call, so a `PlanError` can be read back after
 * the fact instead of only surviving as one scrubbed line in the server's console output
 * (the gap this closes — see `.docs/open-problems.md`'s sweep history: `PlanError` moved
 * between the last two sweeps and answering "why" needed a separate paid probe run because
 * the sweep itself threw the raw response away).
 *
 * Gated behind `ANYAPP_PLANNER_RAW_DIR`, unset by default. This is a deliberate choice among
 * three considered: (1) logging the raw response unconditionally is simplest but dumps whole
 * model responses into normal server output on every failure — too noisy for `npm run dev`;
 * (2) persisting it on the `generations` row makes it permanently reachable but conflates
 * diagnostic data with product data and grows a row for a case the row does not otherwise
 * need to describe (the row already correctly reflects the *linear* result that was actually
 * served); (3) an env var that only a diagnostic run sets — chosen — keeps production
 * silent (this whole function is a no-op unless the var is set, so `npm run dev` behavior is
 * byte-for-byte unchanged) while making the exact failing text recoverable from disk right
 * next to the run that produced it. `tests/quality/runner.ts` sets this var to the current
 * run's artifact directory; see `tests/quality/README.md`.
 *
 * Never throws — a failure to write this diagnostic file must not turn a recoverable
 * planning failure (which still has a working linear-fallback path) into a hard failure.
 */
async function capturePlannerFailure(
  id: string,
  error: unknown,
  raw: string | undefined,
  secrets: string[],
): Promise<void> {
  const dir = process.env.ANYAPP_PLANNER_RAW_DIR;
  // `raw` is only populated when the provider call actually returned text that `parsePlan`
  // then rejected (planner.ts's `onRawResponse` fires before `parsePlan` is attempted) — so
  // this also naturally skips network/abort failures that never reached a response, not just
  // errors of the wrong type. The `PlanError` check documents that intent explicitly rather
  // than relying on `raw`'s absence alone.
  if (!dir || raw === undefined || !(error instanceof PlanError)) return;
  try {
    await mkdir(dir, { recursive: true });
    const payload = {
      generationId: id,
      at: new Date().toISOString(),
      reason: safeMessage(error, secrets),
      raw: scrub(raw, secrets),
    };
    await writeFile(path.join(dir, `planner-fail-${id}.json`), JSON.stringify(payload, null, 2), "utf8");
  } catch (writeError) {
    console.warn(`generation ${id}: failed to write planner raw-response capture:`, String(writeError));
  }
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
  onUsage: (usage: UsageInfo) => void,
): Promise<void> {
  const fenceGuard = createTrailingFenceGuard();
  let document = DOCTYPE_AND_PADDING;
  for await (const chunk of streamApp(prompt, credential, signal, id, onUsage)) {
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
