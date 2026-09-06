/**
 * Boots one scratch database and the real studio (`localhost:3000`) / sandbox
 * (`*.apps.localhost:3001`) origins once for the whole frontend run — see the README for
 * why this suite cannot use ephemeral ports the way the backend suite does.
 *
 * Playwright calls the function this file's default export returns as global teardown, in
 * the same process, so the scratch database and servers created here can be closed over
 * directly with no need for a second config entry or disk-persisted state.
 *
 * `HANDOFF_PATH` exists because that closure-capture trick only helps *this* process.
 * Playwright runs `globalSetup` in the test-runner process, then runs actual test files in
 * separate worker process(es) — a spec file has no way to reach back into `scratch` or
 * `servers` here. Every spec file that needs the scratch database's connection string (to
 * call `seedGeneration`/`seedFilledApp`, or to assert row counts/contents directly) reads
 * it back from this file in the OS temp dir, removed again in teardown. Plain disk I/O
 * sidesteps any question of whether env vars set here would be inherited by a worker
 * process.
 *
 * `appTokenSecret` is generated once, here, rather than left to `startServers`'s own
 * per-call random default — every spec file that mints an app token itself (via
 * `seedFilledApp`/`mintAppToken`, e.g. security.spec.ts's B9/B10, app-data.spec.ts's H
 * cases, settings.spec.ts's session-credential edit round trips) needs to reproduce
 * exactly the token this running server will accept.
 *
 * --- Isolated stacks for real generations (C2-C8, E1-E4/E6/E8, G9) -----------------------
 *
 * The server this file starts carries no provider credential — every case that needs a
 * REAL generation to stream through the fake provider (progressive.spec.ts's C2-C8,
 * error-states.spec.ts's E1-E4/E6/E8, settings.spec.ts's G9) cannot use it, and cannot use
 * a session-scoped BYOK credential either: `/internal/generations/:id/stream` (internal.ts)
 * is only ever reached via the sandbox's server-to-server `/preview/:id` proxy
 * (apps/sandbox/src/index.ts), which never forwards the browser's session cookie, so
 * `sessionId()` there always mints a fresh, credential-less session regardless of what the
 * browser's own session has saved — a saved BYOK credential can only ever reach the
 * edit/router roles (hit directly from the browser on the studio origin), never a fresh
 * generation's planner/fill. See this task's report for the full write-up.
 *
 * An earlier version of this file solved that by exposing a control channel that let a
 * spec file ask THIS process to restart the shared server pair mid-run with different env.
 * That mechanism turned out to be the actual source of this suite's flakiness (a restart
 * racing another file's assumptions about the shared server/database state) and has been
 * removed. The replacement is boring on purpose: each of those three files spins up its
 * OWN scratch database, its OWN fake provider, and its OWN studio/sandbox pair on
 * EPHEMERAL ports (`harness/db.ts` + `harness/fake-provider.ts` + `harness/servers.ts`,
 * exactly the shape the backend suite already uses) inside its own `test.beforeAll`/
 * `afterAll`, and navigates with an explicit absolute origin instead of relying on this
 * suite's shared `baseURL`. That pair never touches ports 3000/3001 and never touches this
 * file's scratch database, so it cannot contend with — or leave a stale state behind for —
 * any other spec file, no matter what order files run in or how long a run takes.
 */
import path from "node:path";
import { tmpdir } from "node:os";
import { writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";

export const HANDOFF_PATH = path.join(tmpdir(), "anyapp-frontend-test-scratch.json");

export default async function globalSetup(): Promise<() => Promise<void>> {
  const scratch = await createScratchDatabase();
  const appTokenSecret = randomBytes(32).toString("base64");

  const servers = await startServers({
    databaseUrl: scratch.databaseUrl,
    sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
    ports: { studio: 3000, sandbox: 3001 },
    env: { APP_TOKEN_SECRET: appTokenSecret },
  });

  await writeFile(
    HANDOFF_PATH,
    JSON.stringify({ databaseUrl: scratch.databaseUrl, appTokenSecret }),
    "utf8",
  );

  return async () => {
    await servers.stop();
    await scratch.drop();
    await rm(HANDOFF_PATH, { force: true });
  };
}
