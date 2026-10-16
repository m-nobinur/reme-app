import { expect, test } from "vitest"
import { copyFindings } from "../src/copy-check"

const EM_DASH = String.fromCharCode(0x2014)

const TITLE = "Weekly house cleaning in Fairhaven | BrightClean Ltd"
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

test("holds a title to 50 to 60 characters, as the writer's brief says", () => {
  const found = (length: number) =>
    copyFindings([
      { file: "index.html", html: page("<h1>A</h1>", "x".repeat(length)) },
    ])
  expect(found(62)).toEqual([
    "index.html: title is 62 characters; write 50 to 60",
  ])
  expect(found(49)).toHaveLength(1)
  expect(found(50)).toEqual([])
  expect(found(60)).toEqual([])
})

test("leaves a noindex page's head alone", () => {
  const html =
    '<html><head><title>Not found</title><meta name="robots" content="noindex"></head><body><h1>Not found</h1></body></html>'
  expect(copyFindings([{ file: "404.html", html }])).toEqual([])
})

// Perf run 2: the gate failed eight service pages on these blocks while this
// check, which the lead reads after every build, said "clean".
test("names a page missing a block the copy gate fails it without", () => {
  const service = (body: string) => ({
    file: "services/weekly-clean/index.html",
    html: page(`<h1>Weekly cleaning</h1>${body}`),
  })
  expect(copyFindings([service("<p>Intro</p>")])).toEqual([
    "services/weekly-clean/index.html: has no serviceNIncludes (what is included) block; fill it for this page",
    "services/weekly-clean/index.html: has no serviceNFor (who it suits) block; fill it for this page",
  ])
  expect(
    copyFindings([
      service(
        '<ul data-copy="service_includes"><li>Dusting</li></ul><p data-copy="service_for">Busy homes</p>'
      ),
    ])
  ).toEqual([])
  expect(
    copyFindings([
      {
        file: "services/index.html",
        html: page(
          '<h1>Services</h1><p data-copy="service_body">A</p><p data-copy="service_body">B</p>'
        ),
      },
    ])
  ).toEqual([
    "services/index.html: has no servicesHelpBody block; fill it for this page",
  ])
})
