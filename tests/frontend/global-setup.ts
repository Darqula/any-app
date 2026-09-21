/**
 * Boots one scratch database and the real studio (localhost:3000) and sandbox (*.apps.localhost:3001) once per run. The teardown closure
 * returned here runs in the same process. HANDOFF_PATH (a file in the OS temp dir) passes the connection string and appTokenSecret to the worker
 * processes that run the specs. Cases that need a real generation cannot use this server (it has no platform credential) and run their own
 * isolated stacks on ephemeral ports.
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
