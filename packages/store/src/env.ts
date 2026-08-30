import { existsSync } from "node:fs";

// Node 22 can load a .env file without any dependency. Load it once, from the
// repository root, the first time any package imports this module.
let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const candidates = [".env", "../../.env", "../../../.env"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
