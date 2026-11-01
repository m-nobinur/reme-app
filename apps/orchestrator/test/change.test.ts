import type { PageDocument } from "@workspace/contracts"
import { describe, expect, it, vi } from "vitest"
import {
  blockChanges,
  changeContext,
  checkedRoutes,
  checkPrompt,
  missingOwnerContent,
  pageText,
  parseChecks,
  redirectsFor,
  routeOf,
} from "../src/change.ts"

// retry.ts loads app.ts, which loads both at import time; neither is reached here.
vi.mock("../src/sandbox.ts", () => ({ workKey: () => "" }))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))
const { changeLines, readyText } = await import("../src/retry.ts")
const { ownerContent } = await import("../src/planner.ts")

const home: PageDocument = {
  page: "home",
  sections: [
    { id: "hero", kind: "hero", heading: "Spotless homes" },
    {
      id: "services",
      kind: "service_cards",
      heading: "What we clean",
      blocks: [
        {
          id: "services-help",
          type: "prose",
          provenance: "facts",
          markdown: "Weekly and one-off cleans.",
        },
      ],
    },
    {
      id: "faq",
      kind: "faq",
      heading: "Questions",
      blocks: [
        {
          id: "faq-list",
          type: "faq",
          provenance: "trade",
          items: [{ question: "Do you bring supplies?", answer: "Yes." }],
        },
      ],
    },
  ],
}

const brief = {
  edit_type: "move" as const,
  targets: [{ page: "home", section: "faq" }],
  placement: "before section services on home",
  acceptance: [
    "The FAQ comes before the services on the home page",
    "Nothing else on the home page changed",
  ],
  owner_words: "move the FAQ above services",
}

describe("block changes", () => {
  it("records nothing when the documents are the same", () => {
    expect(blockChanges({ home }, { home: structuredClone(home) })).toEqual([])
  })

  it("records a move, a reworded block and an added section by id", () => {
    const after = structuredClone(home)
    const [hero, services, faq] = after.sections
    if (!hero || !services || !faq) throw new Error("fixture")
    const help = services.blocks?.[0]
    if (help?.type === "prose")
      help.markdown = "Weekly, fortnightly and one-off cleans."
    after.sections = [
      hero,
      faq,
      services,
      {
        id: "story",
        kind: "content",
        heading: "Our story",
        blocks: [
          {
            id: "story-text",
            type: "prose",
            provenance: "owner",
            markdown: "We started in 2019 with one van.",
          },
        ],
      },
    ]
    const changes = blockChanges({ home }, { home: after })
    expect(changes).toEqual([
      expect.objectContaining({ section: "faq", block: null, change: "moved" }),
      expect.objectContaining({
        section: "services",
        block: null,
        change: "moved",
      }),
      expect.objectContaining({
        section: "services",
        block: "services-help",
        change: "changed",
        before: "Weekly and one-off cleans.",
        after: "Weekly, fortnightly and one-off cleans.",
      }),
      expect.objectContaining({
        section: "story",
        change: "added",
        after: "## Our story\n\nWe started in 2019 with one van.",
      }),
    ])
  })

  it("records a removed page section by section, with its words as before", () => {
    const changes = blockChanges(
      {
        home,
        about: {
          page: "about",
          sections: [{ id: "intro", kind: "content", heading: "About us" }],
        },
      },
      { home }
    )
    expect(changes).toEqual([
      {
        page: "about",
        section: "intro",
        block: null,
        change: "removed",
        before: "## About us",
        after: "",
      },
    ])
  })
})

describe("change context", () => {
  it("gives the brief, the outline and the targeted section, never the owner's raw words", () => {
    const context = changeContext(brief, { home }, [
      {
        label: "your hero title",
        edit_type: "update_content",
        blocks: [
          {
            page: "home",
            section: "hero",
            block: null,
            change: "changed",
            before: "a",
            after: "b",
          },
        ],
      },
    ])
    expect(context).toContain('"edit_type": "move"')
    expect(context).toContain('- faq (faq, "Questions"): faq-list faq/trade')
    expect(context).toContain('<section id="faq">')
    expect(context).not.toContain('<section id="services">')
    expect(context).toContain("- your hero title (update_content): home > hero")
    expect(context).not.toContain("move the FAQ above services")
  })

  it("says a targeted page has no document yet", () => {
    expect(
      changeContext(
        {
          ...brief,
          edit_type: "add_page",
          targets: [{ page: "services/oven-clean" }],
        },
        { home }
      )
    ).toContain("No document yet")
  })
})

describe("acceptance judging", () => {
  it("reads a page as a reader meets it", () => {
    const text = pageText(
      '<html><head><title>x</title><script>alert(1)</script></head><body><header><a href="tel:+44">020 7946 0000</a></header><main><h2>Questions</h2><ul><li>Do you bring supplies?</li></ul><p>Fish &amp; chips</p></main></body></html>'
    )
    expect(text).toBe(
      "[header]\n020 7946 0000\n[/header]\n## Questions\n- Do you bring supplies?\nFish & chips"
    )
  })

  it("judges on the targeted pages, home without targets", () => {
    expect(checkedRoutes(brief)).toEqual(["/"])
    expect(
      checkedRoutes({
        ...brief,
        targets: [{ page: "services/end-of-tenancy" }],
      })
    ).toEqual(["/services/end-of-tenancy/"])
    expect(routeOf("service-area")).toBe("/service-area/")
  })

  it("fails a check the reply skipped or could not be read", () => {
    const checks = ["a", "b"]
    expect(
      parseChecks('{"checks":[{"passed":true,"why":"seen"}]}', checks)
    ).toEqual([
      { check: "a", passed: true, why: "seen" },
      { check: "b", passed: false, why: "The check could not be judged." },
    ])
    expect(parseChecks("no json", checks).every((c) => !c.passed)).toBe(true)
    expect(checkPrompt(checks, [{ route: "/", text: "hi" }]).user).toContain(
      '<page route="/">'
    )
  })
})

describe("the owner's own words", () => {
  const facts = [
    {
      key: "site.content",
      value: {
        items: [
          {
            id: "story",
            page: "about",
            title: "Our story",
            markdown: "We started in 2019 with one van.\nNow we are six.",
          },
        ],
      },
      provenance: { source: "owner_stated", confidence: 1 },
    },
  ] as unknown as Parameters<typeof missingOwnerContent>[0]
  const about = (provenance: "owner" | "facts", markdown: string) => ({
    about: {
      page: "about" as const,
      sections: [
        {
          id: "story",
          kind: "content" as const,
          blocks: [
            { id: "story-text", type: "prose" as const, provenance, markdown },
          ],
        },
      ],
    },
  })

  it("are kept word for word in an owner block, spacing aside", () => {
    expect(
      missingOwnerContent(
        facts,
        about("owner", "We started in 2019 with one van. Now we are six.")
      )
    ).toEqual([])
  })

  it("are missing when reworded, dropped or written as the builder's", () => {
    expect(
      missingOwnerContent(
        facts,
        about("owner", "Since 2019 we have grown to six.")
      )
    ).toEqual(["story"])
    expect(
      missingOwnerContent(
        facts,
        about("facts", "We started in 2019 with one van. Now we are six.")
      )
    ).toEqual(["story"])
    expect(missingOwnerContent(facts, {})).toEqual([])
  })

  it("are a fixed input to every plan", () => {
    expect(ownerContent(facts)).toEqual([
      expect.stringContaining("never drop or reword"),
      '- story: "Our story", on about',
    ])
    expect(ownerContent([])).toEqual([])
  })
})

describe("redirects", () => {
  it("sends a removed service page to /services/ and keeps old redirects", () => {
    expect(
      redirectsFor(
        ["/", "/services/", "/services/oven/", "/services/deep/"],
        ["/", "/services/", "/services/deep/"],
        { "/services/carpet/": "/services/" }
      )
    ).toEqual({
      "/services/carpet/": "/services/",
      "/services/oven/": "/services/",
    })
  })

  it("drops a redirect whose page came back", () => {
    expect(
      redirectsFor([], ["/", "/services/", "/services/oven/"], {
        "/services/oven/": "/services/",
      })
    ).toEqual({})
  })
})

describe("the ready line", () => {
  it("lists what changed in plain words and says which check missed", () => {
    const lines = changeLines([
      {
        before: "",
        after: "We started in 2019 with one van.",
        pages: ["/about/"],
      },
      { before: "Call us", after: "Ring us today", pages: ["/"] },
    ])
    expect(lines).toEqual([
      'Added "We started in 2019 with one van." on About',
      'Changed "Call us" to "Ring us today" on Home',
    ])
    expect(
      readyText("site.revise", null, { label: "your About page", lines }, "x")
    ).toMatch(
      /About page[\s\S]*\n- Added "We started in 2019 with one van." on About\n- Changed/
    )
    expect(
      readyText("site.revise", null, {
        label: "your FAQ",
        missed: ["The FAQ comes before the services on the home page"],
      })
    ).toContain("didn't come out as asked: The FAQ comes before the services")
  })
})
