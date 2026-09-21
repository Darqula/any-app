/**
 * Spawns apps/studio and apps/sandbox as real tsx child processes and waits for /health. Env vars passed directly win
 * over a server's loadEnv(); they are also written to a scratch .env outside the repo.
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
   * Ephemeral ports for the backend suite; the real 3000/3001 for the frontend suite (origins are baked into documents).
   * Never 0.
   */
  ports: ServerPorts;
  /** Overrides on safe defaults (no real provider, throwaway secrets). Also how to point the servers at the fake provider. */
  env?: Record<string, string>;
}

export interface RunningServers {
  /** Always hostname localhost (::1 here); 127.0.0.1 is refused. */
  studioOrigin: string;
  /** Always 127.0.0.1; the sandbox does not accept ::1. */
  sandboxOrigin: string;
  /** Substitute {id}, or use appOrigin(id). *.apps.localhost resolves to 127.0.0.1, where the sandbox listens. */
  appOriginTemplate: string;
  appOrigin(id: string): string;
  studioPort: number;
  sandboxPort: number;
  /**
   * Everything the child has written so far, for cases that assert on server logs: C15 (an aborted planner call must not
   * fall back to linear; only the log tells) and H5 (no credential in logs). Buffered and capped: read it after the fact.
   */
  logs(which: "studio" | "sandbox"): string;
  /** Kills both processes and their tsx children and removes the scratch env directories. Safe to call twice. */
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
    // No real provider by default. Every role still needs a model (roles.ts throws if LLM_MODEL is unset).
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
