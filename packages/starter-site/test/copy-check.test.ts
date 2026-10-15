import { expect, test } from "vitest"
import { copyFindings } from "../src/copy-check"

const EM_DASH = String.fromCharCode(0x2014)

const TITLE = "Weekly house cleaning in Fairhaven | BrightClean"
const DESCRIPTION =
  "One cleaner keeps your home on the same day each week, across Fairhaven and the villages around it. Tell us about your home to get a quote today."
const page = (body: string, title = TITLE, description = DESCRIPTION) =>
  `<html><head><title>${title}</title><meta name="description" content="${description}"></head><body>${body}</body></html>`

test("passes a page with one h1, a full title and description and plain copy", () => {
  expect(
    copyFindings([{ file: "index.html", html: page("<h1>Cleaning</h1>") }])
  ).toEqual([])
})

test("names each problem with the page it is on", () => {
  const found = copyFindings([
    {
      file: "index.html",
      html: page(
        `<h1>A</h1><h1>B</h1><p>A seamless clean ${EM_DASH} look no further.</p>`,
        "Home"
      ),
    },
    { file: "services/index.html", html: page("<h1>Services</h1>") },
  ])
  expect(found).toEqual([
    "index.html: has 2 h1 elements; a page has exactly one",
    "index.html: title is 4 characters; write 50 to 60",
    "index.html: has an em dash; use a comma, a colon or two sentences",
    'index.html: says "seamless"; say what the business does instead',
    'index.html: says "look no further"; say what the business does instead',
    "services/index.html: shares its description with index.html",
  ])
})

test("leaves a noindex page's head alone", () => {
  const html =
    '<html><head><title>Not found</title><meta name="robots" content="noindex"></head><body><h1>Not found</h1></body></html>'
  expect(copyFindings([{ file: "404.html", html }])).toEqual([])
})
