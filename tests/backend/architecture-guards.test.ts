/**
 * Section I: architecture guards (I1-I14). Static checks on the source tree: no Postgres, servers or ports.
 * Several enforce the root CLAUDE.md "Don't" list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../harness/db";
import { previewFrame } from "../../apps/studio/src/views";
import { cssViolations } from "../harness/css";

function read(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(read(relPath));
}

function walkTsFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = path.join(abs, entry);
    const rel = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(rel));
    } else if (entry.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out;
}

function dependsOn(pkg: Record<string, unknown>, name: string): boolean {
  const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(deps, name);
}


test("I1 — apps/sandbox/package.json does not list @any-app/generator", () => {
  const pkg = readJson("apps/sandbox/package.json");
  assert.equal(dependsOn(pkg, "@any-app/generator"), false);
});

test("I2 — apps/sandbox/src/** contains no import of @any-app/generator", () => {
  const files = walkTsFiles("apps/sandbox/src");
  assert.ok(files.length > 0, "expected to find sandbox source files");
  // Matches a real import/require specifier, not a mention: comments explain why a file does NOT depend on a package.
  const importSpecifier = /(?:from\s+|require\()\s*["']@any-app\/generator["']/;
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, importSpecifier, `${file} imports @any-app/generator`);
  }
});

// The sandbox must not depend on @any-app/store at all: one import evaluates store's module scope, which builds a privileged pool.

test("I3 — apps/sandbox/package.json does not list @any-app/store at all", () => {
  const pkg = readJson("apps/sandbox/package.json");
  assert.equal(
    dependsOn(pkg, "@any-app/store"),
    false,
    "sandbox must not depend on @any-app/store even for a single export — see CLAUDE.md's Dependency rules",
  );
});

// Backs I3 at source level. Only real specifiers match, since index.ts's comments mention the package by name.
test("I3b — apps/sandbox/src/** contains no import of @any-app/store", () => {
  const files = walkTsFiles("apps/sandbox/src");
  const importSpecifier = /(?:from\s+|require\()\s*["']@any-app\/store["']/;
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, importSpecifier, `${file} imports @any-app/store`);
  }
});


test("I4 — no compression package anywhere in the repo", () => {
  const packageJsonPaths = [
    "package.json",
    "apps/sandbox/package.json",
    "apps/studio/package.json",
    "packages/generator/package.json",
    "packages/protocol/package.json",
    "packages/records/package.json",
    "packages/store/package.json",
    "packages/tsconfig/package.json",
    "tests/package.json",
  ];
  for (const p of packageJsonPaths) {
    const pkg = readJson(p);
    assert.equal(dependsOn(pkg, "compression"), false, `${p} lists compression`);
  }

  // And no source file imports it directly (e.g. a stray require resolved from a sibling's node_modules).
  const sourceDirs = ["apps/sandbox/src", "apps/studio/src", "packages/generator/src", "packages/protocol/src", "packages/records/src", "packages/store/src"];
  for (const dir of sourceDirs) {
    for (const file of walkTsFiles(dir)) {
      assert.doesNotMatch(read(file), /require\(["']compression["']\)|from ["']compression["']/, `${file} imports compression`);
    }
  }
});

// Both sandbox flags together, with a per-app src host. allow-same-origin on a shared origin would let every app read every other's storage.
// Inverted from an older spec on purpose: do not "correct" it back.

test("I5 — preview iframe: allow-scripts + allow-same-origin together, src host derived per app", () => {
  // Rendered, not read as source: the attributes are what the browser sees.
  const rendered = previewFrame("abc123", "http://abc123.apps.example", "grant").toString();

  const sandboxAttrMatch = /sandbox="([^"]*)"/.exec(rendered);
  assert.ok(sandboxAttrMatch, "previewFrame must set a sandbox attribute");
  const tokens = sandboxAttrMatch![1]!.split(/\s+/);
  assert.ok(tokens.includes("allow-scripts"), "sandbox attribute must include allow-scripts");
  assert.ok(
    tokens.includes("allow-same-origin"),
    "sandbox attribute must include allow-same-origin — required for a same-origin " +
      "fetch(\"/data/...\") from inside the frame; only safe because origins are per-app",
  );

  // The src must be built from a per-app origin parameter, not a single hardcoded host: two origins in, two hosts out.
  assert.match(rendered, /src="http:\/\/abc123\.apps\.example\/preview\/abc123\?g=grant"/);
  const other = previewFrame("def456", "http://def456.apps.example", "grant").toString();
  assert.match(other, /src="http:\/\/def456\.apps\.example\/preview\/def456\?g=grant"/);

  // And the caller must actually derive a distinct origin per app id, not reuse one
  // constant for every generation — apps/studio/src/index.ts's appOrigin(id) function.
  const index = read("apps/studio/src/index.ts");
  assert.match(
    index,
    /function appOrigin\(id: string\)[\s\S]*?\{id\}/,
    "index.ts must derive the app origin from a per-app {id} template, not a fixed constant",
  );
});


test("I6 — no provider SDK imported outside packages/generator/src/providers/", () => {
  const files = walkTsFiles("packages/generator/src").filter(
    (f) => !f.startsWith(path.join("packages", "generator", "src", "providers") + path.sep) &&
           !f.split(path.sep).includes("providers"),
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, /from ["']openai["']/, `${file} imports the openai SDK directly`);
    assert.doesNotMatch(content, /from ["']@anthropic-ai\/sdk["']/, `${file} imports the anthropic SDK directly`);
  }

  // And confirm the adapters themselves DO import their SDKs — otherwise this test would
  // pass vacuously if both adapters stopped using their SDKs (or moved elsewhere).
  const openai = read("packages/generator/src/providers/openai.ts");
  assert.match(openai, /from ["']openai["']/);
  const anthropic = read("packages/generator/src/providers/anthropic.ts");
  assert.match(anthropic, /from ["']@anthropic-ai\/sdk["']/);

  // Rest-of-repo check too, per the spec's "outside the adapter directory" framing —
  // nothing in apps/* should import a provider SDK either.
  for (const dir of ["apps/studio/src", "apps/sandbox/src"]) {
    for (const file of walkTsFiles(dir)) {
      const content = read(file);
      assert.doesNotMatch(content, /from ["']openai["']/, `${file} imports the openai SDK directly`);
      assert.doesNotMatch(content, /from ["']@anthropic-ai\/sdk["']/, `${file} imports the anthropic SDK directly`);
    }
  }
});


test("I7 — no route/view interpolates a raw credential into output", () => {
  const files = [
    ...walkTsFiles("apps/studio/src"),
    ...walkTsFiles("apps/sandbox/src"),
  ];
  for (const file of files) {
    const content = read(file);
    // A raw apiKey spliced into a template literal, as opposed to passed as a secret to redact (settings.ts's safeMessage).
    assert.doesNotMatch(
      content,
      /\$\{[^}]*\bapiKey\b[^}]*\}/,
      `${file} appears to interpolate apiKey directly into a string`,
    );
    assert.doesNotMatch(
      content,
      /\$\{[^}]*\bcredential\.apiKey\b[^}]*\}/,
      `${file} appears to interpolate credential.apiKey directly into a string`,
    );
  }
});

test("I7b — error persistence (markFailed) always goes through safeMessage, never a raw error", () => {
  const internal = read("apps/studio/src/internal.ts");
  // Every markFailed(id, X): X is a string literal or `message` (built with safeMessage), never a raw error.
  const calls = [...internal.matchAll(/markFailed\(id,\s*([^)]+)\)/g)].map((m) => m[1]!.trim());
  assert.ok(calls.length > 0, "expected at least one markFailed call in internal.ts");
  for (const arg of calls) {
    const isStringLiteral = /^"[^"]*"$/.test(arg);
    const isMessageVar = arg === "message";
    assert.ok(
      isStringLiteral || isMessageVar,
      `internal.ts calls markFailed(id, ${arg}) — expected a string literal or the scrubbed "message" variable`,
    );
  }
  assert.match(
    internal,
    /const message = safeMessage\(error, secrets\);/,
    "internal.ts must derive its persisted/rendered error message via safeMessage",
  );
});

// The data API is same-origin by construction: a CORS header would mean someone opened it up instead of fixing the iframe.

test("I8 — no Access-Control-Allow-Origin anywhere in apps/sandbox/src", () => {
  for (const file of walkTsFiles("apps/sandbox/src")) {
    assert.doesNotMatch(
      read(file),
      /Access-Control-Allow-Origin/i,
      `${file} sets a CORS header — the data API is meant to be same-origin only`,
    );
  }
});


test("I9 — apps/sandbox/src/data.ts reads app_id only from res.locals", () => {
  const content = read("apps/sandbox/src/data.ts");

  // Must never pull an app id out of anything the caller controls directly.
  assert.doesNotMatch(content, /req\.body\.app_?[Ii]d/, "data.ts reads app id from req.body");
  assert.doesNotMatch(content, /req\.query\.app_?[Ii]d/, "data.ts reads app id from req.query");
  assert.doesNotMatch(content, /req\.params\.app_?[Ii]d/, "data.ts reads app id from req.params");
  assert.doesNotMatch(
    content,
    /req\.(get|header)\(\s*["']x-app-id["']/i,
    "data.ts reads app id from a header",
  );

  // Exactly one assignment onto res.locals.appId, and it must come from verifyAppToken's
  // return value, not from anything else.
  const assignments = [...content.matchAll(/res\.locals\.appId\s*=\s*([^;]+);/g)];
  assert.equal(assignments.length, 1, "expected exactly one res.locals.appId assignment");
  assert.equal(assignments[0]![1]!.trim(), "appId");
  // verifyAppToken now also returns mode, so appId is destructured from its result: same derivation, different shape.
  assert.match(
    content,
    /const \{ appId, mode \} = verified;/,
    "appId must be derived from verifyAppToken's return value",
  );
  assert.match(
    content,
    /const verified = verifyAppToken\(token, secret\);/,
    "verifyAppToken must still be the sole source of the verified token",
  );

  // And every downstream read of the app id (route handlers) reads it back off res.locals,
  // not off a fresh local variable computed some other way.
  const handlerAppIdUses = [...content.matchAll(/res\.locals\.appId/g)];
  assert.ok(handlerAppIdUses.length >= 2, "expected res.locals.appId to be both set and read");
});


test("I10 — studio browser code (client/, and the view modules) never postMessages to \"*\"", () => {
  // The studio's browser code: the view modules and the TypeScript under client/.
  const candidates = [
    ...walkTsFiles("apps/studio/src/views"),
    ...readdirSync(path.join(REPO_ROOT, "apps", "studio", "client"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join("apps/studio/client", f)),
  ];
  assert.ok(candidates.length > 0, "expected to find studio view modules and/or client scripts");
  const sources = candidates.map(read).join("\n");
  // Up to the end of the statement, so a nested call such as postMessage(wrap(x), "*") cannot hide the target.
  const calls = [...sources.matchAll(/postMessage\(([^;]*)/g)];
  assert.ok(calls.length > 0, `expected at least one postMessage call in ${candidates.join(", ")}`);
  for (const call of calls) {
    assert.doesNotMatch(call[1]!, /["']\*["']/, `postMessage call targets "*": postMessage(${call[1]}`);
  }
});

test("I12 — studio CSS conventions: no ID selectors, no !important, no nesting, element selectors only in base.css, literal colours only in theme.css", () => {
  const dir = "apps/studio/public/css";
  const files = readdirSync(path.join(REPO_ROOT, dir)).filter((f) => f.endsWith(".css"));
  assert.ok(files.includes("theme.css") && files.includes("base.css"), "expected the studio's theme.css and base.css");
  const violations = files.flatMap((file) =>
    cssViolations(file, read(`${dir}/${file}`), { allowElementSelectors: file === "base.css", allowLiteralColours: file === "theme.css" }),
  );
  assert.deepEqual(violations, []);
});

test("I12a — the CSS guard itself: each way of breaking a convention is reported, and conforming CSS is not", () => {
  const page = { allowElementSelectors: false, allowLiteralColours: false };
  const bad: [string, string][] = [
    ["an ID", "#stage { margin: 0; }"],
    ["an ID inside :not()", ".a:not(#b) { margin: 0; }"],
    ["an ID after a statement at-rule", ['@import "x.css";', "#x { margin: 0; }"].join("\n")],
    ["an element", "p { margin: 0; }"],
    ["an element after a statement at-rule", ['@charset "utf-8";', "div { margin: 0; }"].join("\n")],
    ["a descendant element", ".a p { margin: 0; }"],
    ["an element inside :not()", ".a:not(div) { margin: 0; }"],
    ["an element inside :has()", ".a:has(button) { margin: 0; }"],
    ["an element inside :where()", ":where(button) { margin: 0; }"],
    ["an element in a selector list", ".a, .b > li { margin: 0; }"],
    ["an element inside @layer", "@layer components { p { margin: 0; } }"],
    ["an element inside @container", "@container (min-width: 10px) { p { margin: 0; } }"],
    ["an element inside @media", "@media (max-width: 760px) { p { margin: 0; } }"],
    ["!important", ".a { margin: 0 !important; }"],
    ["! important with a space", ".a { margin: 0 ! important; }"],
    ["!IMPORTANT", ".a { margin: 0 !IMPORTANT; }"],
    ["nesting", ".a { color: var(--x); div { margin: 0; } }"],
    ["nesting an ID", ".a { #x { margin: 0; } }"],
    ["a missing brace", [".a { margin: 0;", "#x { margin: 0; }"].join("\n")],
    ["a hex colour", ".a { color: #123456; }"],
    ["a short hex colour", ".a { color: #fff; }"],
    ["rgba()", ".a { background: rgba(0, 0, 0, .5); }"],
    ["hsl()", ".a { background: hsl(10 20% 30%); }"],
    ["oklch()", ".a { background: oklch(60% 0.1 200); }"],
    ["color-mix()", ".a { background: color-mix(in srgb, red, blue); }"],
    ["a named colour", ".a { color: white; }"],
    ["a named colour in a gradient", ".a { background: linear-gradient(red, var(--x)); }"],
    ["a colour inside @keyframes", "@keyframes k { from { color: #fff; } }"],
    ["a colour inside @media", "@media (hover: none) { .a { color: red; } }"],
  ];
  for (const [what, css] of bad) {
    assert.ok(cssViolations("t.css", css, page).length > 0, `not reported: ${what}`);
  }
  const good: [string, string][] = [
    ["classes with pseudo-classes and attributes", '.a:hover, .b[open] > .c:not(.d)::before { margin: 0; }'],
    ["an ID-looking string in an attribute", '.a[href="#top"] { color: var(--accent); }'],
    ["a space inside an attribute value", '.a[data-x="a b"] { color: var(--accent); }'],
    ["white-space and transparent", ".a { white-space: nowrap; background: transparent; color: currentColor; }"],
    ["keyframes steps", "@keyframes k { 0%, 80% { opacity: 1; } to { opacity: 0; } }"],
    ["nth-child arguments", ".a:nth-child(2n + 1) { margin: 0; }"],
    ["a comment mentioning #id and p", "/* #stage p { color: #fff !important; } */ .a { margin: 0; }"],
    ["a comma in an :is() list", ".a:is(.b, .c) { margin: 0; }"],
    ["a custom property reference", ".a { color: var(--ok); box-shadow: 0 0 0 3px var(--focus-ring); }"],
  ];
  for (const [what, css] of good) {
    assert.deepEqual(cssViolations("t.css", css, page), [], `falsely reported: ${what}`);
  }
  assert.deepEqual(cssViolations("base.css", "p { margin: 0; } a:hover { color: var(--accent); }", { allowElementSelectors: true, allowLiteralColours: false }), []);
  assert.deepEqual(cssViolations("theme.css", ":root { --a: #fff; --b: rgba(0, 0, 0, .5); }", { allowElementSelectors: false, allowLiteralColours: true }), []);
});

// Host-only cookie (no Domain) so it cannot reach <id>.apps.localhost, and SameSite=Lax: Strict is not sent on a cross-site
// navigation, which is what opening a shared link is.

test("I11 — session cookie is set with no Domain attribute, and SameSite=Lax (not Strict)", () => {
  const content = read("apps/studio/src/session.ts");
  const setCookieMatch = /setHeader\(\s*["']Set-Cookie["']\s*,\s*([\s\S]*?)\)\s*;/.exec(content);
  assert.ok(setCookieMatch, "expected to find a Set-Cookie header assignment in session.ts");
  const cookieExpr = setCookieMatch![1]!;
  assert.doesNotMatch(
    cookieExpr,
    /Domain=/i,
    "session cookie must not carry a Domain attribute — it must stay host-only so it is " +
      "never sent to <id>.apps.localhost, a subdomain of the studio's own host",
  );
  // Sanity: COOKIE_ATTRS holds the shared attribute string (currentOwner, signInAs and signOut all set it), so resolve it there too.
  const attrsMatch = /COOKIE_ATTRS\s*=\s*(["'`])([\s\S]*?)\1/.exec(content);
  const attrsExpr = attrsMatch ? attrsMatch[2]! : "";
  assert.match(cookieExpr + attrsExpr, /HttpOnly/i);
  // Both directions: guards against regressing to Strict, which would sign recipients of a shared link out. Lax rides that navigation;
  // index.ts's Sec-Fetch-Site/Origin guard covers CSRF (see M12).
  const combined = cookieExpr + attrsExpr;
  assert.match(combined, /SameSite=Lax/i, "session cookie must carry SameSite=Lax, not Strict");
  assert.doesNotMatch(
    combined,
    /SameSite=Strict/i,
    "session cookie must NOT carry SameSite=Strict — it breaks shared links arriving via a " +
      "cross-site top-level navigation; the Sec-Fetch-Site/Origin " +
      "guard in index.ts is what actually defends against the same-site generated-app CSRF " +
      "Strict looked like it was for",
  );
});

// Production runs the tsc output (dist/) with the `production` export condition; dev, tests and typecheck resolve src/.
// These checks pin the start path, the exports maps, the build wiring and the README against drifting back.
interface Manifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
}
interface BuildConfig {
  compilerOptions?: { rootDir?: string; outDir?: string };
  references?: { path: string }[];
}
interface DeployInputs {
  root: Manifest;
  /** Every workspace manifest by directory (apps/*, packages/*, tests). */
  workspaces: Record<string, Manifest>;
  /** tsconfig.build.json per server workspace; "." is the root one. */
  builds: Record<string, BuildConfig>;
  readme: string;
  fileExists: (relPath: string) => boolean;
}

const SERVER_APPS = ["apps/studio", "apps/sandbox"];
const SERVER_PACKAGES = ["packages/protocol", "packages/records", "packages/store", "packages/generator"];
const WATCHER = /watch|nodemon/i;

/** Every way the production start path can drift back to dev tooling; empty when it is sound. */
function deploymentProblems({ root, workspaces, builds, readme, fileExists }: DeployInputs): string[] {
  const problems: string[] = [];

  for (const dir of SERVER_APPS) {
    const name = dir.split("/")[1]!;
    const start = workspaces[dir]?.scripts?.start;
    if (!start) problems.push(`${dir} has no start script`);
    else if (!/^node\s+--conditions=production\s+dist\/index\.js$/.test(start)) {
      problems.push(`${dir}'s start script must be "node --conditions=production dist/index.js": ${start}`);
    }
    if (start && (WATCHER.test(start) || /tsx/.test(start))) problems.push(`${dir}'s start script uses tsx or a watcher: ${start}`);
    const rootStart = root.scripts?.[`start:${name}`];
    if (!rootStart) problems.push(`root has no start:${name} script`);
    else if (!rootStart.includes(`--workspace @any-app/${name}`) || !/run start(\s|$)/.test(rootStart) || /run dev/.test(rootStart)) {
      problems.push(`root start:${name} must run the workspace start script, not dev: ${rootStart}`);
    }
    if (!readme.includes(`node --conditions=production ${dir}/dist/index.js`)) problems.push(`README's production commands do not name ${dir}/dist/index.js`);
    if (!fileExists(`${dir}/src/index.ts`)) problems.push(`${dir}/src/index.ts does not exist (dist/index.js mirrors it)`);
  }

  for (const [dir, pkg] of Object.entries(workspaces)) {
    if (pkg.dependencies?.tsx) problems.push(`${dir} lists tsx in runtime dependencies; production runs compiled JavaScript`);
  }

  for (const dir of SERVER_PACKAGES) {
    const entry = workspaces[dir]?.exports?.["."] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object") problems.push(`${dir} has no conditional exports for "."`);
    else {
      if (entry.production !== "./dist/index.js") problems.push(`${dir} exports must map production to ./dist/index.js`);
      if (entry.default !== "./src/index.ts") problems.push(`${dir} exports must map default to ./src/index.ts`);
      if (Object.keys(entry)[0] !== "production") problems.push(`${dir} exports must list production first (conditions match in order)`);
    }
    if (!fileExists(`${dir}/src/index.ts`)) problems.push(`${dir}/src/index.ts does not exist (dist/index.js mirrors it)`);
  }

  const migrateProd = workspaces["packages/store"]?.scripts?.["migrate:prod"];
  if (!migrateProd) problems.push("packages/store has no migrate:prod script");
  else if (!/^node\s+--conditions=production\s+dist\/migrate-cli\.js$/.test(migrateProd) || /tsx|watch|nodemon/i.test(migrateProd)) {
    problems.push(`packages/store's migrate:prod must run the compiled dist/migrate-cli.js: ${migrateProd}`);
  }
  if (!root.scripts?.["migrate:prod"]?.includes("run migrate:prod --workspace @any-app/store")) problems.push("root migrate:prod must run the store workspace's migrate:prod");
  if (!readme.includes("npm run migrate:prod")) problems.push("README does not name npm run migrate:prod");

  if (!root.scripts?.["build:server"]?.startsWith("tsc -b ")) problems.push("root build:server must be a tsc -b build");
  if (!/build:server/.test(root.scripts?.["build:prod"] ?? "")) problems.push("root build:prod must run build:server");

  for (const dir of [...SERVER_APPS, ...SERVER_PACKAGES]) {
    const options = builds[dir]?.compilerOptions;
    if (options?.rootDir !== "src" || options?.outDir !== "dist") problems.push(`${dir}/tsconfig.build.json must compile src to dist (rootDir "src", outDir "dist")`);
    if (!builds["."]?.references?.some((ref) => ref.path === `${dir}/tsconfig.build.json`)) {
      problems.push(`root tsconfig.build.json does not reference ${dir}`);
    }
  }
  return problems;
}

function realDeployInputs(): DeployInputs {
  const dirs = [...SERVER_APPS, ...SERVER_PACKAGES, "packages/tsconfig", "tests"];
  return {
    root: readJson("package.json") as Manifest,
    workspaces: Object.fromEntries(dirs.map((dir) => [dir, readJson(`${dir}/package.json`) as Manifest])),
    builds: {
      ".": readJson("tsconfig.build.json") as BuildConfig,
      ...Object.fromEntries([...SERVER_APPS, ...SERVER_PACKAGES].map((dir) => [dir, readJson(`${dir}/tsconfig.build.json`) as BuildConfig])),
    },
    readme: read("README.md"),
    fileExists: (relPath) => existsSync(path.join(REPO_ROOT, relPath)),
  };
}

test("I13 — production starts compiled JavaScript with the production condition; exports, builds and README agree", () => {
  assert.deepEqual(deploymentProblems(realDeployInputs()), []);
});

test("I13a — the guard itself: each way of drifting back to src/tsx is reported", () => {
  const real = realDeployInputs();
  const fresh = (): DeployInputs => ({ ...structuredClone({ ...real, fileExists: undefined }), fileExists: real.fileExists }) as DeployInputs;
  const breakages: [string, (i: DeployInputs) => void, RegExp][] = [
    ["studio start removed", (i) => delete i.workspaces["apps/studio"]!.scripts!.start, /apps\/studio has no start script/],
    ["sandbox start runs src through tsx", (i) => (i.workspaces["apps/sandbox"]!.scripts!.start = "node --import tsx src/index.ts"), /sandbox's start script must be/],
    ["sandbox start is tsx watch", (i) => (i.workspaces["apps/sandbox"]!.scripts!.start = "tsx watch src/index.ts"), /uses tsx or a watcher/],
    ["studio start uses nodemon", (i) => (i.workspaces["apps/studio"]!.scripts!.start = "nodemon node --conditions=production dist/index.js"), /studio's start script must be/],
    ["studio start uses node --watch", (i) => (i.workspaces["apps/studio"]!.scripts!.start = "node --watch --conditions=production dist/index.js"), /studio's start script must be/],
    ["studio start forgets the condition", (i) => (i.workspaces["apps/studio"]!.scripts!.start = "node dist/index.js"), /studio's start script must be/],
    ["studio start runs src", (i) => (i.workspaces["apps/studio"]!.scripts!.start = "node --conditions=production src/index.ts"), /studio's start script must be/],
    ["tsx in the studio's dependencies", (i) => (i.workspaces["apps/studio"]!.dependencies!.tsx = "^4"), /apps\/studio lists tsx in runtime dependencies/],
    ["tsx in the store's dependencies", (i) => (i.workspaces["packages/store"]!.dependencies!.tsx = "^4"), /packages\/store lists tsx in runtime dependencies/],
    ["tsx in the tests' dependencies", (i) => ((i.workspaces.tests!.dependencies ??= {}).tsx = "^4"), /tests lists tsx in runtime dependencies/],
    ["root start:studio points at dev", (i) => (i.root.scripts!["start:studio"] = "npm run dev --workspace @any-app/studio"), /start:studio must run the workspace start script/],
    ["root start:sandbox points at the wrong workspace", (i) => (i.root.scripts!["start:sandbox"] = "npm run start --workspace @any-app/studio"), /start:sandbox must run the workspace start script/],
    ["root start:sandbox removed", (i) => delete i.root.scripts!["start:sandbox"], /no start:sandbox script/],
    ["exports points production at src", (i) => ((i.workspaces["packages/protocol"]!.exports!["."] as Record<string, string>).production = "./src/index.ts"), /packages\/protocol exports must map production/],
    ["exports default points at dist", (i) => ((i.workspaces["packages/records"]!.exports!["."] as Record<string, string>).default = "./dist/index.js"), /packages\/records exports must map default/],
    ["exports is a plain string", (i) => (i.workspaces["packages/generator"]!.exports!["."] = "./src/index.ts"), /packages\/generator has no conditional exports/],
    ["exports lists production last", (i) => (i.workspaces["packages/store"]!.exports!["."] = { default: "./src/index.ts", production: "./dist/index.js" }), /packages\/store exports must list production first/],
    ["migrate:prod runs tsx", (i) => (i.workspaces["packages/store"]!.scripts!["migrate:prod"] = "tsx src/migrate-cli.ts"), /migrate:prod must run the compiled/],
    ["migrate:prod runs src", (i) => (i.workspaces["packages/store"]!.scripts!["migrate:prod"] = "node --conditions=production src/migrate-cli.ts"), /migrate:prod must run the compiled/],
    ["migrate:prod removed", (i) => delete i.workspaces["packages/store"]!.scripts!["migrate:prod"], /no migrate:prod script/],
    ["build:prod skips the server build", (i) => (i.root.scripts!["build:prod"] = "node scripts/build.mjs --prod"), /build:prod must run build:server/],
    ["a workspace compiles to the wrong dir", (i) => (i.builds["apps/sandbox"]!.compilerOptions!.outDir = "build"), /apps\/sandbox\/tsconfig.build.json must compile src to dist/],
    ["the root build drops a project", (i) => (i.builds["."]!.references = i.builds["."]!.references!.filter((ref) => !ref.path.startsWith("packages/records"))), /does not reference packages\/records/],
    ["README names the old tsx command", (i) => (i.readme = i.readme.split("node --conditions=production apps/studio/dist/index.js").join("node --import tsx apps/studio/src/index.ts")), /README's production commands do not name apps\/studio\/dist\/index.js/],
    ["README drops migrate:prod", (i) => (i.readme = i.readme.split("npm run migrate:prod").join("npm run migrate")), /README does not name npm run migrate:prod/],
  ];
  for (const [label, breakIt, expected] of breakages) {
    const inputs = fresh();
    breakIt(inputs);
    const problems = deploymentProblems(inputs);
    assert.ok(problems.some((p) => expected.test(p)), `${label}: expected a problem matching ${expected}, got ${JSON.stringify(problems)}`);
  }
  assert.ok(
    deploymentProblems({ ...fresh(), fileExists: () => false }).some((p) => /does not exist/.test(p)),
    "a missing source entry file is reported",
  );
});

// Node's ESM loader needs explicit specifiers; tsc (nodenext) enforces it in `npm run build:server`, this catches it without a build.
test("I14 — relative imports in server source carry an explicit .ts extension (tsc rewrites it to .js)", () => {
  const offenders: string[] = [];
  for (const dir of [...SERVER_APPS, ...SERVER_PACKAGES]) {
    for (const file of walkTsFiles(`${dir}/src`)) {
      for (const match of read(file).matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}(?:\/[^"'\n]*)?)["']/g)) {
        if (!/\.ts$/.test(match[1]!)) offenders.push(`${file}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
