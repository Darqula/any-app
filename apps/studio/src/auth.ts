import { Router } from "express";
import { createUser, authenticate, claimAnonymousWork } from "@any-app/store";
import { currentOwner, signInAs, signOut } from "./session";

/**
 * `express.urlencoded({ extended: false })` is already mounted in `index.ts`, so form posts
 * work with no new middleware.
 */
export function authRouter(): Router {
  const router = Router();

  router.post("/signup", async (req, res) => {
    const email = String(req.body.email ?? "").trim();
    const password = String(req.body.password ?? "");
    if (!email.includes("@") || password.length < 8) {
      res.status(400).type("html").send(`<p class="problem">Enter an email and a password of at least 8 characters.</p>`);
      return;
    }
    const before = await currentOwner(req, res);
    const user = await createUser(email, password);
    if (!user) {
      res.status(409).type("html").send(`<p class="problem">That email is already registered.</p>`);
      return;
    }
    // Claim BEFORE rotating: the work is keyed to the old session id.
    await claimAnonymousWork(before.sessionId, user.id);
    await signInAs(res, user.id, before.sessionId);
    res.setHeader("HX-Redirect", "/");
    res.status(200).end();
  });

  router.post("/signin", async (req, res) => {
    const before = await currentOwner(req, res);
    const user = await authenticate(String(req.body.email ?? ""), String(req.body.password ?? ""));
    if (!user) {
      res.status(401).type("html").send(`<p class="problem">Wrong email or password.</p>`);
      return;
    }
    // Deliberately NO claim here — a shared/kiosk browser signing in to an existing account
    // must not absorb whatever the previous person left in that anonymous session.
    await signInAs(res, user.id, before.sessionId);
    res.setHeader("HX-Redirect", "/");
    res.status(200).end();
  });

  router.post("/signout", async (req, res) => {
    const owner = await currentOwner(req, res);
    await signOut(res, owner.sessionId);
    res.setHeader("HX-Redirect", "/");
    res.status(200).end();
  });

  return router;
}
