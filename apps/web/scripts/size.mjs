/**
 * Measures the worker Cloudflare would receive, and fails the build on two
 * conditions.
 *
 * `wrangler deploy --dry-run` does the real bundling, then we gzip its output
 * the way wrangler does: every uploaded module concatenated, zlib defaults. That
 * reproduces the `Total Upload: ... / gzip: ...` line wrangler prints, so this
 * gate and a deploy report the same number.
 *
 * `limit` is the settled 1 MiB budget, an early-warning line far under the
 * platform's 10 MiB. `baseline` is what `main` measures. A PR that pushes past
 * it by more than `drift` raises it in the same diff, which turns "no regression
 * against main" into a number a reviewer can see change.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const web = fileURLToPath(new URL("..", import.meta.url))
const budget = JSON.parse(readFileSync(join(web, "size-budget.json"), "utf8"))
const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`

/** Bundles the built app into a throwaway directory and gzips what it holds. */
function measure() {
  const outdir = mkdtempSync(join(tmpdir(), "reme-size-"))
  try {
    execFileSync(
      "wrangler",
      [
        "deploy",
        "--dry-run",
        "--config",
        "dist/server/wrangler.json",
        "--outdir",
        outdir,
      ],
      { cwd: web, stdio: ["ignore", "ignore", "inherit"] }
    )
    const modules = readdirSync(outdir, {
      recursive: true,
      withFileTypes: true,
    })
      // wrangler drops a README.md in the outdir explaining the bundle. It is
      // not uploaded: excluding it makes the raw total match wrangler's own.
      .filter((entry) => entry.isFile() && entry.name !== "README.md")
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
    const bytes = modules.map((path) => readFileSync(path))
    return {
      raw: bytes.reduce((total, buffer) => total + buffer.length, 0),
      gzip: gzipSync(Buffer.concat(bytes)).length,
    }
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
}

let size
try {
  size = measure()
} catch {
  console.error(
    "size: wrangler could not bundle the worker. Build it first: pnpm build --filter web"
  )
  process.exit(1)
}

const ceiling = Math.round(budget.baseline * (1 + budget.drift))
const delta = size.gzip - budget.baseline
const sign = delta < 0 ? "" : "+"
console.log(`worker  ${kib(size.gzip)} gzip  (${kib(size.raw)} raw)`)
console.log(`budget  ${kib(budget.limit)}`)
console.log(
  `baseline ${kib(budget.baseline)}  ${sign}${kib(delta)}  ` +
    `${sign}${((delta / budget.baseline) * 100).toFixed(1)}%  (allowed ${kib(ceiling)})`
)

if (size.gzip > budget.limit) {
  console.error(
    `\nsize: over the ${kib(budget.limit)} budget by ${kib(size.gzip - budget.limit)}. Raising it is an ADR.`
  )
  process.exit(1)
}
if (size.gzip > ceiling) {
  console.error(
    `\nsize: ${kib(delta)} over the baseline, more than the ${(budget.drift * 100).toFixed(0)}% drift allowance.\n` +
      `Find what was added. If it belongs there, set "baseline": ${size.gzip} in apps/web/size-budget.json\n` +
      "in this PR and say in the body what the bytes bought."
  )
  process.exit(1)
}
