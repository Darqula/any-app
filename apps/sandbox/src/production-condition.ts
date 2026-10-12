// Imported first by the entry point. Compiled code reaches the workspace packages through their "exports"; without
// --conditions=production those resolve to src/*.ts, so refuse to start rather than run (or half-load) the sources.
if (
  import.meta.url.endsWith("/dist/production-condition.js") &&
  !import.meta.resolve("@any-app/protocol").endsWith("/dist/index.js")
) {
  throw new Error("Start the compiled server with: node --conditions=production dist/index.js");
}
