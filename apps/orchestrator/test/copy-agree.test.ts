import { copyFindings as gate } from "@workspace/gates"
import { copyFindings as sandbox } from "@workspace/starter-site/copy-check"
import { expect, test } from "vitest"

const page = (body: string) =>
  `<html><head><title>t</title></head><body><main><h1>Page</h1>${body}</main></body></html>`

/** Pages with and without each block the copy gate holds a page to. */
const PAGES = [
  { file: "services/weekly/index.html", html: page("<p>Intro</p>") },
  {
    file: "services/deep/index.html",
    html: page(
      '<ul data-copy="service_includes"><li>Ovens</li></ul><p data-copy="service_for">Movers</p>'
    ),
  },
  {
    file: "services/end/index.html",
    html: page('<p data-copy="service_for">Movers</p>'),
  },
  {
    file: "about/index.html",
    html: page('<p data-copy="approach_body">A</p>'),
  },
  { file: "contact/index.html", html: page("<p>Write to us</p>") },
  {
    file: "services/index.html",
    html: page(
      '<p data-copy="service_body">A</p><p data-copy="service_body">B</p>'
    ),
  },
]

// Perf run 2: the lead's in-sandbox check said clean and the gate then failed
// eight service pages, one repair round. The two must name the same pages.
test("the sandbox copy check and the copy gate miss the same blocks", () => {
  const byGate = gate(PAGES)
    .filter((f) => f.problem === "missing")
    .map((f) => `${f.file} ${f.detail.match(/no (\w+)/)?.[1]}`)
  const bySandbox = sandbox(PAGES)
    .filter((line) => line.includes(" block;"))
    .map((line) => `${line.split(":")[0]} ${line.match(/no (\w+)/)?.[1]}`)
  expect(bySandbox).toEqual(byGate)
  expect(byGate).toHaveLength(6)
})
