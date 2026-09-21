/**
 * Shared by db.ts and servers.ts. Children get a minimal environment plus the caller's `env`: the developer's real
 * .env is never forwarded.
 */
import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const TSX_CLI = require.resolve("tsx/cli");

/** The OS-level variables a spawned Node process needs to run at all; nothing app-specific. */
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

export function spawnTsx(
  entry: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): SpawnedTsx {
  const child = spawn(process.execPath, [TSX_CLI, entry], {
    cwd: opts.cwd,
    env: { ...hostEnv(), ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // POSIX only: makes the child a process-group leader so killTree can kill the whole group.
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

/** Runs <entry> under tsx to completion; rejects with the captured output on a non-zero exit. */
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

/** Kills the tsx wrapper and the real process it re-execs as; child.kill() alone would orphan the server. */
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
