/**
 * The same gate `apps/api` runs, against this Worker. The one difference is
 * that flue and the Cloudflare plugin build this Worker with Vite first, so
 * the dry run reads the built config under `dist/`, the way `apps/web` does,
 * rather than bundling `src/` itself.
 *
 * `limit` is the 3 MiB early-warning line from ADR-027. `baseline` is what
 * this branch measures, and drift is checked in both directions.
 *
 * The comparison is a copy of the one in `apps/api/scripts/size.mjs` rather
 * than an import: an app importing another app's file is the boundary this
 * repo lints against.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const app = fileURLToPath(new URL("..", import.meta.url))
const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`

function measure() {
  const outdir = mkdtempSync(join(tmpdir(), "reme-orchestrator-size-"))
  try {
    const stdout = execFileSync(
      "wrangler",
      [
        "deploy",
        "--dry-run",
        "--config",
        "dist/reme_orchestrator/wrangler.json",
        "--outdir",
        outdir,
      ],
      { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    )
    const modules = readdirSync(outdir, {
      recursive: true,
      withFileTypes: true,
    })
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
    `size: apps/orchestrator/size-budget.json is unreadable. ${error.message}`
  )
  process.exit(1)
}

const missing = ["limit", "baseline", "drift"].filter(
  (key) => !Number.isFinite(budget[key]) || budget[key] <= 0
)
if (missing.length > 0) {
  console.error(
    `size: apps/orchestrator/size-budget.json has no usable ${missing.join(", ")}. ` +
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

if (size.printed != null && Math.abs(size.gzip / 1024 - size.printed) > 0.02) {
  console.error(
    `size: measured ${(size.gzip / 1024).toFixed(2)} KiB but wrangler reported ${size.printed.toFixed(2)} KiB. ` +
      "The module set or its concatenation order no longer matches wrangler's, so this number is not what Cloudflare receives."
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
if (Math.abs(delta) > budget.baseline * budget.drift) {
  console.error(
    `\nsize: ${delta > 0 ? "over" : "under"} the baseline by more than ${budget.drift * 100}%. ` +
      "If the change is intended, set baseline to the new figure in the same diff."
  )
  process.exit(1)
}
