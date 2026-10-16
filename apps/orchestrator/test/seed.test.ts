import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type FactRecord, siteHost } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { repoMap } from "../src/repo-map.ts"
import {
  QUOTE_FORM_FILE,
  quoteFormFile,
  SEED_DIGEST,
  SEED_FIELDS,
  STARTER_FILES,
  seedFiles,
} from "../src/seed.ts"

const repo = fileURLToPath(new URL("../../../", import.meta.url))
const tracked = (dir: string) =>
  execSync(`git ls-files ${dir}`, { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n")

/** Pages the starter ships that a first build does not seed (ruling 4). */
const HELD_BACK = ["src/pages/booking.astro"]

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
      [...expected, "package.json", "src/node-shims.d.ts"].sort()
    )
  })

  it("carries the files byte for byte, with the sandbox image's package.json", () => {
    for (const [path, content] of Object.entries(STARTER_FILES)) {
      const source =
        path === "package.json"
          ? "infra/sandbox/astro/package.json"
          : path === "src/node-shims.d.ts"
            ? "infra/sandbox/astro/node-shims.d.ts"
            : `packages/starter-site/${path}`
      expect(content, path).toBe(readFileSync(`${repo}${source}`, "utf8"))
    }
  })

  it("parses the starter's fields, the required facts first", () => {
    expect(Object.keys(SEED_FIELDS).slice(0, 6)).toEqual([
      "businessName",
      "phone",
      "email",
      "industry",
      "offerings",
      "serviceAreaText",
    ])
  })

  it("maps the whole seed, so the Developer sees every page and the site config", () => {
    expect(repoMap(STARTER_FILES)).not.toContain("[Map cut")
    expect(repoMap(seedFiles([quoteForm(LIMOUSINE)]))).not.toContain("[Map cut")
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

const LIMOUSINE = [
  {
    key: "pickup",
    label: "Pick-up address",
    type: "text",
    required: true,
    hint: null,
    options: null,
  },
  {
    key: "occasion",
    label: "Occasion",
    type: "select",
    required: false,
    hint: null,
    options: ["Wedding", "Airport transfer"],
  },
]

const quoteForm = (fields: unknown): FactRecord => ({
  fact_id: "10000001-0000-4000-8000-000000000001",
  org_id: "10000001-0000-4000-8000-000000000000",
  key: "quote.form",
  fact_type: "quote",
  value: { fields },
  version: 1,
  provenance: {
    source: "owner_stated",
    confidence: 1,
    verified_by_staff_id: null,
    verified_at: null,
  },
  valid_from: "2026-10-01T12:00:00.000Z",
  valid_to: null,
  superseded_by_fact_id: null,
})

describe("the quote form a site asks", () => {
  it("is the owner's approved list, in the file the starter reads", () => {
    const file = quoteFormFile([quoteForm(LIMOUSINE)])
    expect(JSON.parse(file)).toEqual({ fields: LIMOUSINE })
    expect(seedFiles([quoteForm(LIMOUSINE)])[QUOTE_FORM_FILE]).toBe(file)
  })

  it("is the same bytes for the same fact, so a revise keeps it as it was", () => {
    expect(quoteFormFile([quoteForm(LIMOUSINE)])).toBe(
      quoteFormFile([quoteForm(structuredClone(LIMOUSINE))])
    )
  })

  it("is the starter's own set with no fact, or one the contract refuses", () => {
    const starter = STARTER_FILES[QUOTE_FORM_FILE]
    expect(starter).toBeDefined()
    expect(quoteFormFile([])).toBe(starter)
    expect(quoteFormFile([quoteForm([LIMOUSINE[0]])])).toBe(starter)
    expect(seedFiles([])).toEqual(STARTER_FILES)
  })
})

describe("the quote form with no approved list", () => {
  it("is the industry pack's own questions", () => {
    const industry: FactRecord = {
      ...quoteForm([]),
      key: "business.industry",
      fact_type: "business",
      value: { name: "Bright Clean", category: "cleaning" },
    }
    const file = JSON.parse(quoteFormFile([industry]))
    expect(file.fields.map((f: { label: string }) => f.label)).toContain(
      "Type of clean"
    )
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
