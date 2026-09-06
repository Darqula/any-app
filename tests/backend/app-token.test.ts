/**
 * A8 — mintAppToken / verifyAppToken / UUID_PATTERN.
 * Spec: .docs/tests-backend.md section A8. Target: packages/protocol/src/app-token.ts.
 *
 * All exported directly from @any-app/protocol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintAppToken, verifyAppToken, UUID_PATTERN } from "@any-app/protocol";

const ID = "12345678-1234-1234-1234-123456789012";
const SECRET = "s3cr3t-test-secret";

test("A8.1 — round trip: verifyAppToken(mintAppToken(id, s), s) === id", () => {
  const token = mintAppToken(ID, SECRET);
  assert.equal(verifyAppToken(token, SECRET), ID);
});

test("A8.2 — different secret: null", () => {
  const token = mintAppToken(ID, SECRET);
  assert.equal(verifyAppToken(token, "a-completely-different-secret"), null);
});

test("A8.3 — one character of the MAC changed: null", () => {
  const token = mintAppToken(ID, SECRET);
  const lastChar = token.slice(-1);
  const flipped = lastChar === "A" ? "B" : "A";
  const tampered = token.slice(0, -1) + flipped;
  assert.equal(verifyAppToken(tampered, SECRET), null);
});

test("A8.4 — app id swapped for another valid uuid, MAC left alone: null (the id is signed, not merely carried)", () => {
  const token = mintAppToken(ID, SECRET);
  const otherId = "87654321-4321-4321-4321-210987654321";
  const macPart = token.slice(token.lastIndexOf("."));
  assert.equal(verifyAppToken(otherId + macPart, SECRET), null);
});

test('A8.5 — "", "no-dot", ".mac", a token with no MAC: null, no throw', () => {
  assert.equal(verifyAppToken("", SECRET), null);
  assert.equal(verifyAppToken("no-dot", SECRET), null);
  assert.equal(verifyAppToken(".mac", SECRET), null);
  assert.equal(verifyAppToken(ID, SECRET), null); // a valid uuid alone, no "." at all
});

test("A8.6 — UUID_PATTERN rejects 36 a's, 36 hyphens, and misplaced-hyphen groupings", () => {
  assert.equal(UUID_PATTERN.test("a".repeat(36)), false);
  assert.equal(UUID_PATTERN.test("-".repeat(36)), false);
  // Right character count and right hyphen count, wrong grouping (9-3-4-4-12 instead of
  // 8-4-4-4-12) — the hyphens must be anchored by position, not just counted.
  assert.equal(UUID_PATTERN.test("123456789-123-1234-1234-123456789012"), false);
  // The two forms Postgres's own uuid parser accepts but this pattern deliberately does not.
  assert.equal(UUID_PATTERN.test("f47ac10b58cc4372a5670e02b2c3d479"), false); // 32 hex, no hyphens
  assert.equal(UUID_PATTERN.test("{f47ac10b-58cc-4372-a567-0e02b2c3d479}"), false); // brace-wrapped
});

test("A8.7 — UUID_PATTERN accepts gen_random_uuid() output, both cases", () => {
  assert.equal(UUID_PATTERN.test("f47ac10b-58cc-4372-a567-0e02b2c3d479"), true);
  assert.equal(UUID_PATTERN.test("F47AC10B-58CC-4372-A567-0E02B2C3D479"), true);
});

test("A8.8 — determinism: minting the same id twice yields the same string", () => {
  // This is the entire reason a token is derived rather than stored: re-rendering a
  // document (which every edit does) must reproduce the same token, not a new random one,
  // or an edited app would be silently disconnected from its own rows.
  assert.equal(mintAppToken(ID, SECRET), mintAppToken(ID, SECRET));
});
