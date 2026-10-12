import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

// Quoted: the commands run through a shell, and the repo path may contain spaces.
const script = (name) => `"${path.join(import.meta.dirname, name)}"`;

const targets = [
  { name: "studio", workspace: "@any-app/studio", color: "\x1b[36m" },
  { name: "sandbox", workspace: "@any-app/sandbox", color: "\x1b[35m" },
  { name: "client", command: `node ${script("build.mjs")} --watch`, color: "\x1b[33m" },
];

// Database first, idempotently, so dev never boots against a stopped container.
// ANYAPP_DB_AUTOSTART=0 skips this.
if (process.env.ANYAPP_DB_AUTOSTART !== "0") {
  const db = spawnSync(`node ${script("db.mjs")}`, { stdio: "inherit", shell: true });
  if (db.status !== 0) process.exit(db.status ?? 1);
} else {
  console.log("ANYAPP_DB_AUTOSTART=0 — skipping database startup\n");
}

// Browser code: build once so the studio finds it at boot, then keep it rebuilt.
const built = spawnSync(`node ${script("build.mjs")}`, { stdio: "inherit", shell: true });
if (built.status !== 0) process.exit(built.status ?? 1);

const children = targets.map(({ name, workspace, command, color }) => {
  const child = spawn(command ?? `npm run dev --workspace ${workspace}`, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  const prefix = `${color}[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) process.stdout.write(prefix + line + "\n");
      }
    });
  }

  return child;
});

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
