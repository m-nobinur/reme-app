import { defineConfig, devices } from "@playwright/test"

// Screenshots are platform-specific: the same Chromium rasterises text
// differently on macOS and on Linux, so the baselines are kept per platform and
// CI compares against the Linux set. Regenerate the Linux set with
// `pnpm --filter @workspace/ui snapshots:linux`.
export default defineConfig({
  testDir: "./test",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:4321" },
  projects: [
    {
      name: "chromium",
      // A fixed viewport, or a snapshot changes with whatever window it was
      // taken in. Set after the device spread, which carries one of its own.
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1024, height: 768 },
      },
    },
  ],
  webServer: {
    command: "pnpm catalog",
    url: "http://localhost:4321",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
  },
})
