import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

/**
 * pnpm installs a package once per peer set, so @assistant-ui/react exists
 * twice (the `ai` peer is zod 3 for packages/ui, zod 4 for the app), each
 * with its own core. Left alone, Vite bundles both: a history adapter given
 * to one copy is invisible to the runtime built from the other, and a
 * reloaded conversation opens empty. Every package installed more than once
 * must be deduped in the web config.
 */
it("dedupes every @assistant-ui package pnpm installed more than once", () => {
  const store = fileURLToPath(
    new URL("../../../../node_modules/.pnpm", import.meta.url)
  )
  const installs = new Map<string, number>()
  for (const dir of readdirSync(store)) {
    const found = /^@assistant-ui\+([a-z-]+)@\d/.exec(dir)
    if (found?.[1]) installs.set(found[1], (installs.get(found[1]) ?? 0) + 1)
  }
  const config = readFileSync(
    fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    "utf8"
  )
  const missing = [...installs]
    .filter(
      ([name, copies]) =>
        copies > 1 && !config.includes(`"@assistant-ui/${name}"`)
    )
    .map(([name]) => `@assistant-ui/${name}`)
  expect(missing).toEqual([])
})
