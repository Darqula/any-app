/**
 * A6 — createSlotStream.
 * Spec: .docs/tests-backend.md section A6. Target: packages/generator/src/slot-stream.ts.
 *
 * createSlotStream IS re-exported from @any-app/generator's index.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlotStream } from "@any-app/generator";

function run(chunks: string[]): { out: string; content: Record<string, string> } {
  const s = createSlotStream();
  let out = "";
  for (const c of chunks) out += s.push(c);
  out += s.flush();
  return { out, content: s.content };
}

test('A6.1 — one slot: <template id="c-x"> ... </template><script>swap("x")</script>', () => {
  const { out } = run(["===SLOT foo===\nHello\n"]);
  assert.equal(out, '<template id="c-foo">Hello\n</template><script>swap("foo")</script>\n');
});

test("A6.2 — three slots: each template closed and swapped before the next opens", () => {
  const { out, content } = run(["===SLOT a===\nA\n===SLOT b===\nB\n===SLOT c===\nC\n"]);
  assert.equal(
    out,
    '<template id="c-a">A\n</template><script>swap("a")</script>\n' +
      '<template id="c-b">B\n</template><script>swap("b")</script>\n' +
      '<template id="c-c">C\n</template><script>swap("c")</script>\n',
  );
  assert.deepEqual(content, { a: "A\n", b: "B\n", c: "C\n" });
  // Each close appears before the next open — no interleaving.
  assert.ok(out.indexOf("</template>") < out.indexOf('id="c-b"'));
  assert.ok(out.indexOf('swap("b")') < out.indexOf('id="c-c"'));
});

test('A6.3 — marker split as "===SLO" + "T timer===\\n" is still recognised', () => {
  const { out, content } = run(["===SLO", "T timer===\ncontent\n"]);
  assert.equal(out, '<template id="c-timer">content\n</template><script>swap("timer")</script>\n');
  assert.deepEqual(content, { timer: "content\n" });
});

test("A6.4 — marker with trailing spaces/tab is recognised", () => {
  const { out } = run(["===SLOT timer===  \t \nhi\n"]);
  assert.equal(out, '<template id="c-timer">hi\n</template><script>swap("timer")</script>\n');
});

test("A6.5 — prose before the first marker is dropped, not emitted", () => {
  const { out, content } = run(["prose before the first marker, should vanish\n===SLOT foo===\nreal\n"]);
  assert.equal(out, '<template id="c-foo">real\n</template><script>swap("foo")</script>\n');
  assert.equal(out.includes("prose before"), false);
  assert.deepEqual(content, { foo: "real\n" });
});

test("A6.6 — near-miss lines (==SLOT x==, ===SLOT===, ===slot x===) are treated as content, not markers", () => {
  // Before any slot has opened, a near-miss line does not open one either — dropped like
  // any other pre-marker prose (no `open` slot to attribute it to).
  assert.deepEqual(run(["==SLOT x==\nstuff\n"]), { out: "", content: {} });
  assert.deepEqual(run(["===SLOT===\nstuff\n"]), { out: "", content: {} });
  assert.deepEqual(run(["===slot x===\nstuff\n"]), { out: "", content: {} });

  // Inside an already-open slot, the same near-miss lines are ordinary content, verbatim —
  // they do not close the current template or open a new one.
  const a = run(["===SLOT foo===\n==SLOT x==\nreal\n"]);
  assert.equal(a.content.foo, "==SLOT x==\nreal\n");
  const b = run(["===SLOT foo===\n===SLOT===\nreal\n"]);
  assert.equal(b.content.foo, "===SLOT===\nreal\n");
  const c = run(["===SLOT foo===\n===slot x===\nreal\n"]);
  assert.equal(c.content.foo, "===slot x===\nreal\n");
});

test("A6.7 — stream ends with a slot open: flush() closes the template and emits the swap", () => {
  const { out, content } = run(["===SLOT foo===\nno trailing newline before end"]);
  assert.equal(
    out,
    '<template id="c-foo">no trailing newline before end\n</template><script>swap("foo")</script>\n',
  );
  assert.equal(content.foo, "no trailing newline before end\n");
});

test("A6.8 — stream with no markers at all: empty output, no throw", () => {
  const { out, content } = run(["just prose, no markers at all\nmore prose\n"]);
  assert.equal(out, "");
  assert.deepEqual(content, {});
});

test("A6.9 — content map after completion: keys and values match what was emitted per slot", () => {
  const { out, content } = run(["===SLOT a===\nfirst\nsecond\n"]);
  assert.deepEqual(content, { a: "first\nsecond\n" });
  // Every line of the accumulated content also appears in the emitted output.
  assert.ok(out.includes("first\n"));
  assert.ok(out.includes("second\n"));
});

test("A6.10 — slot id in the swap call is JSON-escaped, so a hyphenated id is quoted correctly", () => {
  const { out } = run(["===SLOT my-slot===\nhi\n"]);
  assert.ok(out.includes('swap("my-slot")'));
  assert.equal(out, '<template id="c-my-slot">hi\n</template><script>swap("my-slot")</script>\n');
});

test("A6.11 — content containing the literal </template>: documents current (broken) behaviour", () => {
  // Accepted as a known limitation in the Phase 2 plan: createSlotStream forwards slot
  // content verbatim with no escaping. If the model's output happens to contain the literal
  // string "</template>", the emitted HTML contains it unescaped — a real browser parsing
  // this stream would close the <template> element early, right there in the content,
  // rather than at the intended slotClose() call. Everything after that point (the rest of
  // the slot's content, the real closing </template>, and the <script>swap(...)</script>)
  // would then be parsed as ordinary top-level document content instead of inert template
  // contents, which is not what the streaming design intends. This test pins the current
  // string-level output — it does not simulate an HTML parser — and exists so a future
  // change to this behaviour is a deliberate, visible diff rather than an accidental one.
  const { out, content } = run(["===SLOT foo===\nsome content with a literal </template> tag embedded\n"]);

  assert.equal(
    out,
    '<template id="c-foo">some content with a literal </template> tag embedded\n' +
      '</template><script>swap("foo")</script>\n',
  );
  // The literal tag from the model's content and the real, intended closing tag both
  // appear, unescaped, as plain substrings — a browser would only ever see the first one.
  const firstClose = out.indexOf("</template>");
  const secondClose = out.indexOf("</template>", firstClose + 1);
  assert.ok(firstClose >= 0 && secondClose > firstClose, "two </template> occurrences expected");
  assert.equal(content.foo, "some content with a literal </template> tag embedded\n");
});
