import { describe, expect, it } from "vitest"
import { checkAxe, checkSize, parseAxe } from "../src/index.ts"
import { RULES, scoreRubric, TELLS } from "../src/rubric.ts"

const enc = (s: string) => new TextEncoder().encode(s)
const KB = 1024
const bytes = (kb: number) => new Uint8Array(kb * KB)

/** A built home page: one stylesheet naming `fonts`, a hero picture and `others` pictures. */
function site(
  options: {
    fonts?: number[]
    families?: string[]
    hero?: number
    others?: number[]
  } = {}
) {
  const { fonts = [20, 20], families, hero = 100, others = [40, 40] } = options
  const files: Record<string, Uint8Array> = {}
  const picture = (name: string, kb: number, priority: boolean) => {
    files[`_astro/${name}-480.avif`] = bytes(1)
    files[`_astro/${name}-780.avif`] = bytes(kb)
    files[`_astro/${name}-1280.avif`] = bytes(kb)
    return `<picture><source type="image/avif" srcset="/_astro/${name}-480.avif 480w, /_astro/${name}-780.avif 780w, /_astro/${name}-1280.avif 1280w"><img src="/_astro/${name}-480.avif" ${priority ? 'fetchpriority="high"' : 'loading="lazy"'}></picture>`
  }
  const faces = fonts.map((kb, i) => {
    files[`_astro/f${i}.woff2`] = bytes(kb)
    const family = families ? `font-family:"${families[i]}";` : ""
    return `@font-face{${family}src:url(/_astro/f${i}.woff2) format("woff2")}`
  })
  files["_astro/site.css"] = enc(`${faces.join("")}body{margin:0}`)
  files["index.html"] = enc(
    `<!doctype html><html><head><link rel="stylesheet" href="/_astro/site.css"></head><body>${picture("hero", hero, true)}${others.map((kb, i) => picture(`p${i}`, kb, false)).join("")}</body></html>`
  )
  const list = Object.fromEntries(Object.keys(files).map((f) => [f, "x"]))
  return {
    files: list,
    read: async (f: string) => files[f] ?? null,
  }
}
const BUDGET = { limit: 100 * KB }

describe("the size gate", () => {
  it("passes a site inside every line and says what it measured", async () => {
    const s = site()
    const result = await checkSize(s.files, s.read, BUDGET)
    expect(result).toMatchObject({ gate: "size", passed: true })
    expect(result.message).toMatch(/2 fonts .* 3 images/)
  })

  it("fails a home page over the gzip limit", async () => {
    const s = site()
    expect(await checkSize(s.files, s.read, { limit: 100 })).toMatchObject({
      passed: false,
      offending_node: "index.html",
    })
  })

  it("fails more than four font files, or more than 120 KB of them", async () => {
    for (const fonts of [
      [10, 10, 10, 10, 10],
      [70, 70],
    ]) {
      const s = site({ fonts })
      const result = await checkSize(s.files, s.read, BUDGET)
      expect(result.passed, fonts.join()).toBe(false)
      expect(result.message).toMatch(/font files/)
    }
  })

  it("fails a third font family, and passes two families in several weights", async () => {
    const three = site({
      fonts: [10, 10, 10],
      families: ["Outfit", "Figtree", "Lora"],
    })
    const bad = await checkSize(three.files, three.read, BUDGET)
    expect(bad.passed).toBe(false)
    expect(bad.message).toMatch(/3 font families/)
    const pair = site({
      fonts: [10, 10, 10, 10],
      families: ["Outfit", "Outfit", "Figtree", "Figtree"],
    })
    expect(await checkSize(pair.files, pair.read, BUDGET)).toMatchObject({
      passed: true,
    })
  })

  it("fails a hero over 180 KB at 1280 and any other image over 90 KB at a phone's pick", async () => {
    const fat = site({ hero: 181 })
    expect(await checkSize(fat.files, fat.read, BUDGET)).toMatchObject({
      passed: false,
      offending_node: "_astro/hero-1280.avif",
    })
    const other = site({ others: [91] })
    expect(await checkSize(other.files, other.read, BUDGET)).toMatchObject({
      passed: false,
      offending_node: "_astro/p0-780.avif",
    })
  })

  it("fails a phone's images that together pass 700 KB", async () => {
    const s = site({ hero: 170, others: [90, 90, 90, 90, 90, 90] })
    const result = await checkSize(s.files, s.read, BUDGET)
    expect(result.passed).toBe(false)
    expect(result.message).toMatch(/7 images/)
  })

  it("fails closed on a budget with no limit and a build with no home page", async () => {
    const s = site()
    expect(
      (await checkSize(s.files, s.read, { limit: Number.NaN })).passed
    ).toBe(false)
    expect((await checkSize({}, async () => null, BUDGET)).passed).toBe(false)
  })
})

const check = (exit_code: number) => ({
  checks: [{ check: "axe", exit_code, output_key: "sites/x/axe.json" }],
})
const found = {
  pages: [
    { path: "/", violations: [] },
    {
      path: "/contact/",
      violations: [
        { id: "color-contrast", impact: "serious", targets: ["main>p.lede"] },
      ],
    },
  ],
}

describe("the axe gate", () => {
  it("passes a clean run and keeps the evidence key", () => {
    expect(
      checkAxe(check(0), parseAxe({ pages: [{ path: "/", violations: [] }] }))
    ).toMatchObject({
      gate: "a11y",
      passed: true,
      evidence_key: "sites/x/axe.json",
    })
  })

  it("fails a violation and names the page and the node", () => {
    expect(checkAxe(check(1), parseAxe(found))).toMatchObject({
      passed: false,
      offending_node: "/contact/ main>p.lede",
    })
  })

  it("fails closed: no axe run, a run that crashed, a result that does not parse", () => {
    expect(checkAxe({ checks: [] }, null).passed).toBe(false)
    expect(checkAxe(check(2), null).passed).toBe(false)
    expect(parseAxe({ pages: [{ path: 1 }] })).toBeNull()
    expect(parseAxe("nope")).toBeNull()
  })
})

const clean = {
  rules: RULES.map(({ id }) => ({ id, pass: true })),
  tells: TELLS.map(({ id }) => ({ id, present: false })),
}

describe("the design rubric", () => {
  it("has twelve rules and ten tells", () => {
    expect([RULES.length, TELLS.length]).toEqual([12, 10])
  })

  it("scores a clean verdict 100 and passes it", () => {
    expect(scoreRubric(clean)).toMatchObject({
      score: 100,
      passed: true,
      failures: [],
      problems: [],
    })
  })

  it("counts a failed rule and a present tell, each with its node", () => {
    const out = scoreRubric({
      rules: clean.rules.map((r) =>
        r.id === "eyebrow" ? { ...r, pass: false, node: "main>h2" } : r
      ),
      tells: clean.tells.map((t) =>
        t.id === "centred" ? { ...t, present: true, node: "body" } : t
      ),
    })
    expect(out.score).toBe(91)
    expect(out.passed).toBe(false)
    expect(out.failures.map((f) => [f.kind, f.id, f.node])).toEqual([
      ["rule", "eyebrow", "main>h2"],
      ["tell", "centred", "body"],
    ])
    expect(
      scoreRubric(
        {
          rules: clean.rules.map((r) =>
            r.id === "eyebrow" ? { ...r, pass: false, node: "h2" } : r
          ),
          tells: clean.tells,
        },
        1
      ).passed
    ).toBe(true)
  })

  it("counts what the critic skipped, invented, doubled or failed without a node against the site", () => {
    const out = scoreRubric({
      rules: [
        ...clean.rules.slice(1),
        { id: "made_up", pass: true },
        { ...clean.rules[1] },
      ],
      tells: clean.tells.map((t) =>
        t.id === "purple_gradient" ? { ...t, present: true } : t
      ),
    })
    expect(out.failures.map((f) => f.id)).toEqual(["fonts", "purple_gradient"])
    expect(out.problems.join("|")).toMatch(/unknown rule made_up/)
    expect(out.problems).toContain("rule fonts was not answered")
    expect(out.problems).toContain("tell purple_gradient failed with no node")
    expect(scoreRubric(null).score).toBe(0)
  })
})
