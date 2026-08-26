import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

const COMPONENTS_DIR = fileURLToPath(
  new URL("../src/components", import.meta.url)
)

/**
 * The exported component names of one file. A component export is PascalCase,
 * which is what separates it from the variant helpers, class strings and
 * constants the same files export. `export type { … }` is skipped: a type has
 * nothing to render.
 */
function exportedComponents(source: string): string[] {
  return [...source.matchAll(/(?<!type\s)export\s\{([^}]*)\}/g)]
    .flatMap((match) => match[1].split(","))
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

  const missing = readdirSync(COMPONENTS_DIR)
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) =>
      exportedComponents(
        readFileSync(
          new URL(`../src/components/${file}`, import.meta.url),
          "utf8"
        )
      ).map((name) => ({ file, name }))
    )
    .filter((component) => !listed.has(component.name))

  expect(
    missing,
    "a primitive without a catalog entry has no a11y test and no visual snapshot"
  ).toEqual([])
})

for (const theme of ["light", "dark"] as const) {
  test(`catalog has no accessibility violations in ${theme}`, async ({
    page,
  }) => {
    await page.goto(`/?theme=${theme}`)

    for (const name of await entryNames(page)) {
      const results = await new AxeBuilder({ page })
        // WCAG 2.2 AA, which is the bar this design system is held to. The
        // best-practice rules are left out on purpose: they flag the catalog
        // harness itself, not the primitives it renders.
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
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
    await page.goto(`/?theme=${theme}`)
    // The variable font loads from node_modules through Vite; without this the
    // first snapshot of a run is taken mid-swap and every later one is not.
    await page.evaluate(() => document.fonts.ready)

    for (const name of await entryNames(page)) {
      await expect
        .soft(page.locator(`[data-entry="${name}"]`))
        .toHaveScreenshot(`${name}-${theme}.png`)
    }
  })
}
