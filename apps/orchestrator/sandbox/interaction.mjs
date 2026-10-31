// Every built page used in a browser, run in the sandbox beside axe
// (apps/orchestrator/src/tail.ts `runInteraction`):
// `node /tmp/interaction.mjs dist /tmp/interaction.json`.
//
// Each page at 390, 768 and 1440 px loads with no console error and no
// uncaught exception; every link in a header, nav or footer opens a page the
// build has, and the element its #fragment names; at 390 px each page's
// header menu opens and shows its links, and its form, filled in, submits to
// a test sink. Pages are served from `dist/` through Playwright's routing, so
// nothing listens on a port and no request leaves the sandbox. Exit 0 clean,
// 1 findings, 2 it could not run. The result is `{ pages, findings: [{
// check, path, width, detail }] }`, and packages/gates/src/interaction.ts
// reads it back. The same findings are printed, so the Developer can run
// this script itself and see what the gate sees.
import {
  appendFileSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { join, normalize } from "node:path"

const [dist = "dist", out = "/tmp/interaction.json"] = process.argv.slice(2)
const started = Date.now()
// Where a run killed by its time limit got to: the runner reads the last line.
const stage = (what) =>
  appendFileSync(`${out}.log`, `${Date.now() - started} ms ${what}\n`)
const WIDTHS = [390, 768, 1440]
const PHONE = 390
const HEIGHT = 900
const ORIGIN = "http://site.test"
const SINK = "/__reme_sink"
const PAGES_MAX = 30
const FINDINGS_MAX = 50
const WAIT_MS = 5000
const NAV = "header a[href], nav a[href], footer a[href]"
const SAMPLE = {
  email: "test@example.com",
  tel: "0400 000 000",
  number: "1",
  date: "2030-01-15",
  "datetime-local": "2030-01-15T10:00",
  time: "10:00",
  url: "https://example.com",
}

/** The file a path is served from: the file itself, its folder's index.html, or `<path>.html`. */
const fileOf = (pathname) => {
  const path = normalize(decodeURIComponent(pathname))
  if (path.includes("..")) return null
  const base = join(dist, path)
  return (
    [base, join(base, "index.html"), `${base}.html`].find(
      (f) => existsSync(f) && statSync(f).isFile()
    ) ?? null
  )
}

const pages = () =>
  readdirSync(dist, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith("index.html"))
    .map((f) => `/${f.replace(/index\.html$/, "")}`)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
    .slice(0, PAGES_MAX)

const findings = []
const find = (check, path, width, detail) => {
  if (findings.length < FINDINGS_MAX)
    findings.push({ check, path, width, detail: String(detail).slice(0, 300) })
}

const serve = (route) => {
  const url = new URL(route.request().url())
  if (url.origin !== ORIGIN) return route.abort()
  if (url.pathname === SINK)
    return route.fulfill({ status: 200, contentType: "text/html", body: "" })
  const file = fileOf(url.pathname)
  return file ? route.fulfill({ path: file }) : route.fulfill({ status: 404 })
}

// Runs in the page: whether the header's menu links show, and if not, whether it has any.
const menuState = () => {
  const shown = (el) => {
    const box = el.getBoundingClientRect()
    return (
      box.width > 0 &&
      box.height > 0 &&
      getComputedStyle(el).visibility !== "hidden"
    )
  }
  const links = [...document.querySelectorAll("header nav a[href]")]
  if (links.length === 0) return "none"
  return links.some(shown) ? "shown" : "hidden"
}

// Runs in the page: the first form filled in with sample answers and pointed
// at the sink, and the name of the first field still invalid, "" when none,
// null when the page has no form.
const fillForm = ([sink, sample]) => {
  const form = document.querySelector("form")
  if (!form) return null
  for (const el of form.elements) {
    if (el instanceof HTMLInputElement) {
      if (el.type === "radio" || el.type === "checkbox") {
        const group = form.querySelectorAll(
          `input[name="${CSS.escape(el.name)}"]`
        )
        if (el.required && ![...group].some((g) => g.checked)) el.checked = true
      } else if (
        !["hidden", "submit", "button", "reset", "file"].includes(el.type)
      ) {
        el.value = sample[el.type] ?? "Test"
      }
    } else if (el instanceof HTMLTextAreaElement) {
      el.value = "A test request"
    } else if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find((o) => o.value && !o.disabled)
      if (option) el.value = option.value
    }
  }
  form.action = sink
  form.method = "post"
  const invalid = form.querySelector(":invalid")
  return invalid
    ? invalid.name || invalid.id || invalid.tagName.toLowerCase()
    : ""
}

async function useMenu(page, path) {
  if ((await page.evaluate(menuState)) !== "hidden") return
  const toggle = page
    .locator(
      "header summary, header button[aria-expanded], header button[aria-controls]"
    )
    .first()
  if (!(await toggle.isVisible())) {
    find(
      "menu",
      path,
      PHONE,
      "the header's links are hidden and no visible button opens them"
    )
    return
  }
  await toggle.click({ timeout: WAIT_MS })
  if ((await page.evaluate(menuState)) !== "shown")
    find(
      "menu",
      path,
      PHONE,
      "the menu button was pressed and the header's links still do not show"
    )
}

async function useForm(page, path) {
  const invalid = await page.evaluate(fillForm, [ORIGIN + SINK, SAMPLE])
  if (invalid === null) return
  for (const input of await page
    .locator("form input[type=file][required]")
    .all())
    await input.setInputFiles({
      name: "test.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
    })
  if (invalid) {
    find(
      "form",
      path,
      PHONE,
      `the form cannot be sent: the field ${invalid} stays invalid with a sample answer`
    )
    return
  }
  const submit = page
    .locator("form")
    .first()
    .locator("button[type=submit], input[type=submit], button:not([type])")
    .first()
  if (!(await submit.isVisible())) {
    find("form", path, PHONE, "the form has no visible submit button")
    return
  }
  try {
    await Promise.all([
      page.waitForRequest(
        (r) => r.url() === ORIGIN + SINK && r.method() === "POST",
        { timeout: WAIT_MS }
      ),
      submit.click({ timeout: WAIT_MS }),
    ])
    // Closing the page while the sink still loads hung Chromium in 4 of 15 sandbox runs.
    await page.waitForLoadState("load", { timeout: WAIT_MS })
  } catch {
    find("form", path, PHONE, "pressing the submit button sent nothing")
  }
}

let code = 2
let browser
try {
  const chosen = pages()
  if (chosen.length === 0) throw new Error(`no pages under ${dist}`)
  // The image installs Playwright globally, which an ES import does not search.
  const { chromium } = createRequire("/usr/local/lib/node_modules/")(
    "playwright"
  )
  stage("launch")
  browser = await chromium.launch()
  const links = new Map()
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: HEIGHT },
      reducedMotion: "reduce",
    })
    await context.route("**/*", serve)
    for (const path of chosen) {
      stage(`${path} at ${width} px`)
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => {
        const at = message.location().url
        if (message.type() === "error" && (!at || at.startsWith(ORIGIN)))
          errors.push(message.text())
      })
      const response = await page.goto(ORIGIN + path, { waitUntil: "load" })
      if (!response?.ok())
        find(
          "page",
          path,
          width,
          `the page answered ${response?.status() ?? "nothing"}`
        )
      if (width === WIDTHS.at(-1)) {
        for (const href of await page
          .locator(NAV)
          .evaluateAll((as) => as.map((a) => a.href)))
          if (href.startsWith(ORIGIN) && !links.has(href)) links.set(href, path)
      }
      if (width === PHONE) await useMenu(page, path)
      // Before the form, which leaves the page for the sink.
      for (const error of new Set(errors)) find("console", path, width, error)
      if (width === PHONE) {
        stage(`${path} form`)
        await useForm(page, path)
      }
      await page.close()
    }
    await context.close()
  }
  const context = await browser.newContext({
    viewport: { width: WIDTHS.at(-1), height: HEIGHT },
  })
  await context.route("**/*", serve)
  const page = await context.newPage()
  for (const [href, from] of links) {
    const { pathname, hash } = new URL(href)
    if (!fileOf(pathname)) {
      find(
        "link",
        from,
        null,
        `${pathname} is linked from the menu or footer and the build has no such page`
      )
      continue
    }
    if (!hash) continue
    stage(`link ${href}`)
    await page.goto(href, { waitUntil: "load" })
    const id = decodeURIComponent(hash.slice(1))
    if (
      !(await page.evaluate(
        (target) => Boolean(document.getElementById(target)),
        id
      ))
    )
      find(
        "link",
        from,
        null,
        `${pathname}${hash} is linked and ${pathname} has no element with id ${id}`
      )
  }
  await context.close()
  writeFileSync(out, JSON.stringify({ pages: chosen.length, findings }))
  for (const f of findings)
    console.log(
      `${f.path}${f.width ? ` at ${f.width} px` : ""} ${f.check}: ${f.detail}`
    )
  code = findings.length > 0 ? 1 : 0
} catch (error) {
  console.error(`interaction: ${error.message}`)
} finally {
  stage("close")
  await browser?.close()
}
process.exit(code)
