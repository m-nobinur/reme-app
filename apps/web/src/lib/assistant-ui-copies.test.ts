import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

/**
 * pnpm installs a package once per peer set, so @assistant-ui/react once
 * existed twice (the `ai` peer resolved zod 3 for packages/ui, zod 4 for the
 * app), each with its own core. Vite bundled both: a history adapter given to
 * one copy was invisible to the runtime built from the other, and a reloaded
 * conversation opened empty. The lockfile is what installs, so its snapshots
 * are counted: every package with more than one must be deduped in the web
 * config.
 */
it("dedupes every @assistant-ui package pnpm installs more than once", () => {
  const lock = readFileSync(
    fileURLToPath(new URL("../../../../pnpm-lock.yaml", import.meta.url)),
    "utf8"
  )
  const installs = new Map<string, number>()
  for (const [, name] of lock.matchAll(
    /^ {2}'@assistant-ui\/([a-z-]+)@[\d.]+\(/gm
  )) {
    if (name) installs.set(name, (installs.get(name) ?? 0) + 1)
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
