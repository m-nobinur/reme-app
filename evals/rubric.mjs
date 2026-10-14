import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { batchClient } from "../apps/api/src/cos/batch.ts"
import {
  cssLinks,
  MODEL,
  report,
  requestsFor,
  scoreBatch,
} from "./rubric/score.mjs"

/**
 * EV2's design-rubric sweep. Scores a set of revisions against the twelve
 * rules and ten slop tells in `packages/gates/src/rubric.ts`, in one batch on
 * OpenRouter's Batch API (half price, up to 24 hours, so it is a sweep, not a
 * gate), and prints pass or fail per rule and the tells per revision:
 *
 *   OPENROUTER_API_KEY=... node --experimental-transform-types evals/rubric.mjs
 *        --revisions manifest.json [--r2 BUCKET] [--cache DIR] [--model ID]
 *        [--submit-only 1] [--batch-id ID] [--wait-minutes 120] [--json out.json]
 *
 * The manifest is `{ "clean-01": "<org>/<revision>", ... }`, the one EV1's
 * variety report reads. With `--r2` each is fetched from
 * `sites/<org>/<revision>/dist/` through wrangler (`--remote`, colour off);
 * without it each value is a directory holding the build's `index.html`, the
 * stylesheets it links at their site paths and, optionally, `blueprint.json`.
 * A batch can take hours: `--submit-only` prints the batch id and stops, and
 * `--batch-id` reads that batch later without submitting again (results are
 * kept 30 days). A build that got no usable verdict is reported as not
 * scored, never as a pass; the exit code is 1 when any build failed a check
 * or was not scored. Costs a model call per build, so it is never in CI.
 */

function parse(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      throw new Error(
        `bad argument ${argv[i]}; see the header of evals/rubric.mjs`
      )
    }
    opts[argv[i].slice(2)] = argv[i + 1]
  }
  if (!opts.revisions)
    throw new Error("--revisions <manifest.json> is required")
  return opts
}

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

/** Download a revision's home page and the stylesheets it links; returns the directory. */
function fetchRevision(bucket, ref, cache) {
  const dir = join(cache, ref)
  const prefix = `sites/${ref}/dist/`
  r2Get(bucket, `${prefix}index.html`, join(dir, "index.html"))
  for (const href of cssLinks(readFileSync(join(dir, "index.html"), "utf8"))) {
    if (href.startsWith("/") && !href.startsWith("//"))
      r2Get(bucket, `${prefix}${href.slice(1)}`, join(dir, href))
  }
  return dir
}

function load(id, dir) {
  const html = readFileSync(join(dir, "index.html"), "utf8")
  const css = cssLinks(html)
    .map((href) => join(dir, href))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
  const bp = join(dir, "blueprint.json")
  return {
    id,
    html,
    css,
    blueprint: existsSync(bp)
      ? JSON.parse(readFileSync(bp, "utf8"))
      : undefined,
  }
}

async function main() {
  const opts = parse(process.argv.slice(2))
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required")
  const manifest = JSON.parse(readFileSync(opts.revisions, "utf8"))
  const ids = Object.keys(manifest)
  const client = batchClient({ apiKey })
  let id = opts["batch-id"]
  if (!id) {
    const cache = opts.cache ?? join(tmpdir(), "reme-rubric")
    const builds = ids.map((key) =>
      load(
        key,
        opts.r2 ? fetchRevision(opts.r2, manifest[key], cache) : manifest[key]
      )
    )
    const batch = await client.submit({
      model: opts.model ?? MODEL,
      requests: requestsFor(builds, { model: opts.model ?? MODEL }),
    })
    id = batch.id
    console.error(`submitted batch ${id} for ${builds.length} builds`)
  }
  if (opts["submit-only"]) {
    console.log(id)
    return
  }
  const minutes = Number(opts["wait-minutes"] ?? 120)
  const batch = await client.wait(id, { timeoutMs: minutes * 60_000 })
  if (batch.status !== "completed") {
    console.error(
      `batch ${id} is ${batch.status}${batch.error ? `: ${JSON.stringify(batch.error)}` : ""}; read it later with --batch-id ${id}`
    )
    process.exitCode = 2
    return
  }
  const scored = scoreBatch(batch, ids)
  console.log(report(scored))
  if (opts.json)
    writeFileSync(opts.json, `${JSON.stringify(scored, null, 2)}\n`)
  if (scored.some((s) => s.error || !s.passed)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 2
})
