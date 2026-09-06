/**
 * A1 — createFenceStripper, A2 — stripTrailingFence / createTrailingFenceGuard.
 * Spec: .docs/tests-backend.md section A1/A2. Target: packages/generator/src/fence-stripper.ts.
 *
 * `createFenceStripper` is not re-exported from @any-app/generator's index.ts (only
 * `stripTrailingFence` and `createTrailingFenceGuard` are) — see index.ts's export list.
 * It IS exported from its own module, though, so a relative import reaches it without
 * touching any production file. Reported as a finding in the final summary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFenceStripper,
  stripTrailingFence,
  createTrailingFenceGuard,
} from "../../packages/generator/src/fence-stripper";

function runStripper(chunks: string[]): string {
  const strip = createFenceStripper();
  let out = "";
  for (const chunk of chunks) out += strip(chunk);
  return out;
}

// ---- A1 ----

test("A1.1 — plain HTML, one chunk: output is byte-identical to input", () => {
  const input = "<html><body>Hi</body></html>";
  assert.equal(runStripper([input]), input);
});

test("A1.2 — ```html\\n<html> in one chunk: fence line removed, <html> kept", () => {
  assert.equal(runStripper(["```html\n<html>"]), "<html>");
});

test('A1.3 — fence split as "`", "``html\\n", "<div>": fence removed, <div> kept', () => {
  assert.equal(runStripper(["`", "``html\n", "<div>"]), "<div>");
});

test("A1.4 — leading whitespace-only chunks, then content: whitespace dropped, no content lost", () => {
  assert.equal(runStripper(["   \n  ", "\t", "Hello world"]), "Hello world");
});

test("A1.5 — content legitimately starting with two backticks (``x): passed through unchanged", () => {
  assert.equal(runStripper(["``x"]), "``x");
  // Same property when the two backticks and the disambiguating byte land in separate
  // chunks — the state machine must not commit to "this is a fence" on partial evidence.
  assert.equal(runStripper(["``", "x rest"]), "``x rest");
});

test("A1.6 — property: any input, any chunking, concatenated output loses no non-fence bytes", () => {
  // Seeded PRNG (mulberry32) so a failure is reproducible from the logged seed alone.
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomSplit(doc: string, rand: () => number): string[] {
    if (doc.length === 0) return [""];
    // Random number of cut points, biased toward small chunks so the fence-decision
    // boundary (the state machine's early-exit path) gets exercised often.
    const cuts = new Set<number>();
    const numCuts = Math.floor(rand() * doc.length);
    for (let i = 0; i < numCuts; i++) cuts.add(1 + Math.floor(rand() * (doc.length - 1)));
    const points = [0, ...[...cuts].sort((a, b) => a - b), doc.length];
    const chunks: string[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      chunks.push(doc.slice(points[i]!, points[i + 1]!));
    }
    return chunks;
  }

  // Fixed documents: with a leading fence, without one, and one that legitimately opens
  // with two backticks that are not a fence — the three shapes the state machine branches
  // on.
  const documents = [
    '```html\n<div class="a">Hello</div>\n<p>World `backticks` inline</p>\n```\n',
    '<div class="plain">No fence here at all, just ordinary HTML content that is long ' +
      "enough to be split many different ways across many chunks.</div>",
    "``almost a fence but the third character breaks it, followed by enough padding text " +
      "to make random splitting land inside the disambiguation window sometimes.",
    "   \n\t  ```json\n{\"a\":1}\n```\ntrailing content after an inner fence-looking line",
  ];

  const SEED = 20260901;
  const rand = mulberry32(SEED);
  const TRIALS = 300;

  for (let trial = 0; trial < TRIALS; trial++) {
    const doc = documents[trial % documents.length]!;
    // Oracle: a single whole-string chunk always resolves the fence decision correctly
    // (no ambiguity possible with the entire input available at once).
    const expected = runStripper([doc]);

    const chunks = randomSplit(doc, rand);
    const actual = runStripper(chunks);

    assert.equal(
      actual,
      expected,
      `trial ${trial} (seed ${SEED}) failed for doc index ${trial % documents.length}; ` +
        `split = ${JSON.stringify(chunks)}`,
    );
  }
});

// ---- A2 ----

test("A2.1 — document ending </html>\\n``` : fence and surrounding whitespace removed", () => {
  assert.equal(stripTrailingFence("<html>hi</html>\n```"), "<html>hi</html>");
});

test("A2.2 — document with backticks in the middle: untouched", () => {
  const doc = "Look at this: ```js\nconsole.log(1)\n``` and then more text after it.";
  assert.equal(stripTrailingFence(doc), doc);
});

test("A2.3 — guard: input longer than holdBack (16), everything but the last 16 bytes emitted during push", () => {
  const guard = createTrailingFenceGuard();
  const s = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
  const emitted = guard.push(s);
  assert.equal(emitted, s.slice(0, s.length - 16));
  assert.equal(emitted.length, s.length - 16);
});

test("A2.4 — guard: input shorter than holdBack, push emits nothing, flush emits all of it", () => {
  const guard = createTrailingFenceGuard();
  const s = "short"; // 5 chars < 16
  assert.equal(guard.push(s), "");
  assert.equal(guard.flush(), s);
});

test("A2.5 — guard: push output + flush output equals input minus the trailing fence", () => {
  const doc = "<html><body>hello world, a decently long body here</body></html>\n```";
  const expected = stripTrailingFence(doc);
  for (const chunkSize of [1, 3, 7, 16, 50, 1000]) {
    const guard = createTrailingFenceGuard();
    let out = "";
    for (let i = 0; i < doc.length; i += chunkSize) out += guard.push(doc.slice(i, i + chunkSize));
    out += guard.flush();
    assert.equal(out, expected, `chunkSize=${chunkSize}`);
  }
});

test("A2.6 — guard: fence preceded by >16 chars of whitespace documents the known limit", () => {
  // holdBack (16) only ever holds back the LAST 16 bytes seen so far. When the trailing
  // fence is preceded by more whitespace than that, the leading portion of that whitespace
  // has already been emitted as ordinary content by the time enough bytes have arrived to
  // know a fence is coming — so it is never available to be stripped. This is a known,
  // accepted limit (documented in tests-backend.md's A2.6), not a bug to fix: the result is
  // some stray trailing whitespace, not a leaked ``` marker (the marker itself, being the
  // very last 3 bytes, is always within the held-back window and does get stripped).
  const content = "<div>Content</div>";
  const doc = content + " ".repeat(20) + "```";

  const guard = createTrailingFenceGuard();
  const pushed = guard.push(doc);
  const flushed = guard.flush();
  const combined = pushed + flushed;

  // Verified current behaviour: 7 stray trailing spaces survive (20 + 3 = 23 trailing
  // bytes; only the last 16 are ever held back, so the first 23-16=7 leak out via push).
  assert.equal(combined, content + " ".repeat(7));
  assert.notEqual(combined, stripTrailingFence(doc), "the known limit: this is NOT fully clean");
});
