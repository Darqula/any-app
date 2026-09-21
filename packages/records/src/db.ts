import pg from "pg";
import { existsSync } from "node:fs";

// `pg` is a CommonJS package. Import the default export and destructure it;
// named imports are not reliable here.
const { Pool, types } = pg;

// Parses timestamptz by hand to keep all six microsecond digits: a JS Date truncates to milliseconds and
// would drop boundary rows from paginated lists. Assumes the +00 offset the pool forces.
const TIMESTAMPTZ_TEXT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?\+00$/;

types.setTypeParser(1184, (value: string) => {
  const match = TIMESTAMPTZ_TEXT.exec(value);
  if (!match) {
    // Unexpected shape: fall back to a valid (millisecond-truncated) instant rather than crash the parser.
    return new Date(value).toISOString();
  }
  const [, date, time, fraction] = match;
  const micros = (fraction ?? "0").padEnd(6, "0");
  return `${date}T${time}.${micros}Z`;
});

// Not @any-app/store's loadEnv, on purpose: this package must never share a module graph with the one
// holding provider credentials. Exported so the sandbox does not import @any-app/store at all.
let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const candidate of [".env", "../../.env", "../../../.env"]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

loadEnv();

// A role with rights to `records` and nothing else. The DATABASE_URL fallback is a dev convenience only.
const connectionString = process.env.SANDBOX_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "Missing required environment variable: SANDBOX_DATABASE_URL (or DATABASE_URL as a dev fallback)",
  );
}

// A startup parameter, not a `connect` handler that races the first query: it guarantees the +00 offset
// the timestamptz parser assumes.
export const pool = new Pool({ connectionString, options: "-c TimeZone=UTC" });
