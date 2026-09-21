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
import { recordMessage } from "./conversation";

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

    // Server-to-server from the sandbox: no cookie. The view grant is the only signal of who is looking:
    // "rw" only for the owner, everything else is "ro"; a private app 404s without a valid grant.
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

    // An expired grant is surfaced rather than treated as "ro", which would silently downgrade an owner's open tab.
    if (forThisApp && grantResult.status === "expired") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      // Set here too: this early return would otherwise send the one HTML response without it.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(
        DOCTYPE_AND_PADDING +
          // Worded for shared visitors too: "open this app again" is wrong for someone who only has the link.
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
      // The stored document carries APP_TOKEN_PLACEHOLDER, never a live token: viewers of one row get different modes.
      res.send(withAppToken(generation.document, appToken));
      return;
    }

    // Before claiming the row, so a reload cannot slip past the cap by retrying before the claim.
    if (generation.owner_id) {
      const limit = await monthlyLimitFor(generation.owner_id);
      if (limit !== null && (await billableTokensThisMonth(generation.owner_id)) >= limit) {
        await markFailed(id, "Monthly token limit reached.");
        await recordMessage(id, { role: "assistant", kind: "error", body: "Monthly token limit reached." });
        res.send(DOCTYPE_AND_PADDING + errorBanner("Monthly token limit reached."));
        return;
      }
    }

    // Claim before generating: a reload mid-generation would otherwise start a second concurrent call.
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

    // Resolved once up front (throws before any HTTP call if a role has no credential).
    // Owner comes from the row: this request has no cookie, and currentOwner() on it minted a throwaway session
    // and never found the owner's own key (so BYOK generations were billed as platform).
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

    // Collected across the whole generation and written once at the end, win or lose. The generator only emits
    // via onUsage and does not touch the database.
    const usageEvents: UsageEvent[] = [];
    // A plain local: TS narrowing of `generation` does not reach the closure below.
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
        // Plan: the doctype goes out at once, before planning starts, because undici's ~300s inactivity timeout
        // counts silence. The heartbeat comment is live-only and never stored.
        res.flushHeaders();
        res.write(DOCTYPE_AND_PADDING);
        const heartbeat = setInterval(() => res.write("<!-- planning -->\n"), 15_000);

        let plan;
        let rawPlannerResponse: string | undefined;
        try {
          // Fires with the raw text before parsePlan, so it is set even when parsing then throws.
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
          // Scrubbed even in a console line: a provider error can quote the credential.
          console.warn(`generation ${id}: planning failed, falling back to linear:`, safeMessage(error, secrets));
          await capturePlannerFailure(id, error, rawPlannerResponse, secrets);
          await runLinearFallback(id, generation.prompt, fillCred, res, ac.signal, collector("linear", fillResolved));
          return;
        } finally {
          clearInterval(heartbeat);
        }

        // Shell: always the placeholder token. This viewer's live bytes get their real token substituted just
        // before the write; the stored document keeps the placeholder.
        res.write(withAppToken(renderShellHead(plan, studioOrigin), appToken));

        // Fill: LLM_FILL_MODE switches modes without a code change, to compare parallel fan-out with one coherent call.
        // Defaults to sequential: parallel measured slower and ~5.6x the tokens on this model.
        const fillMode = (process.env.LLM_FILL_MODE ?? "sequential").toLowerCase();
        let filled: FilledApp;

        if (fillMode === "sequential") {
          // One call, slots land in plan order; any failure fails the whole document (outer catch).
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
            await recordMessage(id, { role: "assistant", kind: "error", body: "Every region failed to generate." });
            res.end();
            return;
          }
          filled = { ...plan, content };
        }

        res.write(SHELL_TAIL);

        // Persist: before ending the response, since ending it fires `close` and would misread a database failure
        // as the viewer leaving. renderFullHead is what edits use too. No streamed-vs-rendered comparison
        // any more: swap() is order-independent, so completion order need not match plan order.
        const document = renderDocument(filled, (p) => renderFullHead(p, studioOrigin), SHELL_TAIL);
        await markCompleteWithPlan(id, document, filled);
        const regions = filled.slots.length;
        await recordMessage(id, {
          role: "assistant",
          kind: "create",
          body: `Built "${filled.title}" with ${regions} ${regions === 1 ? "region" : "regions"}.`,
        });
        res.end();
      } catch (error) {
        if (isAbortError(error)) {
          // The viewer is gone; a half-written document must not be saved as complete. Put the row back for retry.
          await resetForRetry(id);
          return;
        }
        const message = safeMessage(error, secrets);
        console.error(`generation ${id} failed:`, message);
        await markFailed(id, message);
        await recordMessage(id, { role: "assistant", kind: "error", body: message });
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
 * Diagnostic only: saves the raw text of a failed planner call when ANYAPP_PLANNER_RAW_DIR is set (a no-op
 * otherwise), so a PlanError can be diagnosed later. Never throws.
 */
async function capturePlannerFailure(
  id: string,
  error: unknown,
  raw: string | undefined,
  secrets: string[],
): Promise<void> {
  const dir = process.env.ANYAPP_PLANNER_RAW_DIR;
  // raw exists only when the provider returned text that parsePlan then rejected; the PlanError check states that.
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
 * Single-call fallback when planning fails: a worse app beats a red banner.
 * It continues the same response, whose doctype and headers were already sent.
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
  await recordMessage(id, { role: "assistant", kind: "create", body: "Built your app." });
  res.end();
}
