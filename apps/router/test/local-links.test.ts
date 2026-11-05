import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { URL } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Local dev's site links (`.reme.localhost`, http, `SITE_PORT`) come from
 * `.dev.vars` alone, which no deploy uploads. A committed config that named
 * them would point staging's or production's preview links, claims and
 * publish probe at the owner's own machine, so none may.
 */
describe("the deployed configs", () => {
  for (const app of ["api", "orchestrator", "router"]) {
    it(`${app} names no local site host and no site port`, () => {
      const config = readFileSync(
        new URL(`../../${app}/wrangler.jsonc`, import.meta.url),
        "utf8"
      )
      const suffixes = [
        ...config.matchAll(/"SITE_HOST_SUFFIX":\s*"([^"]*)"/g),
      ].map((match) => match[1])
      expect(suffixes.length).toBeGreaterThan(0)
      for (const suffix of suffixes) expect(suffix).not.toMatch(/localhost/)
      expect(config).not.toMatch(/SITE_PORT/)
    })
  }
})

describe("ensureLocalSites", () => {
  const lib = String(new URL("../../../scripts/lib.mjs", import.meta.url))
  const setup = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "sites-"))
    for (const [app, text] of Object.entries(files)) {
      mkdirSync(join(root, "apps", app), { recursive: true })
      writeFileSync(join(root, "apps", app, ".dev.vars"), text)
    }
    return root
  }
  const read = (root: string, app: string) =>
    readFileSync(join(root, "apps", app, ".dev.vars"), "utf8")

  it("tops up a stale file and makes the router's with the orchestrator's signing key", async () => {
    const { ensureLocalSites } = await import(lib)
    const root = setup({
      api: "OPENROUTER_MODEL=a",
      orchestrator: "PREVIEW_KEY=secret\nOPENROUTER_API_KEY=b\n",
    })
    ensureLocalSites(root)
    expect(read(root, "api")).toBe(
      "OPENROUTER_MODEL=a\nSITE_HOST_SUFFIX=.reme.localhost\nSITE_PORT=3004\n"
    )
    expect(read(root, "orchestrator")).toContain(
      "SITE_HOST_SUFFIX=.reme.localhost\nSITE_PORT=3004\n"
    )
    expect(read(root, "router")).toBe(
      "SITE_HOST_SUFFIX=.reme.localhost\nPREVIEW_KEY=secret\n"
    )
  })

  it("keeps a suffix the file already names, creates no api file and is a no-op the second time", async () => {
    const { ensureLocalSites } = await import(lib)
    const root = setup({
      orchestrator: "SITE_HOST_SUFFIX=.custom\nSITE_PORT=1\nPREVIEW_KEY=k\n",
    })
    ensureLocalSites(root)
    expect(read(root, "orchestrator")).toBe(
      "SITE_HOST_SUFFIX=.custom\nSITE_PORT=1\nPREVIEW_KEY=k\n"
    )
    expect(existsSync(join(root, "apps", "api", ".dev.vars"))).toBe(false)
    expect(ensureLocalSites(root)).toEqual([])
  })
})
