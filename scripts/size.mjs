/**
 * The Worker size gate for `apps/<app>`.
 *
 *   node ../../scripts/size.mjs <app> [--config <path>] [--forbid <marker>]
 *
 * `wrangler deploy --dry-run` does the real bundling, then we gzip its output
 * the way wrangler does, every uploaded module concatenated at zlib defaults, so
 * this and a deploy report the same number. Wrangler's own printed figure is
 * parsed and compared rather than trusted, because our sort order and its
 * collection order agree only by coincidence of today's chunk names.
 *
 * `limit` in the app's `size-budget.json` is the 3 MiB early-warning line from
 * ADR-027. `baseline` is what this branch measures, and drift is checked in both
 * directions: growth past 2% raises the baseline in the same diff, and a
 * collapse is a build that silently emitted less, which is the failure a size
 * gate exists to catch.
 *
 * `--config` names a built config to bundle from, for a Worker that Vite builds
 * first (the orchestrator, web); without it wrangler bundles `src/` from the app's
 * `wrangler.jsonc`. `--forbid` fails the gate when the bundle holds a string:
 * one of parse5's error codes, for a Worker that must not carry the content
 * gate the `@workspace/gates` root pulls in.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { gzipSync } from "node:zlib"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { config: { type: "string" }, forbid: { type: "string" } },
})
const name = positionals[0]
if (!name || positionals.length > 1) {
  console.error("usage: size.mjs <app> [--config <path>] [--forbid <marker>]")
  process.exit(1)
}
const app = fileURLToPath(new URL(`../apps/${name}/`, import.meta.url))
const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`

function measure() {
  const outdir = mkdtempSync(join(tmpdir(), `reme-${name}-size-`))
  try {
    const config = values.config ? ["--config", values.config] : []
    const stdout = execFileSync(
      "wrangler",
      ["deploy", "--dry-run", ...config, "--outdir", outdir],
      { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    )
    const modules = readdirSync(outdir, {
      recursive: true,
      withFileTypes: true,
    })
      // Two things in the outdir are not uploaded: the README wrangler writes
      // to explain the bundle, and the source map. Counting the map read 432.47
      // KiB against wrangler's 149.37, which is what the comparison below is
      // for. `apps/web` needs no such filter because its build emits no map.
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name !== "README.md" &&
          !entry.name.endsWith(".map")
      )
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
    const bytes = modules.map((path) => readFileSync(path))
    const printed = /gzip:\s*([\d.]+)\s*KiB/.exec(stdout)
    return {
      forbidden:
        values.forbid !== undefined &&
        bytes.some((buffer) => buffer.includes(values.forbid)),
      raw: bytes.reduce((total, buffer) => total + buffer.length, 0),
      gzip: gzipSync(Buffer.concat(bytes)).length,
      printed: printed ? Number(printed[1]) : null,
    }
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
}

let budget
try {
  budget = JSON.parse(readFileSync(join(app, "size-budget.json"), "utf8"))
} catch (error) {
  console.error(
    `size: apps/${name}/size-budget.json is unreadable. ${error.message}`
  )
  process.exit(1)
}

// A misspelt key makes every comparison NaN, and NaN passes every test below.
const missing = ["limit", "baseline", "drift"].filter(
  (key) => !Number.isFinite(budget[key]) || budget[key] <= 0
)
if (missing.length > 0) {
  console.error(
    `size: apps/${name}/size-budget.json has no usable ${missing.join(", ")}. ` +
      "A missing or misspelt key makes every comparison NaN, which passes silently."
  )
  process.exit(1)
}

let size
try {
  size = measure()
} catch (error) {
  console.error(`size: wrangler could not bundle the worker. ${error.message}`)
  process.exit(1)
}

// Binary modules (the api's logo pictures) gzip a little differently in
// wrangler's order: 0.2 KiB in 1168. A wrong module set is off by far more.
const slack = Math.max(0.02, (size.printed ?? 0) * 0.001)
if (size.printed != null && Math.abs(size.gzip / 1024 - size.printed) > slack) {
  console.error(
    `size: measured ${(size.gzip / 1024).toFixed(2)} KiB but wrangler reported ${size.printed.toFixed(2)} KiB. ` +
      "The module set or its concatenation order no longer matches wrangler's, so this number is not what Cloudflare receives."
  )
  process.exit(1)
}

if (size.forbidden) {
  console.error(
    `size: the bundle carries "${values.forbid}", which apps/${name} forbids. ` +
      "Import a parse5-free subpath of @workspace/gates, not its root."
  )
  process.exit(1)
}

const delta = size.gzip - budget.baseline
const sign = delta < 0 ? "" : "+"
console.log(`worker  ${kib(size.gzip)} gzip  (${kib(size.raw)} raw)`)
console.log(`budget  ${kib(budget.limit)}`)
console.log(
  `baseline ${kib(budget.baseline)}  ${sign}${kib(delta)}  ` +
    `${sign}${((delta / budget.baseline) * 100).toFixed(1)}%  ` +
    `(allowed ${kib(Math.round(budget.baseline * (1 + budget.drift)))})`
)

if (size.gzip > budget.limit) {
  console.error(
    `\nsize: over the ${kib(budget.limit)} budget by ${kib(size.gzip - budget.limit)}. Raising it is an ADR.`
  )
  process.exit(1)
}
// Both directions. A collapse is a build that emitted less than it should have,
// and reporting that as an improvement is how a gate lies.
if (Math.abs(delta) > budget.baseline * budget.drift) {
  console.error(
    `\nsize: ${delta > 0 ? "over" : "under"} the baseline by more than ${budget.drift * 100}%. ` +
      "If the change is intended, set baseline to the new figure in the same diff."
  )
  process.exit(1)
}
