import { Router } from "express";
import { build, roleConfig, safeMessage } from "@any-app/generator";
import type { ProviderId, Role } from "@any-app/generator";
import { saveCredential, listCredentialHints, deleteCredential } from "@any-app/store";
import { settingsPage, credentialSaved, editProblem } from "./views";
import { currentOwner } from "./session";

const PROVIDER_IDS: ProviderId[] = ["openai", "anthropic"];
const ROLES: Role[] = ["planner", "fill", "edit", "router"];

export function settingsRouter(): Router {
  const router = Router();

  router.get("/settings", async (req, res) => {
    const owner = await currentOwner(req, res);
    const hints = await listCredentialHints(owner);
    const roleRows = ROLES.map((role) => ({ role, ...roleConfig(role) }));
    res.type("html").send(settingsPage(hints, roleRows, owner));
  });

  router.post("/settings/credentials", async (req, res) => {
    const owner = await currentOwner(req, res);
    const provider = String(req.body.provider ?? "");
    const apiKey = String(req.body.apiKey ?? "").trim();
    const baseUrl = String(req.body.baseUrl ?? "").trim();
    const model = String(req.body.model ?? "").trim();

    if (!PROVIDER_IDS.includes(provider as ProviderId)) {
      res.status(400).type("html").send(editProblem("Unknown provider."));
      return;
    }
    if (!apiKey || !model) {
      res.status(400).type("html").send(editProblem("API key and a model to validate with are both required."));
      return;
    }

    const credential = { provider: provider as ProviderId, apiKey, baseUrl: baseUrl || undefined };

    try {
      // Validate before persisting — a bad key is rejected here, not discovered as a
      // failed generation minutes later.
      await build(credential).validate(model);
    } catch (error) {
      // The typed key is in no secrets list yet, so scrub it explicitly before showing the provider's error.
      res.status(400).type("html").send(editProblem(safeMessage(error, [apiKey])));
      return;
    }

    await saveCredential(owner, provider, apiKey, baseUrl || null);
    res.type("html").send(credentialSaved(provider));
  });

  router.delete("/settings/credentials/:provider", async (req, res) => {
    const owner = await currentOwner(req, res);
    await deleteCredential(owner, req.params.provider);
    res.type("html").send("");
  });

  return router;
}
