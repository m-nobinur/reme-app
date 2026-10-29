import { defineConfig, devices } from "@playwright/test"

// Baselines are gitignored, so the visual comparison is a local gate: write
// them once with `pnpm --filter @workspace/ui test:update`, then run the suite
// before a change and after it. They stay keyed by platform because the same
// Chromium rasterises text differently on macOS and on Linux, so a set carried
// between machines would fail on every glyph.
// The catalog server's port, overridable because 4321 is not always ours.
// `reuseExistingServer` is on locally, so a second worktree on the same machine
// silently runs this suite against the *other* worktree's catalog and reports a
// pass for components it has never seen. Measured: a run here read the entries
// from a sibling checkout and failed on primitives it did not have.
const PORT = Number(process.env.CATALOG_PORT ?? 4321)

export default defineConfig({
  testDir: "./test",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? undefined : 3,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}` },
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
  // Playwright's default is `missing`, which writes a baseline it cannot find
  // and fails the test for having written it. That is indistinguishable from
  // `--update-snapshots` at the config level, which is what the guard in the
  // suite reads, so state it: a plain run never writes, and only the CLI flag
  // that `test:update` passes overrides this back.
  updateSnapshots: "none",
  // `threshold: 0` meant byte-identical, and rendering here is not quite that.
  // Measured on the `ToolGroup` entry, which failed roughly one run in three in
  // either theme: five to forty-nine pixels differed, and the largest
  // difference on any channel was **1 of 255**, 0.0039 in the normalised space
  // this option uses. That is rasteriser rounding, invisible, and it was
  // failing a gate meant to catch shape changes.
  //
  // So 0.01, which is above that noise floor and twenty times tighter than
  // Playwright's 0.2 default. `maxDiffPixels: 0` is untouched and is what
  // still does the work: a rounded-2xl to rounded-none change moves pixels by
  // most of the colour space, so every one of them is still counted, and one
  // is enough to fail. Widening `threshold` further is what hides those, which
  // is why the number is a measurement rather than a round figure.
  expect: {
    toHaveScreenshot: { threshold: 0.01, maxDiffPixels: 0 },
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
    command: `pnpm catalog --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
  },
})
