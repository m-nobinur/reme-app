/**
 * Measures the worker Cloudflare would receive, and fails the build on two
 * conditions.
 *
 * `wrangler deploy --dry-run` does the real bundling, then we gzip its output
 * the way wrangler does: every uploaded module concatenated, zlib defaults. That
 * reproduces the `Total Upload: ... / gzip: ...` line wrangler prints, so this
 * gate and a deploy report the same number. We do not take that on trust: the
 * line is parsed and compared, because our sort order and wrangler's collection
 * order agree by coincidence of today's chunk names, and a 2904-byte spread is
 * available from reordering alone.
 *
 * `limit` is the settled 1 MiB budget, an early-warning line far under the
 * platform's 10 MiB. `baseline` is what `main` measures. Drift is checked in
 * both directions: growth past it raises it in the same diff, and a collapse is
 * a build that silently emitted less, which is the failure this gate exists to
 * catch. Only the server bundle is measured. Static assets under `public/` are
 * uploaded separately, are not in wrangler's total, and are not covered here.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { check, kib } from "./size-check.mjs"

const web = fileURLToPath(new URL("..", import.meta.url))

/** Bundles the built app into a throwaway directory and gzips what it holds. */
function measure() {
  const outdir = mkdtempSync(join(tmpdir(), "reme-size-"))
  try {
    const stdout = execFileSync(
      "wrangler",
      [
        "deploy",
        "--dry-run",
        "--config",
        "dist/server/wrangler.json",
        "--outdir",
        outdir,
      ],
      { cwd: web, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
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
    // wrangler prints two decimals, so this is a ~10-byte window. That is ample
    // against a drift allowance measured in kilobytes, and it fails the moment
    // our module set or concatenation order stops matching wrangler's.
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
  budget = JSON.parse(readFileSync(join(web, "size-budget.json"), "utf8"))
} catch (error) {
  console.error(
    `size: apps/web/size-budget.json is unreadable. ${error.message}`
  )
  process.exit(1)
}

let size
try {
  size = measure()
} catch (error) {
  console.error(
    `size: wrangler could not bundle the worker. ${error.message}\n` +
      "If the build is missing, run: pnpm build --filter web"
  )
  process.exit(1)
}

const result = check(size, budget)
console.log(`worker  ${kib(size.gzip)} gzip  (${kib(size.raw)} raw)`)
console.log(`budget  ${kib(budget.limit)}`)
console.log(result.summary)
if (result.failure) {
  console.error(`\n${result.failure}`)
  process.exit(1)
}
