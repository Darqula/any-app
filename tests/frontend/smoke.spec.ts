/** Proves the frontend harness works against a real Chromium: case A1 on an empty scratch database. Not part of the real suite. */
import { test, expect } from "@playwright/test";

test("fresh load, no generations: empty state, no iframe (A1)", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#generation-list")).toContainText("No apps yet. Describe one above.");
  await expect(page.locator("#stage")).toContainText("Your app will appear here.");
  await expect(page.locator("#stage iframe")).toHaveCount(0);
});
