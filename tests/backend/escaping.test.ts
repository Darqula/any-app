/**
 * A7: errorBanner and the escaping of view output. Pins the html`...` contract and sweeps every exported view
 * with hostile text, which catches markup embedded the wrong way (escaped twice, or user text left raw).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorBanner } from "@any-app/protocol";
import * as views from "../../apps/studio/src/views";
import type { Html } from "../../apps/studio/src/views";
import { html, raw } from "../../apps/studio/src/views/escape";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../harness/db";
import { cssClasses } from "../harness/css";

test("A7.1 — errorBanner with <script> in the message: escaped, cannot break out of the <pre>", () => {
  const out = errorBanner("<script>alert(1)</script>");
  assert.equal(out.includes("<script>alert(1)</script>"), false);
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  // Still wrapped in exactly one <pre>...</pre> — the escaped payload cannot close it early.
  assert.equal((out.match(/<pre/g) ?? []).length, 1);
  assert.equal((out.match(/<\/pre>/g) ?? []).length, 1);
});

test('A7.2 — the escaping construct (via previewFrame) escapes a " in an attribute context', () => {
  const malicious = 'http://evil"><script>alert(1)</script>';
  const out = views.previewFrame("abc", malicious, "harmless-grant").toString();

  // No literal <script> may exist, and the attribute must not have been closed early.
  assert.equal(out.includes("<script>"), false);
  assert.ok(out.includes("&lt;script&gt;"));
  assert.ok(out.includes("&quot;"));

  // The src attribute's value is one unbroken quoted string ending at the real path.
  const srcStart = out.indexOf('src="');
  assert.ok(srcStart >= 0);
  const valueStart = srcStart + 'src="'.length;
  const valueEnd = out.indexOf('"', valueStart);
  const srcValue = out.slice(valueStart, valueEnd);
  assert.ok(srcValue.endsWith("/preview/abc?g=harmless-grant"));
  assert.equal(srcValue.includes('"'), false);
});

test("A7.3 — html`` escapes text, both quote kinds and numbers; booleans, null and undefined render nothing", () => {
  assert.equal(html`<p title="${`a"b'c`}">${"<&>"}${7}${false}${true}${null}${undefined}</p>`.toString(), `<p title="a&quot;b&#39;c">&lt;&amp;&gt;7</p>`);
});

test("A7.4 — nesting: an Html fragment is embedded as is (not escaped again), a plain string with the same text is escaped, arrays flatten", () => {
  const fragment = html`<b>${"<"}</b>`;
  assert.equal(html`<i>${fragment}</i>`.toString(), "<i><b>&lt;</b></i>");
  assert.equal(html`<i>${fragment.toString()}</i>`.toString(), "<i>&lt;b&gt;&amp;lt;&lt;/b&gt;</i>");
  assert.equal(html`<ul>${[html`<li>${"a"}</li>`, html`<li>${"<b>"}</li>`]}</ul>`.toString(), "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  assert.equal(views.join(raw("<a>"), raw("<b>")).toString(), "<a><b>");
});

test("A7.5 — a plain string is not Html: the type is nominal, so it cannot be passed where markup is expected", () => {
  // @ts-expect-error a string is not Html (typecheck fails here if the brand ever becomes structural)
  const notMarkup: Html = "<script>alert(1)</script>";
  assert.equal(typeof notMarkup, "string");
});

/** Hostile text that must come out inert wherever the views interpolate data. */
const HOSTILE = "<x-evil a=\"1\" b='2'>&</x-evil>";
const ESCAPED_HOSTILE = "&lt;x-evil a=&quot;1&quot; b=&#39;2&#39;&gt;&amp;&lt;/x-evil&gt;";

/** Every exported view, rendered with hostile data in each place it takes text. */
function renderEveryView(): Record<string, Html> {
  const id = HOSTILE;
  const anon = { kind: "anon", sessionId: "s" } as const;
  const user = { kind: "user", userId: "u", sessionId: "s" } as const;
  const generation = { id: "g1", prompt: HOSTILE, status: "complete" } as never;
  const hint = { provider: HOSTILE, hint: HOSTILE, validatedAt: new Date(0) } as never;
  const rows = [{ role: "planner", provider: HOSTILE, model: HOSTILE, maxTokens: 1 }] as never;
  const message = { seq: 1, role: "user", kind: "edit", target: HOSTILE, body: HOSTILE } as never;
  const missing = [{ message: HOSTILE }] as never;
  return {
    homeAnon: views.homePage([generation], missing, anon, null),
    homeUser: views.homePage([], [], user, HOSTILE),
    settingsAnon: views.settingsPage([hint], rows, anon, null),
    settingsUser: views.settingsPage([], rows, user, HOSTILE),
    sharedReadOnly: views.sharedAppPage(id, HOSTILE, "http://x", "g", "ro"),
    sharedOwner: views.sharedAppPage(id, HOSTILE, "http://x", "g", "rw"),
    notFound: views.notFoundPage(),
    ownerControls: views.ownerControls(id, "public", HOSTILE),
    remix: views.remixControl(id),
    editForm: views.editForm(id, [{ id }]),
    editApplied: views.editApplied(id, "http://x", { kind: "slot", id: HOSTILE }, { css: "", content: { [HOSTILE]: "<p>x</p>" } }),
    editProblem: views.editProblem(HOSTILE),
    problem: views.problem(HOSTILE),
    placeholder: views.placeholder(HOSTILE),
    editOk: views.editOk(HOSTILE),
    messages: views.messageItems([message], HOSTILE),
    chatLog: views.chatLogOob(id, views.messageItems([message])),
    oobSlot: views.oobSlot("edit-slot", views.editForm(id, [])),
    generationList: views.generationList([generation], () => false),
    banner: views.missingCredentialBanner(missing)!,
    preview: views.previewFrame(id, "http://x", HOSTILE, true),
    credentialList: views.credentialList([hint]),
    credentialSaved: views.credentialSaved(HOSTILE),
    roleTable: views.roleConfigTable(rows),
    sidebarFooterUser: views.sidebarFooter(user, HOSTILE),
    accountSectionUser: views.accountSection(user, HOSTILE),
  };
}

/** Exports that are not views. Every other export must be rendered by renderEveryView. */
const NOT_VIEWS = new Set(["join"]);
const RENDERED = [
  "previewFrame", "oobSlot", "messageItems", "chatLogOob", "editForm", "editApplied", "editProblem", "editOk", "problem", "placeholder",
  "generationList", "ownerControls", "remixControl", "sharedAppPage", "notFoundPage", "sidebarFooter", "accountSection", "authDialog",
  "credentialList", "credentialForm", "credentialSaved", "roleConfigTable", "settingsPage", "missingCredentialBanner", "homePage",
];

test("A7.6a — the sweep covers every exported view (a new export must be added to renderEveryView and RENDERED)", () => {
  const exported = Object.keys(views).filter((k) => !NOT_VIEWS.has(k)).sort();
  assert.deepEqual(exported, [...RENDERED].sort());
});

test("A7.6 — no view leaks hostile text as markup, and none escapes its own markup (the sweep)", () => {
  // Markup that must never show up escaped: a double-escaped fragment renders as visible tag text.
  const ESCAPED_MARKUP = /&lt;\/?(meta|link|div|li|ul|ol|p|span|form|label|input|select|option|button|section|header|h[1-6]|a|svg|path|iframe|dialog|details|summary|table|tr|td|th|script|html|head|body|title|code|strong)\b/i;
  for (const [name, view] of Object.entries(renderEveryView())) {
    const out = view.toString();
    assert.equal(out.includes("<x-evil"), false, `${name}: hostile text reached the output unescaped`);
    assert.doesNotMatch(out.replaceAll(ESCAPED_HOSTILE, ""), ESCAPED_MARKUP, `${name}: a fragment was escaped instead of embedded`);
  }
});

test("A7.7 — every full page carries the htmx config meta and script, unescaped (a missing meta hides every 4xx/5xx message)", () => {
  const pages = renderEveryView();
  for (const name of ["homeAnon", "homeUser", "settingsAnon", "settingsUser", "sharedReadOnly", "sharedOwner"] as const) {
    const out = pages[name]!.toString();
    assert.ok(/<meta name="htmx-config" content='\{"responseHandling"/.test(out), `${name}: no htmx-config meta`);
    assert.ok(out.includes('<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/'), `${name}: no htmx script`);
    assert.ok(out.includes('<link rel="stylesheet" href="/css/theme.css">'), `${name}: no theme stylesheet`);
  }
});

test("A7.8 — every class a rendered page or fragment uses is styled by a stylesheet that page links (a typo or a missing <link> would otherwise fail silently)", () => {
  const cssDir = path.join(REPO_ROOT, "apps", "studio", "public", "css");
  const sheets = new Map(
    readdirSync(cssDir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => [f.slice(0, -".css".length), cssClasses(readFileSync(path.join(cssDir, f), "utf8"))] as const),
  );
  const everySheet = new Set([...sheets.values()].flatMap((classes) => [...classes]));
  for (const [name, view] of Object.entries(renderEveryView())) {
    const out = view.toString();
    // A full page is checked against its own <link>s; a fragment (no <link>) against all sheets, since it lands in a page.
    const linked = [...out.matchAll(/href="\/css\/([\w-]+)\.css"/g)].map((m) => m[1]!);
    const available = linked.length > 0 ? new Set(linked.flatMap((sheet) => [...(sheets.get(sheet) ?? [])])) : everySheet;
    for (const attribute of out.matchAll(/class="([^"]*)"/g)) {
      for (const token of attribute[1]!.split(/\s+/).filter(Boolean)) {
        assert.ok(available.has(token), `${name}: class "${token}" has no rule${linked.length > 0 ? ` in the sheets it links (${linked.join(", ")})` : ""}`);
      }
    }
  }
});
