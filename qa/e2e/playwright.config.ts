import { existsSync } from "node:fs"
import { defineConfig, devices } from "@playwright/test"
import { STORAGE_STATE } from "./workos"

/**
 * The owner smoke path: sign in, dashboard, org tree, the chat, the approvals
 * inbox. `@live` specs sign up an owner with an organisation and write rows,
 * so the blocking smoke skips them (`--grep-invert @live`).
 *
 * It targets a base URL and nothing else. There is no dev server started here
 * and no environment named in the suite, so the same run answers for a local
 * `pnpm dev`, for staging, and for a per-PR preview. Point `E2E_BASE_URL` at
 * it. Preview hostnames are `https://pr-<number>-reme-web.beapp.workers.dev`,
 * and WorkOS accepts them through a wildcard redirect URI, so a preview run
 * needs no per-PR provisioning. What the suite needs from wherever it points is
 * a WorkOS environment it can create a user on, which is `staging` for all
 * three (one environment this phase).
 *
 * Everything it asserts is a read, and that is a constraint rather than a
 * preference. A preview deploy reads the staging database, so two open PRs and
 * staging itself share one set of rows, and a scenario that seeded or mutated
 * anything would pass alone and collide the moment a second PR was open. The
 * only thing this suite creates anywhere is one throwaway WorkOS account per
 * run, on an address unique to that run, deleted in the teardown.
 *
 * Nothing here writes a screenshot baseline. Traces, videos and `test-results/`
 * are regenerable binaries and stay out of git, which is why the trace setting
 * below writes only on a failure and only into the gitignored output directory.
 */

// The same guarded load the rest of the repo uses (packages/db/src/client.ts).
// CI has no file and passes the values as environment variables instead.
const ENV_FILE = new URL("../../.env.local", import.meta.url)
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE)
}

export default defineConfig({
  testDir: ".",
  // `@live` writes tenant rows it cannot delete, so it runs only when asked
  // for by name: `pnpm e2e --grep @live`.
  grepInvert: process.argv.some((arg) => arg.includes("@live"))
    ? undefined
    : /@live/,
  forbidOnly: !!process.env.CI,
  // A flaky end-to-end test is a defect in the suite or in the app, and a retry
  // is how it stops being reported as either. Anything that fails here is meant
  // to be read, not re-run.
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  // The onboarding walk-through is a dozen server round trips.
  timeout: 60_000,
  // Wider than Playwright's 5 s default because the target is a deployed
  // Worker. A cold isolate answered /health in 1.3 s on staging, and every
  // assertion here waits on a server round trip rather than on local paint.
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      // Creates the run's throwaway account and signs in through the real form.
      // Every other project reuses the session it seals, so one run is one
      // sign-in attempt against the rate limiter rather than one per test.
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      teardown: "cleanup",
    },
    {
      // A project rather than `globalTeardown`, so a failure to delete the
      // probe account is a reported test failure rather than a line in a log.
      name: "cleanup",
      testMatch: /auth\.cleanup\.ts/,
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
      testMatch: /.*\.spec\.ts/,
    },
  ],
})
