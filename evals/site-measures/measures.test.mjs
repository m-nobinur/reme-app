import assert from "node:assert/strict"
import { test } from "node:test"
import { crawlBlocks, repeatedSentences } from "./measures.mjs"

const page = (main, chrome = "") =>
  `<html><head><title>Same title for every page here</title></head><body><header><p>We clean homes in your town every week.</p></header><main>${main}</main><footer><p>${chrome}</p></footer></body></html>`

const CARD = "Typical for this kind of job, confirmed when we quote."

test("a sentence of six words or more on two pages counts once, with its pages", () => {
  const found = repeatedSentences([
    { file: "index.html", html: page(`<p>${CARD} ${CARD}</p>`) },
    { file: "about/index.html", html: page(`<li>${CARD}</li>`) },
    { file: "contact/index.html", html: page("<p>Call us any time.</p>") },
  ])
  assert.deepEqual(found, [
    { sentence: CARD, files: ["index.html", "about/index.html"] },
  ])
})

test("a short sentence and a sentence on one page do not count", () => {
  assert.deepEqual(
    repeatedSentences([
      {
        file: "a.html",
        html: page(
          "<p>Typical for this job. Only here today, in this one.</p>"
        ),
      },
      { file: "b.html", html: page("<p>Typical for this job.</p>") },
    ]),
    []
  )
})

test("the layout's header and footer are left out, a header inside <main> is not", () => {
  const html = page(
    "<header><h2>The room by room checklist for every home</h2></header>",
    "Registered in England and Wales, all rights reserved."
  )
  const found = repeatedSentences([
    { file: "a.html", html },
    { file: "b.html", html },
  ])
  assert.deepEqual(
    found.map((f) => f.sentence),
    ["The room by room checklist for every home"]
  )
})

test("links and spans cut a block as the crawl does", () => {
  assert.deepEqual(
    crawlBlocks(
      page("<p>Call <a href='tel:1'>020 7946 0000</a> to book today.</p>")
    ),
    ["Call", "020 7946 0000", "to book today."]
  )
})
