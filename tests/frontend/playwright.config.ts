import { defineConfig, devices } from "@playwright/test";

/**
 * Owns the real origins (localhost:3000 and *.apps.localhost:3001): never run it with the backend suite or `npm run dev`.
 * Two chained projects: `foundation` (smoke, studio-ui, swap-runtime, data-runtime) needs an empty database for A1's "No apps yet", and must
 * finish before `rest`, whose files seed rows into the same database.
 */
export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: "./global-setup.ts",
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "foundation",
      testMatch: ["smoke.spec.ts", "studio-ui.spec.ts", "swap-runtime.spec.ts", "data-runtime.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "rest",
      testMatch: [
        "security.spec.ts",
        "app-data.spec.ts",
        "progressive.spec.ts",
        "error-states.spec.ts",
        "settings.spec.ts",
      ],
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["foundation"],
    },
  ],
});
