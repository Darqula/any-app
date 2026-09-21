/**
 * Section I: architecture guards (I1-I11). Static checks on the source tree: no Postgres, servers or ports.
 * Several enforce the root CLAUDE.md "Don't" list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../harness/db";

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
  const views = read("apps/studio/src/views.ts");

  // Find the previewFrame function body specifically, not just anywhere in the file.
  const match = /export function previewFrame[\s\S]*?\n}/.exec(views);
  assert.ok(match, "expected to find an exported previewFrame function in views.ts");
  const body = match![0];

  const sandboxAttrMatch = /sandbox="([^"]*)"/.exec(body);
  assert.ok(sandboxAttrMatch, "previewFrame must set a sandbox attribute");
  const tokens = sandboxAttrMatch![1]!.split(/\s+/);
  assert.ok(tokens.includes("allow-scripts"), "sandbox attribute must include allow-scripts");
  assert.ok(
    tokens.includes("allow-same-origin"),
    "sandbox attribute must include allow-same-origin — required for a same-origin " +
      "fetch(\"/data/...\") from inside the frame; only safe because origins are per-app",
  );

  // The src must be built from a per-app origin parameter, not a single hardcoded host —
  // i.e. previewFrame takes an appOrigin argument and interpolates it into `src`.
  assert.match(
    body,
    /function previewFrame\([^)]*appOrigin[^)]*\)/,
    "previewFrame must take an appOrigin parameter",
  );
  assert.match(
    body,
    /src="\$\{escapeHtml\(appOrigin\)\}/,
    "previewFrame's src must be built from the per-app appOrigin parameter",
  );

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


test("I10 — apps/studio/src/views.ts never postMessages to \"*\"", () => {
  const content = read("apps/studio/src/views.ts");
  const calls = [...content.matchAll(/postMessage\(([^;]*?)\)/gs)];
  assert.ok(calls.length > 0, "expected at least one postMessage call in views.ts");
  for (const call of calls) {
    assert.doesNotMatch(
      call[1]!,
      /["']\*["']\s*\)?\s*$/,
      `postMessage call targets "*": postMessage(${call[1]})`,
    );
    assert.doesNotMatch(call[1]!, /,\s*["']\*["']/, `postMessage call targets "*": postMessage(${call[1]})`);
  }
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
