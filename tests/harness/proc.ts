/**
 * Internal helper shared by db.ts (the one-shot `migrate-cli` child) and servers.ts (the
 * long-running studio/sandbox children). Not part of the public harness contract described
 * in the README, but exported anyway in case a later agent needs to spawn something else
 * under `tsx` the same way.
 *
 * Every child process spawned here gets a *minimal* inherited environment (just enough for
 * Windows/Node/tsx to run at all) plus whatever the caller passes in `env`. The developer's
 * real `.env` — API keys included — is never implicitly forwarded; every child sees only
 * what it is explicitly given. See the README's "Env-var precedence" section for why this
 * is paired with a scratch-directory `.env` file rather than relied on alone.
 */
import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Absolute path to tsx's CLI entry (`node_modules/tsx/dist/cli.mjs`), resolved once. */
export const TSX_CLI = require.resolve("tsx/cli");

/**
 * The handful of OS-level variables a spawned Node process needs to function on Windows
 * (or POSIX) at all. Nothing app-specific lives here — DATABASE_URL, LLM_*, credentials,
 * etc. all come from the caller's explicit `env`.
 */
function hostEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "Path",
    "SystemRoot",
    "windir",
    "TEMP",
    "TMP",
    "PATHEXT",
    "ComSpec",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "HOME",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface SpawnedTsx {
  child: ChildProcess;
  /** Rolling buffer of interleaved stdout+stderr, for diagnosing a failed health check. */
  logs: string[];
}

/** Spawns `<entry>` under tsx as a long-running child process (studio, sandbox). */
export function spawnTsx(
  entry: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): SpawnedTsx {
  const child = spawn(process.execPath, [TSX_CLI, entry], {
    cwd: opts.cwd,
    env: { ...hostEnv(), ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // POSIX only (testing-review.md H1): makes this child a process-group leader, so
    // killTree's `process.kill(-pid, "SIGKILL")` has a real group to target instead of
    // throwing ESRCH and falling back to killing only the tsx wrapper — which re-execs
    // itself as a *separate* OS process (see killTree's own doc comment), orphaning the
    // real server. `detached` is meaningless to the Windows branch below (it uses
    // `taskkill /T` instead, which walks the tree regardless), so this is POSIX-only.
    detached: process.platform !== "win32",
  });
  const logs: string[] = [];
  const capture = (buf: Buffer) => {
    logs.push(buf.toString());
    if (logs.length > 1000) logs.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, logs };
}

/**
 * Runs `<entry>` under tsx to completion (the `migrate-cli.ts` shape: does its work, then
 * lets the process exit naturally). Rejects with the captured output on a non-zero exit.
 */
export function runTsxScript(entry: string, opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, entry], {
      cwd: opts.cwd,
      env: { ...hostEnv(), ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (b: Buffer) => (output += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (output += b.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${entry} exited with code ${code}:\n${output}`));
    });
  });
}

/**
 * Kills a spawned tsx process **and its child** (tsx re-execs itself with `--import
 * loader.mjs` as a *separate* OS process — confirmed empirically on this machine: the pid
 * returned by `spawn()` is the wrapper, not the one actually running the entry file).
 * `child.kill()` alone only kills the wrapper and orphans the real process, so this always
 * kills the whole tree.
 */
export async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // Already exited — fine.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // negative pid: whole process group, if detached
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited — fine.
      }
    }
  }
}
