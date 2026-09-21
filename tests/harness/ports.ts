/**
 * Free ports for the backend suite (the frontend suite uses the real 3000/3001). Never hands out 0: the servers log the
 * port they were given.
 */
import { createServer } from "node:net";

/** One free port on 127.0.0.1, found by briefly binding it. A small TOCTOU race, acceptable in test tooling. */
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
