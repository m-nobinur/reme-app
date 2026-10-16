import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { BUSINESSES } from "./variety/businesses.mjs"
import {
  decodePng,
  dhash,
  sequenceOf,
  summarise,
  table,
  tupleKey,
  tupleOf,
} from "./variety/measures.mjs"

/**
 * EV1's variety report. Given a manifest of fixture id to revision, prints the
 * per-industry table of how alike the sites are:
 *
 *   node evals/variety.mjs --revisions manifest.json [--r2 BUCKET] [--cache DIR]
 *        [--json out.json] [--baseline before.json] [--line 0.85]
 *
 * The manifest is `{ "clean-01": "<org>/<revision>", ... }` with `--r2`, which
 * reads `sites/<org>/<revision>/source.tar.zst` and `screenshots/home-1440.png`
 * out of that bucket through wrangler (`--remote`, colour off); without it each
 * value is a local directory holding `site-config.ts` (or `src/site-config.ts`),
 * `home-1440.png` (or `screenshots/home-1440.png`) and, optionally,
 * `blueprint.json`. `--baseline` is a `--json` file from an earlier run, usually
 * the same 18 built from `main`, and sits beside the new similarity. `--line`
 * makes the exit code 1 when an industry's mean page similarity is above it.
 * It is 1 regardless when two builds in one industry share a tuple. Reads
 * only; no model calls.
 */

function parse(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      throw new Error(
        `bad argument ${argv[i]}; see the header of evals/variety.mjs`
      )
    }
    opts[argv[i].slice(2)] = argv[i + 1]
  }
  if (!opts.revisions)
    throw new Error("--revisions <manifest.json> is required")
  return opts
}

const first = (...paths) => paths.find((p) => existsSync(p))

function r2Get(bucket, key, file) {
  mkdirSync(dirname(file), { recursive: true })
  execFileSync(
    "pnpm",
    [
      "--filter",
      "orchestrator",
      "exec",
      "wrangler",
      "r2",
      "object",
      "get",
      `${bucket}/${key}`,
      "--file",
      file,
      "--remote",
    ],
    {
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "ignore", "inherit"],
    }
  )
}

/** Download one revision into the cache and return the directory `local` reads. */
function fetchRevision(bucket, ref, cache) {
  const dir = join(cache, ref)
  const prefix = `sites/${ref}/`
  r2Get(
    bucket,
    `${prefix}screenshots/home-1440.png`,
    join(dir, "home-1440.png")
  )
  r2Get(bucket, `${prefix}source.tar.zst`, join(dir, "source.tar.zst"))
  execFileSync("sh", [
    "-c",
    'zstd -dc "$1/source.tar.zst" | tar -x -C "$1" src/site-config.ts',
    "sh",
    dir,
  ])
  return dir
}

async function load(dir) {
  const config = first(
    join(dir, "site-config.ts"),
    join(dir, "src/site-config.ts")
  )
  if (!config) throw new Error(`no site-config.ts under ${dir}`)
  const { site, layout } = await import(pathToFileURL(resolve(config)).href)
  const bp = join(dir, "blueprint.json")
  const blueprint = existsSync(bp)
    ? JSON.parse(readFileSync(bp, "utf8"))
    : undefined
  const sequence = sequenceOf(layout)
  const png = first(
    join(dir, "home-1440.png"),
    join(dir, "screenshots/home-1440.png")
  )
  let hash = null
  let foldHash = null
  if (png) {
    const image = decodePng(readFileSync(png))
    hash = dhash(image)
    foldHash = dhash(image, { topPx: 900 })
  } else
    console.error(
      `no 1440 px screenshot under ${dir}: similarity left out for it`
    )
  return {
    tuple: tupleOf({ site, layout, blueprint }),
    sequence,
    hash,
    foldHash,
  }
}

async function main() {
  const opts = parse(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(opts.revisions, "utf8"))
  const cache = opts.cache ?? join(tmpdir(), "reme-variety")
  const industryOf = new Map(BUSINESSES.map((b) => [b.id, b.industry]))
  const builds = []
  for (const [id, ref] of Object.entries(manifest)) {
    if (!industryOf.has(id))
      throw new Error(`${id} is not one of the 18 fixtures`)
    const dir = opts.r2 ? fetchRevision(opts.r2, ref, cache) : ref
    builds.push({ id, industry: industryOf.get(id), ...(await load(dir)) })
  }
  for (const b of builds) console.log(`${b.id}  ${tupleKey(b.tuple)}`)
  const rows = summarise(builds)
  const baseline = opts.baseline
    ? JSON.parse(readFileSync(opts.baseline, "utf8"))
    : []
  console.log(`\n${table(rows, baseline)}`)
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(rows, null, 2)}\n`)
  const line = opts.line === undefined ? null : Number(opts.line)
  const over = rows.filter(
    (r) =>
      r.dupes > 0 ||
      (line !== null && r.pageSimilarity !== null && r.pageSimilarity > line)
  )
  if (over.length) {
    console.error(`\nover the line: ${over.map((r) => r.industry).join(", ")}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 2
})
