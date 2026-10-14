import { readFileSync } from "node:fs"
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
