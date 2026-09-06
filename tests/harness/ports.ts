/**
 * Free-port discovery for the backend suite's ephemeral-port mode. See the README — the
 * frontend suite does NOT use this; it hardcodes the real 3000/3001 origins on purpose.
 *
 * Deliberately never hands a `0` to either server: both `apps/studio` and `apps/sandbox`
 * log the port number they were *given* (`process.env.STUDIO_PORT` / `SANDBOX_PORT`), not
 * whatever the OS actually assigned, so a `0` would be undiscoverable after the fact. This
 * module finds a real, free port by briefly binding to it and releasing it before the
 * caller passes that same number to `startServers`.
 */
import { createServer } from "node:net";

/** Finds one free TCP port on 127.0.0.1. There is an inherent, small TOCTOU race between
 * releasing the probe socket and the real server binding it — acceptable for test tooling,
 * not something to rely on outside it. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("could not determine an assigned port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Finds `count` distinct free ports, one at a time (sequential, so each probe socket is
 * fully released before the next is opened). */
export async function findFreePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    ports.push(await findFreePort());
  }
  return ports;
}
