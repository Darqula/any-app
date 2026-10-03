// `npm run db` — start the dev Postgres (compose.yaml) and finish the manual setup
// steps: migrations and the sandbox role. Idempotent; safe to re-run.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function die(message) {
  console.error(`npm run db: ${message}`);
  process.exit(1);
}

/** Waits until the host can reach the published port. compose --wait verifies
 * health inside the container, which cannot see Docker Desktop's host-side
 * publish wiring — on first boot that lags a few seconds past 'healthy'. */
async function waitForHostPort({ host, port }, { tries = 20, delayMs = 250 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.once("connect", () => { socket.end(); resolve(); });
        socket.once("error", reject);
      });
      return;
    } catch {
      if (attempt === tries) {
        die(`the host cannot reach ${host}:${port} after ${tries} attempts — is another postgres bound to that port?`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Runs a command with inherited stdio; dies on non-zero exit or a missing binary. */
function run(command, args, { env, failHint } = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
    env: env ? { ...process.env, ...env } : process.env,
    // npm needs a shell on Windows; docker args must not go through one.
    shell: command === "npm",
  });
  if (result.error?.code === "ENOENT") {
    if (command === "docker") {
      die(`"${command}" was not found on PATH — is Docker Desktop installed and running?`);
    }
    die(`"${command}" was not found on PATH`);
  }
  if (result.error) die(result.error.stack ?? String(result.error));
  if (result.status !== 0) {
    if (failHint) console.error(failHint);
    die(`"${command} ${args.join(" ")}" exited with code ${result.status}`);
  }
}

// Read .env as text; only the compose child gets the secrets.
const envPath = path.join(root, ".env");
if (!existsSync(envPath)) {
  die(`no .env at ${envPath} — copy .env.example to .env and fill it in first`);
}
const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(\S.*?)\s*$/);
  if (match) env[match[1]] = match[2];
}

function requireUrl(name) {
  const value = env[name];
  if (!value) die(`.env has no ${name}`);
  let url;
  try {
    url = new URL(value);
  } catch {
    die(`.env ${name} is not a valid postgres:// URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    die(`.env ${name} must be a postgres:// URL`);
  }
  if (!url.username) die(`.env ${name} has no user`);
  if (!url.password) {
    die(`.env ${name} has no password — npm run db initializes the container with it`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database) die(`.env ${name} has no database name`);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    port: url.port || "5432",
    // URL keeps the brackets on IPv6 hosts ("[::1]"); net.connect wants them bare.
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
  };
}

if (process.env.ANYAPP_DB_AUTOSTART === "0") {
  console.log("ANYAPP_DB_AUTOSTART=0 — skipping database startup");
  process.exit(0);
}

const db = requireUrl("DATABASE_URL");

const composeEnv = {
  POSTGRES_HOST_PORT: db.port,
  POSTGRES_USER: db.user,
  POSTGRES_PASSWORD: db.password,
  POSTGRES_DB: db.database,
};
if (!["localhost", "127.0.0.1", "::1"].includes(db.host)) {
  console.warn(
    `npm run db: warning — DATABASE_URL host "${db.host}" is not loopback; ` +
      "compose binds the container to loopback only, so that host cannot reach it.",
  );
}

// Friendly up-front warning for ports other containers already publish.
const dockerPs = spawnSync("docker", ["ps", "--format", "{{.Names}} {{.Ports}}"], {
  encoding: "utf8",
});
const published = new Set();
for (const line of (dockerPs.stdout ?? "").split(/\r?\n/)) {
  for (const match of line.matchAll(/:(\d+)->\d+\/tcp/g)) {
    if (match[1] !== db.port || line.startsWith("anyapp-postgres")) continue;
    published.add(line.split(" ")[0]);
  }
}
for (const name of published) {
  console.warn(
    `npm run db: warning — ${name} already publishes port ${db.port}. ` +
      "Compose will fail to bind it; change DATABASE_URL to another host port and re-run.",
  );
}

console.log(`starting anyapp-postgres (host port ${db.port})
`);
run("docker", ["compose", "up", "-d", "--wait"], {
  env: composeEnv,
  failHint: `If this container once started with different credentials, its data volume still` +
    " holds the old cluster — 'docker compose down -v' resets it (drops all data).",
});

await waitForHostPort(db);
console.log("applying migrations");
run("npm", ["run", "migrate"]);

const sandboxUrl = env.SANDBOX_DATABASE_URL ? requireUrl("SANDBOX_DATABASE_URL") : null;
if (!sandboxUrl) {
  console.log(
    "no SANDBOX_DATABASE_URL in .env — skipped the sandbox role " +
      "(a fresh checkout falls back to DATABASE_URL, which removes sandbox isolation; see .env.example)",
  );
} else {
  if (sandboxUrl.host !== db.host || sandboxUrl.port !== db.port) {
    die("SANDBOX_DATABASE_URL must point to the same host and port as DATABASE_URL, or the grants have nothing to apply to");
  }
  if (sandboxUrl.database !== db.database) {
    die("SANDBOX_DATABASE_URL must name the same database as DATABASE_URL, or the grants have nothing to apply to");
  }
  if (!/^[a-z_][a-z0-9_$]*$/.test(sandboxUrl.user)) {
    die(`SANDBOX_DATABASE_URL's user "${sandboxUrl.user}" is not a plain lowercase identifier — refusing to interpolate it into SQL`);
  }
  // The whole grant, per 005_records.sql — records is the role's entire surface;
  // never broaden it (e.g. `on all tables`).
  const passwordLiteral = sandboxUrl.password.replaceAll("'", "''");
  const sql =
    `DO $do$ BEGIN ` +
    `IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${sandboxUrl.user}') THEN ` +
    `EXECUTE 'create role ${sandboxUrl.user} login password ' || quote_literal('${passwordLiteral}'); ` +
    `ELSE EXECUTE 'alter role ${sandboxUrl.user} login password ' || quote_literal('${passwordLiteral}'); ` +
    `END IF; END $do$; ` +
    `grant usage on schema public to ${sandboxUrl.user}; ` +
    `grant select, insert, update, delete on records to ${sandboxUrl.user};`;
  run("docker", [
    "exec", "anyapp-postgres",
    "psql", "-U", db.user, "-d", db.database, "-v", "ON_ERROR_STOP=1", "-c", sql,
  ]);
  console.log(`sandbox role ${sandboxUrl.user} ready (password kept in sync with .env)`);
}

console.log(`postgres is ready at ${db.user}:***@${db.host}:${db.port}/${db.database}`);
console.log("next: npm run dev");
