/**
 * The bytes a visitor downloads for the home page: `dist/index.html` plus every
 * same-origin stylesheet, script, image and font it references, each gzipped
 * at zlib defaults the way a static host compresses them in transit.
 *
 * Same budget shape as the Workers' size gates: `limit` is a ceiling, and
 * `baseline` ratchets with a 2% drift in both directions, because a page that
 * collapses in size is a build that emitted less than it should have.
 *
 * Reads `dist/`, so it runs after `astro build`; turbo's `size` task depends on
 * `build` for that.
 */
import { existsSync, readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"

const dist = new URL("../dist/", import.meta.url)
const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`
const fail = (message) => {
  console.error(`size: ${message}`)
  process.exit(1)
}

let budget
try {
  budget = JSON.parse(
    readFileSync(new URL("../size-budget.json", import.meta.url), "utf8")
  )
} catch (error) {
  fail(`size-budget.json is unreadable. ${error.message}`)
}
// A misspelt key makes every comparison NaN, and NaN passes every test below.
const missing = ["limit", "baseline", "drift"].filter(
  (key) => !Number.isFinite(budget[key]) || budget[key] <= 0
)
if (missing.length > 0) fail(`size-budget.json has no usable ${missing}.`)

if (!existsSync(new URL("index.html", dist))) {
  fail(
    "dist/index.html is missing. Run: pnpm --filter @workspace/starter-site build"
  )
}
const html = readFileSync(new URL("index.html", dist))
const assets = [
  ...new Set(
    [...html.toString("utf8").matchAll(/(?:href|src)="\/([^"#?]+)"/g)]
      .map((match) => match[1])
      .filter((path) =>
        /\.(css|m?js|svg|png|jpe?g|webp|avif|ico|woff2?)$/.test(path)
      )
      // The favicon set (src/favicon.ts) is fetched once per site, and the
      // apple-touch-icon only when a phone saves the page; neither is the page.
      .filter((path) => !/^(favicon[-.]|apple-touch-icon\.|icon-\d)/.test(path))
  ),
]

const files = [{ path: "index.html", bytes: html }]
for (const path of assets) {
  const url = new URL(path, dist)
  if (!existsSync(url))
    fail(`index.html references /${path}, which dist/ lacks.`)
  files.push({ path, bytes: readFileSync(url) })
}

let total = 0
for (const file of files) {
  const gzip = gzipSync(file.bytes).length
  total += gzip
  console.log(`  ${kib(gzip).padStart(10)}  ${file.path}`)
}

const delta = total - budget.baseline
const sign = delta < 0 ? "" : "+"
console.log(
  `home    ${kib(total)} gzip, ${total} bytes, ${files.length} file(s)`
)
console.log(`budget  ${kib(budget.limit)}`)
console.log(
  `baseline ${budget.baseline} bytes  ${sign}${delta}  ` +
    `${sign}${((delta / budget.baseline) * 100).toFixed(1)}%`
)

if (total > budget.limit) {
  fail(`over the ${kib(budget.limit)} budget by ${kib(total - budget.limit)}.`)
}
if (Math.abs(delta) > budget.baseline * budget.drift) {
  fail(
    `${delta > 0 ? "over" : "under"} the baseline by more than ${budget.drift * 100}%. ` +
      "If the change is intended, set baseline to the new figure in the same diff."
  )
}
