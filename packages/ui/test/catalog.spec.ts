import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { WCAG } from "./helpers"

const COMPONENTS_DIR = fileURLToPath(
  new URL("../src/components", import.meta.url)
)

/**
 * Where `snapshotPathTemplate` puts this platform's baselines. They are
 * gitignored, so a fresh clone and CI have none, and Playwright's answer to a
 * missing baseline is to write it and fail — which would make the first run
 * anywhere red for a reason that is not a regression. The snapshot tests skip
 * instead, and report as skipped rather than passing.
 */
const BASELINES = fileURLToPath(
  new URL(`./__screenshots__/${process.platform}`, import.meta.url)
)

/**
 * Every way a component can leave a file: a declaration exported where it
 * stands, with or without `default`, and an export block at the foot. Only the
 * block was matched at first, which meant `export function Thing() {}` added a
 * primitive with no catalog entry, no a11y scan and no snapshot, and this suite
 * stayed green. `export type { … }` matches neither branch, because `type` is
 * not one of the declaration keywords and it does not sit directly before `{`.
 */
const EXPORTED =
  /export\s+(?:default\s+)?(?:(?:async\s+)?function\s*\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)|export\s+\{([^}]*)\}/g

/**
 * The exported component names of one file. A component export is PascalCase,
 * which is what separates it from the variant helpers, class strings and
 * constants the same files export.
 */
function exportedComponents(source: string): string[] {
  return [...source.matchAll(EXPORTED)]
    .flatMap((match) => match[1] ?? (match[2] ?? "").split(","))
    .map((name) => name.trim())
    .filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name))
}

/** The catalog entry names on the page, in the order they render. */
async function entryNames(page: Page): Promise<string[]> {
  return await page
    .locator("[data-entry]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.entry ?? "")
    )
}

test("every primitive in the package has a catalog entry", async ({ page }) => {
  await page.goto("/")
  const listed = new Set(await entryNames(page))

  // Recursive: a component in src/components/<anything>/ is still a component,
  // and a flat read let one hide in a subdirectory.
  const missing = readdirSync(COMPONENTS_DIR, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) =>
      exportedComponents(readFileSync(join(COMPONENTS_DIR, file), "utf8")).map(
        (name) => ({ file, name })
      )
    )
    .filter((component) => !listed.has(component.name))

  expect(
    missing,
    "a primitive without a catalog entry has no a11y test and no visual snapshot"
  ).toEqual([])

  // An entry that renders nothing satisfies all three gates and asserts none of
  // them: axe finds no violations in an empty box and the snapshot of one is a
  // blank PNG that matches itself forever. Each section holds its heading plus
  // whatever the entry rendered, so one child means the entry rendered nothing.
  const blank = await page
    .locator("[data-entry]")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.childElementCount < 2)
        .map((node) => (node as HTMLElement).dataset.entry ?? "")
    )

  expect(blank, "a catalog entry that renders nothing tests nothing").toEqual(
    []
  )
})

test("the theme toggle flips the document and remembers it", async ({
  page,
}) => {
  // The catalog reads ?theme=dark so a test can have a theme on first paint,
  // which means the mechanism apps/web actually ships — the class on <html> and
  // the localStorage key behind it — is never exercised by the theme runs
  // below. This is the one place that drives it.
  await page.goto("/")
  const toggle = page.locator('[data-entry="ThemeToggle"] button')
  const stored = () =>
    page.evaluate(() => window.localStorage.getItem("reme-theme"))

  await toggle.click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  expect(await stored()).toBe("dark")

  await toggle.click()
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  expect(await stored()).toBe("light")
})

for (const theme of ["light", "dark"] as const) {
  test(`catalog has no accessibility violations in ${theme}`, async ({
    page,
  }) => {
    // One axe run per entry: with the live panel's states the catalog took
    // 25 to 30 s on a loaded machine, against the 30 s default, and with the
    // onboarding cards and thread fixtures it passed 90 s under a full suite.
    test.setTimeout(180_000)
    // Entries fade in, and a scan mid-fade reads text at a fraction of its
    // colour; every entrance is `motion-safe:`, so reduced motion shows it
    // settled.
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(`/?theme=${theme}`)

    for (const name of await entryNames(page)) {
      const results = await new AxeBuilder({ page })
        .withTags(WCAG)
        .include(`[data-entry="${name}"]`)
        .analyze()

      expect
        .soft(
          results.violations.map((violation) => `${name}: ${violation.id}`),
          JSON.stringify(results.violations, null, 2)
        )
        .toEqual([])
    }
  })

  test(`catalog matches its snapshots in ${theme}`, async ({ page }) => {
    // Not while writing them: the skip is what a run with no baselines does,
    // and applying it to `test:update` as well left the first run on a machine
    // with nothing to write into and nothing to compare against ever after.
    test.skip(
      !existsSync(BASELINES) && test.info().config.updateSnapshots === "none",
      "no baselines on this machine: pnpm --filter @workspace/ui test:update"
    )
    // One screenshot per entry, and the catalog outgrew the default 30 s.
    test.setTimeout(90_000)
    await page.goto(`/?theme=${theme}`)
    // The variable font loads from node_modules through Vite; without this the
    // first snapshot of a run is taken mid-swap and every later one is not.
    await page.evaluate(() => document.fonts.ready)

    // A fixture thread is meant to be taller than its conversation, so the
    // viewport sits at the bottom and this button stays hidden. A thread that
    // overflows its box even for one layout pass latches the opposite, and off
    // screen on this page nothing re-evaluates it, so the button's visibility
    // becomes a property of how the run walked the page rather than of the
    // component. That is what made these entries fail only under load. Assert
    // the invariant here, where a too-tight height says so.
    await expect(
      page.locator(".aui-thread-scroll-to-bottom:visible"),
      "a fixture thread is overflowing its box: give it more height"
    ).toHaveCount(0)

    for (const name of await entryNames(page)) {
      // Two pixels of slack: WorkspaceShell's panel inset rounds a sub-pixel
      // edge either way between runs (one pixel, 2026-10-01), and a real
      // change moves far more than two.
      await expect
        .soft(page.locator(`[data-entry="${name}"]`))
        .toHaveScreenshot(`${name}-${theme}.png`, { maxDiffPixels: 2 })
    }
  })
}
