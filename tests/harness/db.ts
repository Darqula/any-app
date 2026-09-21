/**
 * Scratch database lifecycle (contract in tests/README.md):
 *   const scratch = await createScratchDatabase();   // scratch.databaseUrl (superuser), scratch.sandboxDatabaseUrl (restricted role)
 *   await scratch.drop();                             // drops the database, never the role
 * migrate() runs in a child process because @any-app/store's pool is a module-scope singleton that ESM cannot re-import
 * fresh. Everything else here uses pg directly.
 */
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runTsxScript } from "./proc";

const { Client } = pg;

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..");
const MIGRATE_CLI = path.join(REPO_ROOT, "packages", "store", "src", "migrate-cli.ts");

/** Cluster-global role (roles are not per-database); the grant is per-database. Created once, never dropped. */
export const SANDBOX_TEST_ROLE = "anyapp_sandbox_test";
const SANDBOX_TEST_ROLE_PASSWORD = "anyapp-sandbox-test-scratch-pw";

/** Reads the superuser DATABASE_URL without putting it on process.env, so real secrets do not accumulate. */
export function readSuperuserDatabaseUrl(): string {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) {
    throw new Error(
      `Expected a repo-root .env at ${envPath} with a superuser DATABASE_URL. Copy .env.example and fill it in first.`,
    );
  }
  const parsed = parseEnv(readFileSync(envPath, "utf8"));
  const url = parsed.DATABASE_URL;
  if (!url) throw new Error(`.env at ${envPath} has no DATABASE_URL`);
  return url;
}

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

/** Quotes a Postgres identifier. Only ever used on names this file generates itself
 * (`anyapp_test_<hex>`, the fixed role name) — never on external input. */
function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export interface ScratchDatabase {
  /** Superuser connection string to the fresh, migrated scratch database. */
  databaseUrl: string;
  /** The restricted `anyapp_sandbox_test` role's connection string to that same database —
   * already verified to see `records` and get `permission denied` on everything else. */
  sandboxDatabaseUrl: string;
  /** The generated `anyapp_test_<random>` name, if a test needs it for logging. */
  dbName: string;
  /** Drops only this database. Never touches `anyapp_sandbox_test` (cluster-global, shared
   * by every scratch database) and never, ever touches `anyapp`, the real dev database. */
  drop(): Promise<void>;
}

async function withClient<T>(connectionString: string, fn: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** True if the error looks like Postgres's `permission denied` (SQLSTATE 42501). */
function isPermissionDenied(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "42501") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /permission denied/i.test(message);
}

async function ensureSandboxTestRole(superuserUrl: string): Promise<void> {
  await withClient(superuserUrl, async (client) => {
    // Idempotent: a fresh role has no privileges on anything, and CREATE ROLE has no
    // "IF NOT EXISTS" form, hence the DO block + duplicate_object catch.
    await client.query(`
      do $$
      begin
        create role ${ident(SANDBOX_TEST_ROLE)} login password '${SANDBOX_TEST_ROLE_PASSWORD}';
      exception when duplicate_object then null;
      end $$;
    `);
  });
}

/** Hard failure if the sandbox role can reach anything but `records`: backend case K22 depends on it. */
async function verifyRoleIsRestricted(sandboxUrl: string): Promise<void> {
  await withClient(sandboxUrl, async (client) => {
    // Must succeed — this is the one table the role exists to reach.
    await client.query("select count(*) from records");

    for (const table of ["generations", "provider_credentials"]) {
      try {
        await client.query(`select count(*) from ${ident(table)}`);
        throw new Error(
          `SECURITY: anyapp_sandbox_test can read "${table}" — a stray grant somewhere ` +
            `undoes the whole point of the restricted role. Stopping rather than handing ` +
            `back a scratch database that lies about this.`,
        );
      } catch (error) {
        if (!isPermissionDenied(error)) throw error;
        // permission denied, as required — fall through to the next table.
      }
    }
  });
}

export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const superuserRootUrl = readSuperuserDatabaseUrl();
  const dbName = `anyapp_test_${randomBytes(6).toString("hex")}`;

  await withClient(superuserRootUrl, async (client) => {
    await client.query(`create database ${ident(dbName)}`);
  });
  await ensureSandboxTestRole(superuserRootUrl);

  const databaseUrl = withDatabase(superuserRootUrl, dbName);

  // Out-of-process migrate with an isolated cwd and .env (as servers.ts), independent of the repo's .env.
  const migrateCwd = await mkdtemp(path.join(tmpdir(), "anyapp-migrate-"));
  try {
    await writeFile(path.join(migrateCwd, ".env"), `DATABASE_URL=${databaseUrl}\n`, "utf8");
    await runTsxScript(MIGRATE_CLI, { cwd: migrateCwd, env: { DATABASE_URL: databaseUrl } });
  } finally {
    await rm(migrateCwd, { recursive: true, force: true });
  }

  // Grant is per-database and needs `records` to exist, hence after migrate().
  await withClient(databaseUrl, async (client) => {
    await client.query(`grant usage on schema public to ${ident(SANDBOX_TEST_ROLE)}`);
    await client.query(`grant select, insert, update, delete on records to ${ident(SANDBOX_TEST_ROLE)}`);
  });

  const sandboxDatabaseUrl = withCredentials(databaseUrl, SANDBOX_TEST_ROLE, SANDBOX_TEST_ROLE_PASSWORD);
  await verifyRoleIsRestricted(sandboxDatabaseUrl);

  async function drop(): Promise<void> {
    await withClient(superuserRootUrl, async (client) => {
      // Terminate leftover connections, or DROP DATABASE fails with "being accessed by other users".
      await client.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [dbName],
      );
      await client.query(`drop database if exists ${ident(dbName)}`);
    });
  }

  return { databaseUrl, sandboxDatabaseUrl, dbName, drop };
}
