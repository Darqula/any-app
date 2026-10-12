import { Router } from "express";
import { build, roleConfig, safeMessage, checkProviderBaseUrl, describeValidationFailure, refusedAddress } from "@any-app/generator";
import type { ProviderId, Role } from "@any-app/generator";
import { saveCredential, listCredentialHints, deleteCredential } from "@any-app/store";
import { settingsPage, credentialSaved, editProblem } from "./views/index.ts";
import { sendHtml } from "./respond.ts";
import { currentOwner, accountEmail } from "./session.ts";

const PROVIDER_IDS: ProviderId[] = ["openai", "anthropic"];
const ROLES: Role[] = ["planner", "fill", "edit", "router"];

export function settingsRouter(): Router {
  const router = Router();

  router.get("/settings", async (req, res) => {
    const owner = await currentOwner(req, res);
    const hints = await listCredentialHints(owner);
    const roleRows = ROLES.map((role) => ({ role, ...roleConfig(role) }));
    sendHtml(res, settingsPage(hints, roleRows, owner, await accountEmail(owner)));
  });

  router.post("/settings/credentials", async (req, res) => {
    const owner = await currentOwner(req, res);
    const provider = String(req.body.provider ?? "");
    const apiKey = String(req.body.apiKey ?? "").trim();
    const baseUrl = String(req.body.baseUrl ?? "").trim();
    const model = String(req.body.model ?? "").trim();

    if (!PROVIDER_IDS.includes(provider as ProviderId)) {
      sendHtml(res, editProblem("Unknown provider."), 400);
      return;
    }
    if (!apiKey || !model) {
      sendHtml(res, editProblem("API key and a model to validate with are both required."), 400);
      return;
    }

    // A usability check only: a hostname can still resolve to an internal address. The connect-time guard in the
    // provider adapters is what keeps this process out of internal networks.
    const baseUrlProblem = baseUrl ? checkProviderBaseUrl(baseUrl) : null;
    if (baseUrlProblem) {
      sendHtml(res, editProblem(baseUrlProblem), 400);
      return;
    }

    const credential = { provider: provider as ProviderId, apiKey, baseUrl: baseUrl || undefined };

    try {
      // Validate before persisting — a bad key is rejected here, not discovered as a
      // failed generation minutes later.
      await build(credential, { userSupplied: true }).validate(model);
    } catch (error) {
      // The visitor gets a fixed sentence: the provider's own text would let a chosen URL read back whatever it
      // answers with. The detail goes to the log; the typed key is in no secrets list yet, so scrub it explicitly.
      const refused = refusedAddress(error);
      console.error("credential validation failed:", safeMessage(error, [apiKey]), refused ? `(refused address ${refused})` : "");
      sendHtml(res, editProblem(describeValidationFailure(error)), 400);
      return;
    }

    await saveCredential(owner, provider, apiKey, baseUrl || null);
    sendHtml(res, credentialSaved(provider));
  });

  router.delete("/settings/credentials/:provider", async (req, res) => {
    const owner = await currentOwner(req, res);
    await deleteCredential(owner, req.params.provider);
    res.type("html").send("");
  });

  return router;
}
