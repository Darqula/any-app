// Bundles the studio's browser code: apps/studio/client/*.ts -> apps/studio/dist/js/*.js (one file per page).
// `node scripts/build.mjs` builds once; `--watch` rebuilds on change (used by `npm run dev`).
// `--prod` (or NODE_ENV=production) minifies and writes no source maps, so none can be published.
import { rm } from "node:fs/promises";
import path from "node:path";
import { build, context } from "esbuild";

const prod = process.argv.includes("--prod") || process.env.NODE_ENV === "production";
const studio = path.join(import.meta.dirname, "..", "apps", "studio");
const options = {
  entryPoints: { home: path.join(studio, "client", "home.ts"), auth: path.join(studio, "client", "auth.ts") },
  outdir: path.join(studio, "dist", "js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: prod,
  sourcemap: !prod,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await rm(options.outdir, { recursive: true, force: true });
  await build(options);
}
