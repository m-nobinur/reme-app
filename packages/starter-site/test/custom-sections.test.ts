import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { lintSite, lintSource } from "../scripts/custom-sections.mjs"

const fixture = (name: string) =>
  readFileSync(
    new URL(`./custom-sections/${name}.astro.txt`, import.meta.url),
    "utf8"
  )

const GUARD = "{ site.x && (<p>{site.x}</p>) }"
const section = (markup: string, front = "") =>
  `---\nimport { site } from "../../site-config"\n${front}---\n\n${markup}\n`

/** One file that breaks one rule: its source and the rule the lint must name. */
const BAD: Record<string, [string, string]> = {
  namedColour: [
    section(`${GUARD}\n<style>p { border: 1px solid tan; }</style>`),
    "tokens",
  ],
  fontFamily: [
    section(`${GUARD}\n<style>p { font-family: Georgia, serif; }</style>`),
    "fonts",
  ],
  fontFace: [
    section(`${GUARD}\n<style>@font-face { src: url(x.woff2); }</style>`),
    "fonts",
  ],
  scriptTag: [
    section(`${GUARD}\n<script>document.title = "x"</script>`),
    "no-script",
  ],
  eventHandler: [
    section('{ site.x && (<button onclick="go()">{site.x}</button>) }'),
    "no-script",
  ],
  clientDirective: [
    section("{ site.x && (<Widget client:load />) }"),
    "no-script",
  ],
  rawHtml: [section("{ site.x && (<div set:html={site.x} />) }"), "no-script"],
  iframe: [section("{ site.x && (<iframe src={site.x} />) }"), "no-script"],
  javascriptUrl: [
    section('{ site.x && (<a href="javascript:go()">{site.x}</a>) }'),
    "no-script",
  ],
  unguarded: [section("<p>{site.x}</p>"), "empty"],
  wrongGuard: [section("{ site.x || (<p>{site.x}</p>) }"), "empty"],
  ternaryWithoutNull: [
    section("{ site.x ? <p>{site.x}</p> : <p>none</p> }"),
    "empty",
  ],
  proseText: [section("{ site.x && (<p>Call us today</p>) }"), "site-config"],
  proseInExpression: [
    section('{ site.x && (<p>{site.x ?? "Call us today"}</p>) }'),
    "site-config",
  ],
  proseAttribute: [
    section('{ site.x && (<img src={site.x} alt="Our team at work" />) }'),
    "site-config",
  ],
  literalSrc: [
    section('{ site.x && (<img src="/photo.jpg" alt={site.x} />) }'),
    "site-config",
  ],
  literalPhone: [
    section('{ site.x && (<a href="tel:5551234">{site.x}</a>) }'),
    "site-config",
  ],
  proseInFrontmatter: [
    section(GUARD, 'const heading = "Our story so far"\n'),
    "site-config",
  ],
  noSiteConfig: [`---\n---\n\n${GUARD}\n`, "site-config"],
  outsideImport: [
    section(GUARD, 'import { sortBy } from "lodash"\n'),
    "site-config",
  ],
  fetching: [section(GUARD, "const r = await fetch(site.x)\n"), "site-config"],
}

describe("a custom section", () => {
  test.each(["Callout", "Note"])("%s passes every rule", (name) => {
    expect(lintSource(fixture(name))).toEqual([])
  })

  test.each(["HexColour", "RgbColour", "ColourInVarFallback"])(
    "%s is refused as a raw colour",
    (name) => {
      expect(lintSource(fixture(name)).map((f) => f.rule)).toContain("tokens")
    }
  )

  test.each(Object.entries(BAD))("%s is refused", (_, [source, rule]) => {
    expect(lintSource(source).map((f: { rule: string }) => f.rule)).toContain(
      rule
    )
  })

  test("an empty file renders nothing and passes the markup rules", () => {
    expect(lintSource(section(""))).toEqual([])
  })
})

describe("a site's custom folder", () => {
  const ok = (file: string) => ({ file, source: fixture("Note") })

  test("none, one or two sections pass", () => {
    expect(lintSite([])).toEqual([])
    expect(lintSite([ok("Note.astro"), ok("Other.astro")])).toEqual([])
  })

  test("a third section is refused, naming it", () => {
    expect(
      lintSite([ok("Aaa.astro"), ok("Bbb.astro"), ok("Ccc.astro")])
    ).toEqual([
      expect.objectContaining({
        file: "src/components/custom/Ccc.astro",
        rule: "count",
      }),
    ])
  })

  test("a file that is not a PascalCase .astro is refused", () => {
    const rules = lintSite([ok("note.astro"), ok("Helper.ts")]).map(
      (f) => f.file
    )
    expect(rules).toEqual([
      "src/components/custom/Helper.ts",
      "src/components/custom/note.astro",
    ])
  })
})

describe("the command", () => {
  const run = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "custom-"))
    mkdirSync(join(root, "src/components/custom"), { recursive: true })
    for (const [name, source] of Object.entries(files))
      writeFileSync(join(root, "src/components/custom", name), source)
    const out = join(root, "out.json")
    const r = spawnSync(
      process.execPath,
      [
        new URL("../scripts/custom-sections.mjs", import.meta.url).pathname,
        root,
        out,
      ],
      { encoding: "utf8" }
    )
    return {
      status: r.status,
      stderr: r.stderr,
      json: JSON.parse(readFileSync(out, "utf8")),
    }
  }

  test("exits 0 with no findings for a clean site, and for a site with none", () => {
    expect(run({ "Note.astro": fixture("Note") })).toMatchObject({
      status: 0,
      json: { findings: [] },
    })
    expect(run({})).toMatchObject({ status: 0 })
  })

  test("exits 1 and names the file and the rule", () => {
    const r = run({ "Bad.astro": fixture("HexColour") })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/src\/components\/custom\/Bad\.astro: tokens:/)
    expect(r.json.findings[0]).toMatchObject({
      file: "src/components/custom/Bad.astro",
      rule: "tokens",
    })
  })
})
