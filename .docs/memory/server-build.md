# Server build: tsc into dist/, exports conditions, import extensions

Production runs compiled JavaScript; dev, tests and typecheck run the TypeScript sources. The rules are in the root
`CLAUDE.md`; this keeps the reasons and the traps.

## Layout

- Six server workspaces (`apps/studio`, `apps/sandbox`, `packages/protocol`, `packages/generator`, `packages/store`,
  `packages/records`) each have a `tsconfig.build.json` (extends `packages/tsconfig/server.json`: `nodenext`, `composite`;
  `rootDir: src`, `outDir: dist`, build info inside `dist/`). The root `tsconfig.build.json` only holds references;
  `npm run build:server` is `tsc -b tsconfig.build.json`. It is separate from the typecheck config on purpose:
  `npm run typecheck` is one no-emit program (`bundler` resolution) that also covers tests, scripts, `tests/frontend` and
  the client, and does not enforce extensions; the build does.
- `dist/` mirrors `src/` (same depth), which is why `import.meta.url`-relative paths work unchanged: the studio's
  package root is `..` from `index`, and the store's `migrations` directory is `..` from `migrate`, in both trees. Anything
  new that reads a file at runtime must resolve the same from both, and non-TypeScript files (SQL, CSS) are not copied
  into `dist/`: they are read from the package directory.
- `apps/studio/dist/` holds two outputs: the tsc files at its top level and `views/`, and `js/`, the esbuild bundle.
  `scripts/build.mjs` deletes only `dist/js`, and tsc never deletes anything, so neither build disturbs the other.
  `tsc -b` also emits `.d.ts` files (composite requires declarations); they are inert.

## exports and the production condition

Each package maps `"."` to `{ "production": "./dist/index.js", "default": "./src/index.ts" }` (production first:
conditions match in key order). Node started with `--conditions=production` takes `dist/`; everything else (tsx, the
test harness, `node --import tsx --test`, tsc under either resolution mode) takes the default, so a stale or missing
`dist/` can never leak into dev or tests. Starting a compiled server without the flag fails: on Node 22.16 the
loader rejects `.ts` (`ERR_UNKNOWN_FILE_EXTENSION`); on a Node that strips types by default each app's first import,
`production-condition.ts`, throws a clear message when `@any-app/protocol` resolves outside `dist/` (checked with
`--experimental-strip-types` on 22.16: the sandbox prints that message, the studio dies on a parameter property).

## Import extensions

Server code is ESM and Node needs explicit specifiers, so relative imports are written `./x.ts` (and `./dir/index.ts`);
`rewriteRelativeImportExtensions` emits `.js`. The typecheck program accepts them too (same option), so editors, tsx and
tests keep working. A `import("./x")` in a type position needs the extension as well.

## Running it

`npm run start:*` is npm -> sh -> npm -> sh -> node: SIGTERM to the top process does not reach node and leaves the port
held, so a process manager supervises `node --conditions=production apps/<app>/dist/index.js` from the repo root (where
`loadEnv` finds the root `.env`).
