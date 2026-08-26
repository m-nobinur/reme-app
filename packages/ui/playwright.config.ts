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
  // The default is threshold 0.2, a per-pixel colour tolerance wide enough that
  // a muted surface changing shape is invisible to it: rounded-2xl to
  // rounded-none on the skeleton passed with the same bytes. In a design system
  // where most surfaces are muted, that is most of the gate. So: exact
  // comparison. It is affordable because rendering here is deterministic —
  // five consecutive runs on macOS and two fresh containers on Linux all
  // reproduced the baselines to the pixel. If antialiasing ever does start to
  // drift, raise maxDiffPixels rather than threshold; the shape changes this
  // exists to catch are worth tens of pixels each, and a wide colour tolerance
  // hides them all.
  expect: {
    toHaveScreenshot: { threshold: 0, maxDiffPixels: 0 },
  },
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
