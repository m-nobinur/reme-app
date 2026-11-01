import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { measureSite, readPage } from "./site-measures/measures.mjs"
import { BUSINESSES } from "./variety/businesses.mjs"
import { dhash } from "./variety/measures.mjs"

// shortcut: sharp is the starter's dependency, not the root's; resolved from
// there so the evals add no package. Add it at the root if evals grow.
const sharp = createRequire(
  new URL("../packages/starter-site/package.json", import.meta.url)
)("sharp")

/**
 * Design §6's site measures over built sites, offline:
 *
 *   node --experimental-transform-types evals/site-measures.mjs \
 *        --builds manifest.json [--json measures.json]
 *
 * The manifest is `{ "clean-01": "<dir>", ... }`, each dir a measured build
 * as evals/measure-build.mjs and the baseline worker save it: `dist/`, the
 * site's `source.tar.zst` (or its `src/` beside dist) and, from wave 2 on,
 * `blueprint.json` with the content plan. Prints a table and writes every
 * measure as JSON. Reads only; no model calls.
 */

function parse(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined)
      throw new Error(
        `bad argument ${argv[i]}; see the header of evals/site-measures.mjs`
      )
    opts[argv[i].slice(2)] = argv[i + 1]
  }
  if (!opts.builds) throw new Error("--builds <manifest.json> is required")
  return opts
}

/** The site's source: its archive unpacked into a scratch dir, or the `src/` already beside dist. */
function sourceOf(dir) {
  const archive = join(dir, "source.tar.zst")
  if (!existsSync(archive)) return dir
  const into = mkdtempSync(join(tmpdir(), "reme-measures-"))
  execFileSync("tar", ["--zstd", "-xf", archive, "-C", into])
  return into
}

const htmlFiles = (dist) =>
  readdirSync(dist, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".html"))
    .sort()

/** A service name as its page's path segment, as the starter's page-seed.ts `slugOf` makes it. */
const slugOf = (name) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/** Each page's sections: its documents when it has them, else the config's `layout`. */
function layoutOf(src, layout) {
  const pages = join(src, "src/content/pages")
  if (!existsSync(pages)) return layout ?? {}
  const out = {}
  for (const file of readdirSync(pages, { recursive: true })
    .map(String)
    .sort()) {
    if (!file.endsWith(".json")) continue
    const doc = JSON.parse(readFileSync(join(pages, file), "utf8"))
    if (doc.page === "service" && out.service) continue
    out[doc.page] = doc.sections
  }
  return out
}

/** Each distinct raster photo the pages show, once per source image, with its dhash. */
async function photosOf(dist, pages) {
  const byName = new Map()
  for (const { html } of pages)
    for (const src of readPage(html).images) {
      const path = join(dist, decodeURIComponent(src.split("?")[0]))
      const name = src.split("/").pop()?.split(".")[0] ?? src
      if (!byName.has(name) && existsSync(path)) byName.set(name, path)
    }
  const photos = []
  for (const [name, path] of byName) {
    const { data, info } = await sharp(path)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    photos.push({
      src: name,
      hash: dhash({ width: info.width, height: info.height, grey: data }),
    })
  }
  return photos
}

const PACK = { cleaning: "cleaning", legal: "legal", limousine: "limousine" }

async function measure(id, dir) {
  const dist = join(dir, "dist")
  const pages = htmlFiles(dist)
    .map((file) => ({ file, html: readFileSync(join(dist, file), "utf8") }))
    .filter(
      ({ html }) => !/<meta name="robots" content="[^"]*noindex/.test(html)
    )
  const src = sourceOf(dir)
  const { site, layout } = await import(
    pathToFileURL(resolve(join(src, "src/site-config.ts"))).href
  )
  const recipes = JSON.parse(
    readFileSync(join(src, "src/recipes.json"), "utf8")
  )
  const industry = BUSINESSES.find((b) => b.id === id)?.industry
  const blueprint = join(dir, "blueprint.json")
  return measureSite({
    pages,
    layout: layoutOf(src, layout),
    packOrder: recipes.packs[PACK[industry] ?? "service_business"]?.order,
    services: [1, 2, 3, 4, 5, 6]
      .map((n) => site[`service${n}Name`] ?? "")
      .filter(Boolean)
      .map((name) => ({ name, slug: slugOf(name) })),
    content: existsSync(blueprint)
      ? (JSON.parse(readFileSync(blueprint, "utf8")).content ?? null)
      : null,
    photos: await photosOf(dist, pages),
  })
}

/** The measures as one row per build. */
export function table(results) {
  const rows = Object.entries(results).map(([id, m]) => [
    id,
    m.pages,
    m.richness.wordsPerPage,
    m.richness.ownWords,
    m.richness.topicWords ?? "-",
    m.duplication.sentences,
    m.outline.problems.length,
    m.layoutDistance ?? "-",
    `${m.photos.shown} (${m.photos.nearPairs} alike)`,
    m.faqPages,
    `${m.offerings.pages}/${m.offerings.services}`,
    m.servicesTable === null ? "-" : m.servicesTable ? "yes" : "no",
  ])
  const head = [
    "build",
    "pages",
    "words/page",
    "own words",
    "topic words",
    "repeated sentences",
    "outline faults",
    "layout distance",
    "photos",
    "FAQPage pages",
    "offering pages",
    "services table",
  ]
  return [head, head.map(() => "---"), ...rows]
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n")
}

async function main() {
  const opts = parse(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(opts.builds, "utf8"))
  const results = {}
  for (const [id, dir] of Object.entries(manifest)) {
    if (!existsSync(join(dir, "dist"))) {
      console.error(`${id}: no dist under ${dir}, skipped`)
      continue
    }
    results[id] = await measure(id, dir)
  }
  console.log(table(results))
  if (opts.json)
    writeFileSync(opts.json, `${JSON.stringify(results, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 2
  })
