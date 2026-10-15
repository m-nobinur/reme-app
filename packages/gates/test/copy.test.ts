import { describe, expect, it } from "vitest"
import { checkCopy, copyFindings } from "../src/index.ts"

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ")

const page = (file: string, title: string, main: string, head = "") => ({
  file,
  html: `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><main id="main">${main}</main><footer><h2>Pages</h2><h2>Get in touch</h2></footer></body></html>`,
})

const cta = (heading: string) =>
  `<section class="cta-band"><h2>${heading}</h2><p>${words(14)}</p></section>`

/** A site that meets the brief: every heading its own, every section its words. */
const GOOD = [
  page(
    "index.html",
    "Garden landscaping in Bristol and Bath | Greenleaf",
    `<section><h1>Garden landscaping in Bristol, Bath and <span class="accent">Clevedon</span></h1><p class="lede" data-copy="hero_lede">${words(40)}</p></section>
     <section><h2>Garden work for homes across Bristol</h2><ul><li><h3>Planting</h3><p data-copy="service_body">${words(32)}</p></li></ul></section>
     <section><h2>From first visit to finished garden</h2><ol><li><h3>Visit</h3><p data-copy="step_body">${words(25)}</p></li></ol></section>
     <section><h2>Before we start on your garden</h2><details><summary>Do I need to be home?</summary><p data-copy="faq_answer">${words(55)}</p></details></section>
     ${cta("Book your first garden visit")}`
  ),
  page(
    "services/index.html",
    "Garden design, planting and lawn care | Greenleaf",
    `<section><h1>Landscaping services for Bristol gardens</h1></section>
     <ul><li><h3><a href="/services/planting/">Planting</a></h3><p data-copy="service_body">${words(30)}</p></li></ul>
     ${cta("Plan the next season of your garden")}`
  ),
  page(
    "services/planting/index.html",
    "Planting borders and beds in Bristol | Greenleaf",
    `<section><h1>Borders and beds planted in Bristol</h1><p class="lede">${words(30)}</p></section>
     <article><h2>Planting</h2><p data-copy="service_detail">${words(80)}</p></article>
     <section><h2>How a planting job runs</h2><ol><li><h3>Visit</h3><p data-copy="step_body">${words(25)}</p></li></ol></section>
     <section><h2>Planting questions from Bristol gardeners</h2><details><summary>When is the best time to plant?</summary><p data-copy="faq_answer">${words(50)}</p></details></section>
     ${cta("Get your borders planted this spring")}`
  ),
  page(
    "404.html",
    "Page not found",
    "<h1>Our services</h1><h2>Our services</h2>",
    '<meta name="robots" content="noindex">'
  ),
]

describe("the copy gate", () => {
  it("passes a site whose headings are all its own and whose sections have their words", () => {
    expect(copyFindings(GOOD)).toEqual([])
    expect(checkCopy(GOOD, true)).toMatchObject({ gate: "copy", passed: true })
  })

  it("fails a heading repeated across pages, near-duplicates included, and names both", () => {
    const site = [
      GOOD[0] as (typeof GOOD)[number],
      page(
        "about/index.html",
        "About Greenleaf Garden Landscaping in Bristol",
        "<h1>About Greenleaf</h1><h2>Bristol homes: garden work</h2>"
      ),
    ]
    const result = checkCopy(site, true)
    expect(result.passed).toBe(false)
    expect(result.message).toContain(
      'about/index.html: "Bristol homes: garden work": the h2 repeats "Garden work for homes across Bristol" from index.html'
    )
    expect(result.offending_node).toBe("about/index.html html>body>main>h2")
  })

  it("fails a heading repeated on one page and a title shared by two pages", () => {
    const found = copyFindings([
      page(
        "index.html",
        "Greenleaf garden landscaping",
        "<h1>Gardens made for Bristol</h1><h2>Lawns we look after</h2><h2>Lawns we look after</h2>"
      ),
      page(
        "contact/index.html",
        "Greenleaf Garden Landscaping",
        "<h1>Talk to Greenleaf about your garden</h1>"
      ),
    ])
    expect(found.map((f) => [f.file, f.problem, f.text])).toEqual([
      ["index.html", "duplicate", "Lawns we look after"],
      ["contact/index.html", "duplicate", "Greenleaf Garden Landscaping"],
    ])
  })

  it("fails a stock label as an h1 or h2 and lets it stand as an eyebrow", () => {
    const found = copyFindings([
      page(
        "index.html",
        "Greenleaf garden landscaping in Bristol",
        `<h1>Gardens made for Bristol</h1><p class="eyebrow">Why choose us</p><h2>Why choose <span class="accent">us</span></h2><h2>Our Services</h2>`
      ),
    ])
    expect(found.map((f) => [f.problem, f.text])).toEqual([
      ["stock", "Why choose us"],
      ["stock", "Our Services"],
    ])
  })

  it("fails each section under its minimum and says the range to write", () => {
    const found = copyFindings([
      page(
        "index.html",
        "Greenleaf garden landscaping in Bristol",
        `<h1>Gardens made for Bristol</h1><p data-copy="hero_lede">${words(10)}</p><p data-copy="service_body">${words(14)}</p><p data-copy="service_body">${words(15)}</p><p data-copy="step_body">${words(5)}</p><p data-copy="faq_answer">${words(20)}</p><p data-copy="service_detail">${words(30)}</p>`
      ),
    ])
    expect(found.map((f) => f.detail)).toEqual([
      "the home hero's subhead (homeIntro) has 10 words; write 25 to 55",
      "a service card (serviceNBody) has 14 words; write 25 to 45",
      "a process step (stepNBody) has 5 words; write 20 to 35",
      "an FAQ answer (faqNAnswer, or serviceNFaqMAnswer on a service page) has 20 words; write 40 to 90",
      "a service page's intro (serviceNDetail) has 30 words; write 60 to 100",
    ])
  })

  it("compares each page's closing band like any heading, and never reads the footer", () => {
    const pages = [
      page(
        "index.html",
        "Greenleaf garden landscaping in Bristol",
        `<h1>Gardens made for Bristol</h1>${cta("Book your first garden visit")}`
      ),
      page(
        "contact/index.html",
        "Contact Greenleaf about a garden in Bath",
        `<h1>Talk to Greenleaf about your garden</h1>${cta("Book your first garden visit")}`
      ),
    ]
    const found = copyFindings(pages)
    expect(found.map((f) => [f.file, f.text])).toEqual([
      ["contact/index.html", "Book your first garden visit"],
    ])
    expect(found[0]?.detail).toContain("each page has its own closing band")
  })

  it("holds a service page's headings to the rest of the site's", () => {
    const service = (file: string, faq: string) =>
      page(
        file,
        `${file} garden work | Greenleaf`,
        `<h1>${file} in Bristol</h1><section><h2>${faq}</h2></section>`
      )
    // Two service pages left on the site's own FAQ heading repeat it.
    expect(
      copyFindings([
        GOOD[0] as (typeof GOOD)[number],
        service("services/lawns/index.html", "Before we start on your garden"),
      ]).map((f) => [f.file, f.problem])
    ).toEqual([["services/lawns/index.html", "duplicate"]])
  })

  it("passes a build that did not plan, whatever its copy", () => {
    const bad = [page("index.html", "x", "<h1>Services</h1><h2>Services</h2>")]
    expect(copyFindings(bad).length).toBeGreaterThan(0)
    expect(checkCopy(bad, false)).toMatchObject({ passed: true })
  })
})
