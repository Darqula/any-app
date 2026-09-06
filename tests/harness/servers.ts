/**
 * Spawns `apps/studio` and `apps/sandbox` as real child processes under `tsx` (no in-process
 * supertest-style testing is available — see the README's "Known obstacles" for why) and
 * waits for both `/health` endpoints to answer.
 *
 * Env-var precedence (verified empirically, see README): `process.loadEnvFile()` does NOT
 * override a variable already present in `process.env`. So the vars this module passes
 * directly via `env` always win over anything a spawned server's own `loadEnv()` might find.
 * This module still ALSO writes those same vars into a generated `.env` in an isolated
 * scratch `cwd` (outside the repo, so `loadEnv()`'s directory walk finds nothing else) —
 * belt and suspenders, and correct regardless of which way that precedence had gone.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawnTsx, killTree } from "./proc";
import type { SpawnedTsx } from "./proc";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..");
const STUDIO_ENTRY = path.join(REPO_ROOT, "apps", "studio", "src", "index.ts");
const SANDBOX_ENTRY = path.join(REPO_ROOT, "apps", "sandbox", "src", "index.ts");

export interface ServerPorts {
  studio: number;
  sandbox: number;
}

export interface StartServersOptions {
  /** Superuser connection string — required, no default (never point this at `anyapp`). */
  databaseUrl: string;
  /** The restricted role's connection string — required, same reasoning. */
  sandboxDatabaseUrl: string;
  /**
   * Which ports to bind. Pass ephemeral free ports (see `ports.ts`'s `findFreePorts`) for
   * the backend suite; pass the real `{ studio: 3000, sandbox: 3001 }` for the frontend
   * suite, which cannot randomise (`swapRuntime` bakes `STUDIO_PUBLIC_URL` into every
   * generated document, and the data API's host check is derived from
   * `SANDBOX_APP_ORIGIN_TEMPLATE`). Never pass `0` — see ports.ts's doc comment.
   */
  ports: ServerPorts;
  /**
   * Overrides/additions layered on top of the safe defaults below. Anything a caller does
   * NOT set here falls back to a value safe for an unconfigured test run (no real provider,
   * a throwaway INTERNAL_SECRET/CREDENTIAL_KEY/APP_TOKEN_SECRET, etc.) — see the README for
   * the full default table. This is also how a later agent points the servers at the fake
   * provider fixture: pass OPENAI_BASE_URL / ANTHROPIC_BASE_URL and/or the per-role
   * LLM_<ROLE>_* vars here.
   */
  env?: Record<string, string>;
}

export interface RunningServers {
  /** e.g. `http://localhost:54321` — studio always answers on hostname "localhost", never
   * "127.0.0.1" (see README's IPv6/IPv4 note: on this machine "localhost" resolves to ::1
   * only, and studio binds "localhost", so 127.0.0.1 gets ECONNREFUSED against it). */
  studioOrigin: string;
  /** e.g. `http://127.0.0.1:54322` — the shared sandbox origin (`/health`, `/preview/:id`).
   * Always "127.0.0.1", never "localhost" — sandbox binds 127.0.0.1 explicitly and
   * (opposite of studio) does not accept the ::1 connection "localhost" would prefer here. */
  sandboxOrigin: string;
  /** e.g. `http://{id}.apps.localhost:54322` — substitute `{id}` yourself, or use
   * `appOrigin(id)`. Confirmed empirically that `*.apps.localhost` resolves straight to
   * 127.0.0.1 (unlike bare "localhost"), which is exactly where sandbox is listening. */
  appOriginTemplate: string;
  appOrigin(id: string): string;
  studioPort: number;
  sandboxPort: number;
  /**
   * Everything the named child has written to stdout+stderr so far, joined. `spawnTsx`
   * already buffers this (it is what a failed health check prints); this exposes it to
   * cases that need to assert on a server's own log output rather than only on its HTTP
   * responses and database rows. Two cases need exactly that:
   *
   *   - **C15** — proving an aborted planner call does NOT fall back to linear. The route's
   *     observable outcome is identical either way, because both SDKs pre-flight-check an
   *     already-aborted signal and refuse to send: a wrongly-attempted fallback self-aborts,
   *     makes zero network calls, and lands on the same row state. `internal.ts` does log
   *     "planning failed, falling back to linear" on entry to that branch, so its *absence*
   *     is the only thing that distinguishes the two (testing-review.md S9).
   *   - **H5** — "no credential substring in log output", which was inferred from the
   *     database row rather than observed.
   *
   * Buffered, not live: read it after the thing you are asserting about has finished. The
   * buffer is capped (see `spawnTsx`), so a very chatty server can drop its oldest lines.
   */
  logs(which: "studio" | "sandbox"): string;
  /** Reliably kills both processes and their tsx-spawned children (see proc.ts's killTree
   * doc comment for why `child.kill()` alone is not enough on Windows), and removes the
   * scratch env directories. Safe to call more than once. */
  stop(): Promise<void>;
}

function randomSecret(): string {
  return randomBytes(32).toString("base64");
}

function toEnvFile(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
      .join("\n") + "\n"
  );
}

async function waitForHealth(url: string, label: string, spawned: SpawnedTsx, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    if (spawned.child.exitCode !== null) {
      throw new Error(`${label} exited early (code ${spawned.child.exitCode}) before becoming healthy:\n${spawned.logs.join("")}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = new Error(`${label} ${url} returned HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `${label} did not become healthy within ${timeoutMs}ms (last error: ${String(lastError)}).\n--- captured output ---\n${spawned.logs.join("")}`,
  );
}

export async function startServers(opts: StartServersOptions): Promise<RunningServers> {
  const studioOrigin = `http://localhost:${opts.ports.studio}`;
  const sandboxOrigin = `http://127.0.0.1:${opts.ports.sandbox}`;
  const defaultAppOriginTemplate = `http://{id}.apps.localhost:${opts.ports.sandbox}`;

  const defaults: Record<string, string> = {
    DATABASE_URL: opts.databaseUrl,
    SANDBOX_DATABASE_URL: opts.sandboxDatabaseUrl,
    STUDIO_PORT: String(opts.ports.studio),
    SANDBOX_PORT: String(opts.ports.sandbox),
    STUDIO_INTERNAL_URL: studioOrigin,
    STUDIO_PUBLIC_URL: studioOrigin,
    SANDBOX_APP_ORIGIN_TEMPLATE: defaultAppOriginTemplate,
    INTERNAL_SECRET: "test-internal-secret",
    CREDENTIAL_KEY: randomSecret(),
    APP_TOKEN_SECRET: randomSecret(),
    PREVIEW_TIMEOUT_MS: "900000",
    // No real provider by default — every role must resolve a *model* even with no
    // credential configured (roles.ts throws synchronously, uncaught, if LLM_MODEL is
    // unset entirely — see README). Credentials are deliberately left unset so a smoke run
    // never accidentally calls a real provider.
    LLM_PROVIDER: "openai",
    LLM_MODEL: "test-harness-placeholder-model",
    LLM_MAX_TOKENS: "1000",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "",
  };

  const env: Record<string, string> = { ...defaults, ...(opts.env ?? {}) };
  const appOriginTemplate = env.SANDBOX_APP_ORIGIN_TEMPLATE ?? defaultAppOriginTemplate;

  const studioCwd = await mkdtemp(path.join(tmpdir(), "anyapp-studio-"));
  const sandboxCwd = await mkdtemp(path.join(tmpdir(), "anyapp-sandbox-"));
  await writeFile(path.join(studioCwd, ".env"), toEnvFile(env), "utf8");
  await writeFile(path.join(sandboxCwd, ".env"), toEnvFile(env), "utf8");

  const studio = spawnTsx(STUDIO_ENTRY, { cwd: studioCwd, env });
  const sandbox = spawnTsx(SANDBOX_ENTRY, { cwd: sandboxCwd, env });

  async function stop(): Promise<void> {
    await Promise.all([killTree(studio.child.pid), killTree(sandbox.child.pid)]);
    await Promise.all([
      rm(studioCwd, { recursive: true, force: true }),
      rm(sandboxCwd, { recursive: true, force: true }),
    ]);
  }

  try {
    await Promise.all([
      waitForHealth(`${studioOrigin}/health`, "studio", studio),
      waitForHealth(`${sandboxOrigin}/health`, "sandbox", sandbox),
    ]);
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    studioOrigin,
    sandboxOrigin,
    appOriginTemplate,
    appOrigin: (id: string) => appOriginTemplate.replace("{id}", id),
    studioPort: opts.ports.studio,
    sandboxPort: opts.ports.sandbox,
    logs: (which) => (which === "studio" ? studio : sandbox).logs.join(""),
    stop,
  };
}
