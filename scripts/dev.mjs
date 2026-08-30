import { spawn } from "node:child_process";

const targets = [
  { name: "studio", workspace: "@any-app/studio", color: "\x1b[36m" },
  { name: "sandbox", workspace: "@any-app/sandbox", color: "\x1b[35m" },
];

const children = targets.map(({ name, workspace, color }) => {
  const child = spawn("npm", ["run", "dev", "--workspace", workspace], {
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
