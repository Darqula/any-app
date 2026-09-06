/**
 * Proves the frontend harness works end to end against a real Chromium. Not part of the
 * real frontend suite (see .docs/tests-frontend.md for that) — this is case A1 against a
 * scratch database that legitimately has zero generations, no seeding required.
 */
import { test, expect } from "@playwright/test";

test("fresh load, no generations: empty state, no iframe (A1)", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#generation-list")).toContainText("No apps yet. Describe one above.");
  await expect(page.locator("#stage")).toContainText("Your app will appear here.");
  await expect(page.locator("#stage iframe")).toHaveCount(0);
});
