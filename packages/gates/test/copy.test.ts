import { describe, expect, it } from "vitest"
import { checkCopy, copyFindings } from "../src/index.ts"

const words = (n: number, w = "word") =>
  Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ")

/** A meta description of 150 characters: inside the brief's 140 to 160. */
const DESCRIPTION =
  `${"Garden landscaping for Bristol homes, planned with you and finished on time. ".repeat(2).trim()} Ask us.`.slice(
    0,
    150
  )

const page = (file: string, title: string, main: string, head = "") => ({
  file,
  html: `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${DESCRIPTION}">${head}</head><body><main id="main">${main}</main><footer><h2>Pages</h2><h2>Get in touch</h2></footer></body></html>`,
})

/** The two blocks a service page must carry. */
const BLOCKS = `<ul data-copy="service_includes"><li>Beds weeded</li></ul><p data-copy="service_for">Suits busy households.</p>`

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
     <article><h2>Planting</h2><p data-copy="service_detail">${words(80)}</p>${BLOCKS}</article>
     <section><h2>How a planting job runs</h2><ol><li><h3>Visit</h3><p data-copy="step_body">${words(25, "p")}</p></li></ol></section>
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

  it("fails a step whose words another page's step already uses", () => {
    const step = (body: string) =>
      `<ol><li><h3>Visit</h3><p data-copy="step_body">${body}</p></li></ol>`
    const shared =
      "We visit the garden, walk it with you and agree what the work covers before anything starts on site."
    const found = copyFindings([
      page(
        "index.html",
        "Greenleaf garden landscaping in Bristol",
        `<h1>Gardens made for Bristol</h1>${step(shared)}`
      ),
      // The same words in another order are the same step.
      page(
        "services/lawns/index.html",
        "Lawn care in Bristol from Greenleaf gardeners",
        `<h1>Lawn care across Bristol</h1>${step("Before anything starts on site, we walk the garden with you, visit it and agree what the work covers.")}`
      ),
      page(
        "services/planting/index.html",
        "Planting borders and beds in Bristol | Greenleaf",
        `<h1>Borders and beds planted in Bristol</h1>${step("We choose plants for your soil and light, then set the beds out with you before a single hole is dug.")}`
      ),
    ])
    // These bare service pages also lack their blocks; only the steps matter here.
    const steps = found.filter((f) => f.problem === "duplicate")
    expect(steps.map((f) => [f.file, f.problem])).toEqual([
      ["services/lawns/index.html", "duplicate"],
    ])
    expect(steps[0]?.detail).toContain("serviceNStep1Title")
  })

  it("holds a service page's headings to the rest of the site's", () => {
    const service = (file: string, faq: string) =>
      page(
        file,
        `${file} garden work | Greenleaf`,
        `<h1>${file} in Bristol</h1><section><h2>${faq}</h2></section>${BLOCKS}`
      )
    // Two service pages left on the site's own FAQ heading repeat it.
    expect(
      copyFindings([
        GOOD[0] as (typeof GOOD)[number],
        service("services/lawns/index.html", "Before we start on your garden"),
      ]).map((f) => [f.file, f.problem])
    ).toEqual([["services/lawns/index.html", "duplicate"]])
  })

  // What the 2026-10-15 reference build wrote, shape for shape.
  describe("the reference build's misses", () => {
    const kinds = (found: { problem: string }[]) => [
      ...new Set(found.map((f) => f.problem)),
    ]
    const leaked = [
      "Our facts don't say how Brightside handles pets, so please mention any pets in your quote request.",
      "Brightside doesn't say here whether cleaners bring their own supplies.",
      "Brightside's own process for this isn't set out in our facts yet.",
      "How often it runs, and what each visit costs, isn't set out here.",
    ]

    it.each(leaked)("fails the writer's gap note: %s", (note) => {
      const found = copyFindings([
        page(
          "index.html",
          "Greenleaf garden landscaping in Bristol",
          `<h1>Gardens made for Bristol</h1><p data-copy="faq_answer">${words(40)} ${note}</p>`
        ),
      ])
      expect(kinds(found)).toEqual(["leak"])
    })

    it("fails a gap note that only the FAQ JSON-LD and the meta description carry", () => {
      const ld = `<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"acceptedAnswer":{"text":"${leaked[0]}"}}]}</script>`
      const meta = (text: string) =>
        `<meta name="description" content="${text}">`
      expect(
        kinds(
          copyFindings([
            page(
              "index.html",
              "Greenleaf garden landscaping",
              "<h1>Gardens</h1>",
              ld
            ),
          ])
        )
      ).toEqual(["leak"])
      expect(
        copyFindings([
          page(
            "index.html",
            "Greenleaf garden landscaping",
            "<h1>Gardens</h1>",
            meta(`${DESCRIPTION.slice(0, 100)} We don't know the rest.`)
          ),
        ]).map((f) => f.problem)
      ).toContain("leak")
    })

    it.each([
      "No information is passed to anyone else.",
      "Our notes on your home are kept for the next visit.",
      "As an AI language model I cannot say.",
      "The owner hasn't said how this works.",
      "Not stated anywhere on the quote.",
    ])("fails the other gap phrases: %s", (text) => {
      expect(
        kinds(
          copyFindings([
            page(
              "index.html",
              "Greenleaf garden landscaping",
              `<h1>Gardens</h1><p>${text}</p>`
            ),
          ])
        )
      ).toEqual(["leak"])
    })

    it("lets ordinary words through that a blunt filter would catch", () => {
      expect(
        copyFindings([
          page(
            "index.html",
            "Greenleaf garden landscaping",
            "<h1>Gardens</h1><p>Tell the owner of the property we are coming. If the shed isn't in use we clear it too.</p>"
          ),
        ])
      ).toEqual([])
    })

    it("fails a town the service-area fact does not name, and a near-miss spelling of one", () => {
      const areas = "Clifton, Redland, Bedminster, Henleaze and Filton"
      const chips = (...towns: string[]) =>
        `<ul>${towns.map((t) => `<li><span data-copy="area_town">${t}</span></li>`).join("")}</ul>`
      const site = (main: string) => [
        page(
          "index.html",
          "Brightside cleaning in Bristol",
          `<h1>Cleaning</h1>${main}`
        ),
      ]
      // The run's typo, in the chips.
      expect(
        copyFindings(site(chips("Clifton", "Fiton")), areas).map((f) => [
          f.problem,
          f.text,
        ])
      ).toEqual([
        ["town", "Fiton"],
        ["town", "Fiton"],
      ])
      // Case does not matter; a place the fact never names does.
      expect(copyFindings(site(chips("CLIFTON", "redland")), areas)).toEqual([])
      expect(
        copyFindings(site(chips("Clifton", "Bath")), areas).map((f) => f.text)
      ).toEqual(["Bath"])
      // In prose (a meta description) too.
      expect(
        copyFindings(site("<p>Cleaners from Clifton to Fiton.</p>"), areas).map(
          (f) => f.text
        )
      ).toEqual(["Fiton"])
      expect(
        copyFindings(site("<p>Cleaners from Clifton to Filton.</p>"), areas)
      ).toEqual([])
      // Without the fact there is nothing to hold the towns to.
      expect(copyFindings(site(chips("Fiton")))).toEqual([])
    })

    it("fails a service page missing its included or who-it-suits block, naming which", () => {
      const service = (blocks: string) =>
        page(
          "services/deep-cleaning/index.html",
          "Deep cleaning in Bristol | Brightside",
          `<h1>Deep cleaning for Bristol homes</h1><p data-copy="service_detail">${words(80)}</p>${blocks}`
        )
      expect(copyFindings([service(BLOCKS)])).toEqual([])
      const none = copyFindings([service("")])
      expect(none.map((f) => f.problem)).toEqual(["missing", "missing"])
      expect(none[0]?.detail).toContain("serviceNIncludes")
      expect(none[1]?.detail).toContain("serviceNFor")
      expect(
        copyFindings([
          service('<p data-copy="service_for">Suits renters.</p>'),
        ]).map((f) => f.detail)
      ).toEqual([expect.stringContaining("serviceNIncludes")])
      // The services index and other pages are not service pages.
      expect(
        copyFindings([
          page(
            "services/index.html",
            "Brightside cleaning services",
            "<h1>Cleans</h1>"
          ),
        ])
      ).toEqual([])
    })

    it("fails an about body of 70 words against the 120 to 200 brief, and passes 130", () => {
      const about = (n: number) =>
        page(
          "about/index.html",
          "About Brightside Home Cleaning, your Bristol cleaners",
          `<h1>Home cleaners for Bristol</h1><p data-copy="about_body">${words(n / 2)}</p><p data-copy="about_body">${words(n / 2, "b")}</p>`
        )
      const found = copyFindings([about(70)])
      expect(found.map((f) => f.problem)).toEqual(["short"])
      expect(found[0]?.detail).toContain("has 70 words; write 120 to 200")
      expect(copyFindings([about(130)])).toEqual([])
    })

    it("fails a 135-character meta description and a missing one, and passes 140 and 165", () => {
      const described = (length: number) =>
        copyFindings([
          {
            file: "services/deep-cleaning/index.html",
            html: `<html><head><title>Deep cleaning in Bristol | Brightside</title><meta name="description" content="${"x".repeat(length)}"></head><body><main><h1>Deep cleaning</h1>${BLOCKS}</main></body></html>`,
          },
        ])
      expect(described(135).map((f) => [f.problem, f.detail])).toEqual([
        [
          "short",
          "the meta description is 135 characters; write one sentence of 140 to 160",
        ],
      ])
      expect(described(0)).toHaveLength(1)
      expect(described(140)).toEqual([])
      expect(described(165)).toEqual([])
      expect(described(166)).toHaveLength(1)
    })

    it("passes four service FAQ answers in range and fails thin ones", () => {
      const faqs = (n: number) =>
        page(
          "services/deep-cleaning/index.html",
          "Deep cleaning in Bristol | Brightside",
          `<h1>Deep cleaning</h1>${BLOCKS}${Array.from({ length: 4 }, () => `<p data-copy="faq_answer">${words(n)}</p>`).join("")}`
        )
      expect(copyFindings([faqs(42)])).toEqual([])
      // The run's answers were 32 to 42 words; the thin ones are a repair round.
      expect(copyFindings([faqs(33)]).map((f) => f.detail)[0]).toContain(
        "has 33 words; write 40 to 90"
      )
      expect(copyFindings([faqs(20)]).map((f) => f.problem)).toEqual([
        "short",
        "short",
        "short",
        "short",
      ])
    })

    it("carries the facts through the gate so a misspelt town fails the run", () => {
      const fact = (value: string) =>
        [{ key: "service_area.text", value }] as unknown as Parameters<
          typeof checkCopy
        >[2]
      const pages = [
        page(
          "index.html",
          "Brightside cleaning in Bristol",
          `<h1>Cleaning</h1><span data-copy="area_town">Fiton</span>`
        ),
      ]
      expect(checkCopy(pages, true, fact("Clifton and Filton"))).toMatchObject({
        passed: false,
      })
      expect(checkCopy(pages, true)).toMatchObject({ passed: true })
    })
  })

  it("passes a build that did not plan, whatever its copy", () => {
    const bad = [page("index.html", "x", "<h1>Services</h1><h2>Services</h2>")]
    expect(copyFindings(bad).length).toBeGreaterThan(0)
    expect(checkCopy(bad, false)).toMatchObject({ passed: true })
  })
})
