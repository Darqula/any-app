/**
 * Section I — architecture guards (I1–I11). Cheap static/source-tree checks: no Postgres, no
 * spawned servers, no ports. See .docs/tests-backend.md's "I. Architecture guards" for the
 * prose behind each case, and CLAUDE.md's "Don't" list, which several of these cases enforce
 * directly.
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

/** All `*.ts` files under a directory, recursively — used to grep whole source trees. */
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

// ---------------------------------------------------------------------------------------
// I1 / I2 — sandbox must not depend on, or import, @any-app/generator (holds provider keys)
// ---------------------------------------------------------------------------------------

test("I1 — apps/sandbox/package.json does not list @any-app/generator", () => {
  const pkg = readJson("apps/sandbox/package.json");
  assert.equal(dependsOn(pkg, "@any-app/generator"), false);
});

test("I2 — apps/sandbox/src/** contains no import of @any-app/generator", () => {
  const files = walkTsFiles("apps/sandbox/src");
  assert.ok(files.length > 0, "expected to find sandbox source files");
  // A real import/require specifier, not any mention of the string — a comment explaining
  // *why* a file doesn't depend on a package (as apps/sandbox/src/index.ts does for
  // @any-app/store, see I3b) would otherwise false-positive a plain substring match.
  const importSpecifier = /(?:from\s+|require\()\s*["']@any-app\/generator["']/;
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, importSpecifier, `${file} imports @any-app/generator`);
  }
});

// ---------------------------------------------------------------------------------------
// I3 — sandbox must not depend on @any-app/store AT ALL (not even for one export) — see
// CLAUDE.md: importing a single named export off @any-app/store still evaluates
// store/src/index.ts's module scope, which builds a privileged Postgres pool.
// ---------------------------------------------------------------------------------------

test("I3 — apps/sandbox/package.json does not list @any-app/store at all", () => {
  const pkg = readJson("apps/sandbox/package.json");
  assert.equal(
    dependsOn(pkg, "@any-app/store"),
    false,
    "sandbox must not depend on @any-app/store even for a single export — see CLAUDE.md's Dependency rules",
  );
});

// Belt and suspenders: even if the package.json rule ever slipped, no source file should
// actually import the package. package.json is the enforceable, cheap check; this backs it.
// Matches only a real import/require specifier — apps/sandbox/src/index.ts's own comments
// deliberately *mention* "@any-app/store" (explaining why it no longer imports it), and a
// plain substring match would flag prose, not code. See CLAUDE.md's Dependency rules.
test("I3b — apps/sandbox/src/** contains no import of @any-app/store", () => {
  const files = walkTsFiles("apps/sandbox/src");
  const importSpecifier = /(?:from\s+|require\()\s*["']@any-app\/store["']/;
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, importSpecifier, `${file} imports @any-app/store`);
  }
});

// ---------------------------------------------------------------------------------------
// I4 — no `compression` package anywhere. It buffers responses and breaks streaming.
// ---------------------------------------------------------------------------------------

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

  // And no source file requires/imports it directly (e.g. a stray `require("compression")`
  // that bypassed package.json entirely because it resolved from a sibling's node_modules).
  const sourceDirs = ["apps/sandbox/src", "apps/studio/src", "packages/generator/src", "packages/protocol/src", "packages/records/src", "packages/store/src"];
  for (const dir of sourceDirs) {
    for (const file of walkTsFiles(dir)) {
      assert.doesNotMatch(read(file), /require\(["']compression["']\)|from ["']compression["']/, `${file} imports compression`);
    }
  }
});

// ---------------------------------------------------------------------------------------
// I5 — the preview iframe's `sandbox` attribute must carry BOTH allow-scripts and
// allow-same-origin, AND its src host must be derived per app. Tested as a unit on purpose:
// an allow-same-origin frame on a *shared* origin is precisely the failure locked decision
// #8 exists to prevent, and either half alone looks fine in isolation. This assertion is
// deliberately inverted from an older version of the spec (allow-same-origin used to be
// forbidden) — Phase 5 changed the posture on purpose; do not "correct" it back.
// ---------------------------------------------------------------------------------------

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
      "fetch(\"/data/...\") from inside the frame; only safe because origins are per-app (locked decision #8)",
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

// ---------------------------------------------------------------------------------------
// I6 — no provider SDK imported outside packages/generator/src/providers/
// ---------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------
// I7 — no route or view interpolates a raw credential; error persistence always goes
// through the scrubber.
// ---------------------------------------------------------------------------------------

test("I7 — no route/view interpolates a raw credential into output", () => {
  const files = [
    ...walkTsFiles("apps/studio/src"),
    ...walkTsFiles("apps/sandbox/src"),
  ];
  for (const file of files) {
    const content = read(file);
    // A raw apiKey (or a credential's .apiKey) spliced straight into a template literal —
    // as opposed to being passed as a *secret to redact* into safeMessage/scrub, which is
    // the one legitimate use (see settings.ts: safeMessage(error, [apiKey])).
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
  // Every markFailed(id, X) call: X must either be a string literal (e.g. the static
  // "every region failed to generate" message) or the `message` variable that this file
  // assigns via `safeMessage(error, secrets)` immediately above its catch block — never
  // `error.message` or `String(error)` handed to markFailed raw.
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

// ---------------------------------------------------------------------------------------
// I8 — no Access-Control-Allow-Origin anywhere in the sandbox. The data API is same-origin
// by construction; a CORS header would be a sign someone "fixed" a same-origin failure by
// opening it up instead of adding allow-same-origin to the iframe.
// ---------------------------------------------------------------------------------------

test("I8 — no Access-Control-Allow-Origin anywhere in apps/sandbox/src", () => {
  for (const file of walkTsFiles("apps/sandbox/src")) {
    assert.doesNotMatch(
      read(file),
      /Access-Control-Allow-Origin/i,
      `${file} sets a CORS header — the data API is meant to be same-origin only`,
    );
  }
});

// ---------------------------------------------------------------------------------------
// I9 — app_id is only ever read from res.locals in data.ts, never from body/query/params/
// a header.
// ---------------------------------------------------------------------------------------

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
  assert.match(
    content,
    /const appId = verifyAppToken\(token, secret\);/,
    "appId must be derived from verifyAppToken",
  );

  // And every downstream read of the app id (route handlers) reads it back off res.locals,
  // not off a fresh local variable computed some other way.
  const handlerAppIdUses = [...content.matchAll(/res\.locals\.appId/g)];
  assert.ok(handlerAppIdUses.length >= 2, "expected res.locals.appId to be both set and read");
});

// ---------------------------------------------------------------------------------------
// I10 — no postMessage(..., "*") anywhere in views.ts; every call pins a target origin.
// ---------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------
// I11 — the session cookie is set with no Domain attribute (host-only), so it cannot leak
// to <id>.apps.localhost, a subdomain of the studio's own host.
// ---------------------------------------------------------------------------------------

test("I11 — session cookie is set with no Domain attribute", () => {
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
  // Sanity: make sure this is really the cookie-setting line and not an empty match.
  assert.match(cookieExpr, /HttpOnly/i);
});
