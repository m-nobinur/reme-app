import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { repoMap } from "../src/repo-map.ts"
import {
  SEED_DIGEST,
  SEED_FIELDS,
  STARTER_FILES,
  siteHost,
} from "../src/seed.ts"

const repo = fileURLToPath(new URL("../../../", import.meta.url))
const tracked = (dir: string) =>
  execSync(`git ls-files ${dir}`, { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n")

/** Pages the starter ships that a first build does not seed (ruling 4). */
const HELD_BACK = ["src/pages/quote.astro", "src/pages/booking.astro"]

describe("the seed", () => {
  it("is the starter-site package's config and src, less the held-back pages", () => {
    const expected = tracked("packages/starter-site")
      .map((path) => path.slice("packages/starter-site/".length))
      .filter(
        (path) =>
          (path.startsWith("src/") && !HELD_BACK.includes(path)) ||
          ["astro.config.mjs", "tsconfig.json", ".gitignore"].includes(path)
      )
    expect(Object.keys(STARTER_FILES).sort()).toEqual(
      [...expected, "package.json"].sort()
    )
  })

  it("carries the files byte for byte, with the sandbox image's package.json", () => {
    for (const [path, content] of Object.entries(STARTER_FILES)) {
      const source =
        path === "package.json"
          ? "infra/sandbox/astro/package.json"
          : `packages/starter-site/${path}`
      expect(content, path).toBe(readFileSync(`${repo}${source}`, "utf8"))
    }
  })

  it("parses the starter's fields, the required facts first", () => {
    expect(Object.keys(SEED_FIELDS).slice(0, 6)).toEqual([
      "businessName",
      "phone",
      "email",
      "weekdayHours",
      "serviceArea",
      "standardCleanHourly",
    ])
  })

  it("maps the whole seed, so the Developer sees every page and the site config", () => {
    expect(repoMap(STARTER_FILES)).not.toContain("[Map cut")
  })

  it("digests every component manifest the package commits", () => {
    const manifests = JSON.parse(
      readFileSync(`${repo}packages/starter-site/manifests.json`, "utf8")
    ) as { component: string }[]
    const lines = SEED_DIGEST.split("\n")
    expect(lines).toHaveLength(manifests.length)
    for (const { component } of manifests) {
      expect(lines.some((line) => line.startsWith(`${component} (`))).toBe(true)
    }
  })
})

describe("the site host", () => {
  it("joins the org's slug to the environment's suffix", () => {
    expect(siteHost("brightclean", "-stg.remeai.co.uk")).toBe(
      "brightclean-stg.remeai.co.uk"
    )
    expect(siteHost("mopandbucket", ".remeai.co.uk")).toBe(
      "mopandbucket.remeai.co.uk"
    )
  })

  it("refuses a slug or suffix that could reach the shell or leave the zone", () => {
    for (const [slug, suffix] of [
      ["bright clean", ".remeai.co.uk"],
      ["brightclean;rm -rf /", ".remeai.co.uk"],
      ["-brightclean", ".remeai.co.uk"],
      ["", ".remeai.co.uk"],
      ["brightclean", ".remeai.co.uk $(id)"],
      ["brightclean", ""],
    ] as const) {
      expect(() => siteHost(slug, suffix), `${slug}|${suffix}`).toThrow()
    }
  })
})
