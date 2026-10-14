// axe-core over the built site, run in the sandbox by the build's tail
// (apps/orchestrator/src/tail.ts): `node /opt/astro/axe.mjs dist /tmp/axe.json`.
//
// A page is served from `dist/` by a throwaway static server on a free port,
// so there is no `astro preview` to start, and Chromium is the one the image
// already carries for screenshots. Three pages at one width: the home page,
// then the pages most likely to differ from it. Exit 0 clean, 1 violations,
// 2 it could not run. The result is `{ pages: [{ path, violations: [{ id,
// impact, targets }] }] }`, and packages/gates/src/axe.ts reads it back.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, normalize } from "node:path"
import AxeBuilder from "@axe-core/playwright"

const [dist = "dist", out = "/tmp/axe.json"] = process.argv.slice(2)
const WIDTH = 1440
const PAGES = 3
const PREFER = ["services", "contact", "about", "quote", "service-area"]
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
}

// Every `index.html` under dist, preferred names ahead, shortest path first.
const rank = (p) => {
  const at = PREFER.indexOf(p.split("/")[1])
  return p === "/" ? -1 : at === -1 ? PREFER.length : at
}
const pick = () =>
  readdirSync(dist, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith("index.html"))
    .map((f) => `/${f.replace(/index\.html$/, "")}`)
    .sort(
      (a, b) => rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : 1)
    )
    .slice(0, PAGES)

const server = createServer((req, res) => {
  const path = normalize(
    decodeURIComponent(new URL(req.url, "http://x").pathname)
  )
  const file = join(dist, path.endsWith("/") ? `${path}index.html` : path)
  try {
    if (path.includes("..") || !statSync(file).isFile()) throw new Error("no")
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    })
    res.end(readFileSync(file))
  } catch {
    res.writeHead(404).end()
  }
})

let code = 2
try {
  const chosen = pick()
  if (chosen.length === 0) throw new Error(`no pages under ${dist}`)
  // The image installs Playwright globally, which an ES import does not search.
  const { chromium } = createRequire("/usr/local/lib/node_modules/")(
    "playwright"
  )
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: 900 },
    })
    const pages = []
    for (const path of chosen) {
      const page = await context.newPage()
      await page.goto(base + path, { waitUntil: "load" })
      const { violations } = await new AxeBuilder({ page })
        .withTags(TAGS)
        .analyze()
      pages.push({
        path,
        violations: violations.map((v) => ({
          id: v.id,
          impact: v.impact ?? null,
          targets: v.nodes.map((n) => n.target.join(" ")).slice(0, 5),
        })),
      })
      await page.close()
    }
    writeFileSync(out, JSON.stringify({ pages }))
    code = pages.some((p) => p.violations.length > 0) ? 1 : 0
  } finally {
    await browser.close()
  }
} catch (error) {
  console.error(`axe: ${error.message}`)
} finally {
  server.close()
}
process.exit(code)
