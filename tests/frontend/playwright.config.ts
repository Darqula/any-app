import { defineConfig, devices } from "@playwright/test";

/**
 * The frontend suite owns the real origins (localhost:3000 / *.apps.localhost:3001) — see
 * the README. It must never run concurrently with the backend suite (ephemeral ports) or
 * with `npm run dev` (same ports, real dev database).
 *
 * Two projects, chained by `dependencies`, to guarantee a run order Playwright's default
 * (alphabetical-by-file) discovery doesn't: `foundation` — smoke.spec.ts, studio-ui.spec.ts,
 * swap-runtime.spec.ts, data-runtime.spec.ts — assumes the shared server's database starts
 * genuinely empty (A1's "No apps yet" case, in both smoke.spec.ts and studio-ui.spec.ts,
 * only makes sense the very first time anything queries `listRecentGenerations()`). Every
 * other spec file seeds rows into that same shared database, some of them dozens per run,
 * so `foundation` has to finish first or A1 is checking a database several other files have
 * already populated. `dependencies` is what makes that ordering real instead of incidental:
 * Playwright runs `foundation` to completion (both files, in their own alphabetical order,
 * within one worker) before starting `rest`, in the same process, no matter how the two
 * project's own file lists sort against each other.
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
