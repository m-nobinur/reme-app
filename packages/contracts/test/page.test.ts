import { describe, expect, it } from "vitest"
import { FactValue } from "../src/owner.ts"
import { BLOCK_TYPES, PageDocument } from "../src/page.ts"

const owner = { provenance: "owner" } as const
const EVERY_BLOCK = [
  {
    ...owner,
    id: "story",
    type: "prose",
    markdown: "## Our story\n\nWe **clean**.",
  },
  { ...owner, id: "covers", type: "checklist", items: ["Oven", "Windows"] },
  {
    ...owner,
    id: "compare",
    type: "table",
    columns: ["Service", "Best for"],
    rows: [["Deep clean", "A fresh start"]],
  },
  {
    ...owner,
    id: "asked",
    type: "faq",
    items: [{ question: "Q?", answer: "A." }],
  },
  {
    ...owner,
    id: "visit",
    type: "steps",
    items: [{ title: "Arrive", body: "On time." }],
  },
  {
    ...owner,
    id: "why",
    type: "cards",
    items: [{ title: "Care", body: "Always.", icon: "leaf" }],
  },
  {
    ...owner,
    id: "kitchen",
    type: "media",
    src: "/uploads/a.jpg",
    alt: "A kitchen",
  },
  { ...owner, id: "note", type: "callout", text: "Keys by arrangement." },
  {
    ...owner,
    id: "ask",
    type: "cta",
    heading: "Book a clean",
    body: "Tell us about it.",
    href: "/quote/",
  },
  { ...owner, id: "said", type: "quote", text: "Spotless.", author: "Sam" },
]

const doc = (sections: unknown[], extra: Record<string, unknown> = {}) => ({
  page: "home",
  sections,
  ...extra,
})

describe("PageDocument", () => {
  it("takes a section of every block type", () => {
    expect(EVERY_BLOCK.map((b) => b.type).sort()).toEqual(
      [...BLOCK_TYPES].sort()
    )
    const parsed = PageDocument.safeParse(
      doc([{ id: "all", kind: "content", heading: "All", blocks: EVERY_BLOCK }])
    )
    expect(parsed.error).toBeUndefined()
  })

  it("takes a starter kind with its own variant and a custom section by name", () => {
    expect(
      PageDocument.safeParse(
        doc([
          { id: "faq", kind: "faq", variant: "stacked" },
          { id: "note", kind: "custom", name: "Callout", blocks: [] },
        ])
      ).success
    ).toBe(true)
  })

  it.each([
    [
      "a variant of another kind",
      [{ id: "faq", kind: "faq", variant: "wash" }],
    ],
    ["a custom section with no name", [{ id: "x", kind: "custom" }]],
    ["an unknown kind", [{ id: "x", kind: "banner" }]],
    [
      "a repeated section id",
      [
        { id: "a", kind: "content" },
        { id: "a", kind: "content" },
      ],
    ],
    [
      "a block id a section already has",
      [
        {
          id: "a",
          kind: "content",
          blocks: [{ ...owner, id: "a", type: "callout", text: "x" }],
        },
      ],
    ],
    [
      "a script link",
      [
        {
          id: "a",
          kind: "content",
          blocks: [
            {
              ...owner,
              id: "b",
              type: "cta",
              heading: "",
              body: "",
              href: "javascript:alert(1)",
            },
          ],
        },
      ],
    ],
    [
      "a photo from another host",
      [
        {
          id: "a",
          kind: "content",
          blocks: [
            {
              ...owner,
              id: "b",
              type: "media",
              src: "//evil.example/a.jpg",
              alt: "",
            },
          ],
        },
      ],
    ],
    [
      "a table row short of a cell",
      [
        {
          id: "a",
          kind: "content",
          blocks: [
            {
              ...owner,
              id: "b",
              type: "table",
              columns: ["A", "B"],
              rows: [["1"]],
            },
          ],
        },
      ],
    ],
    [
      "a block with no provenance",
      [
        {
          id: "a",
          kind: "content",
          blocks: [{ id: "b", type: "callout", text: "x" }],
        },
      ],
    ],
  ])("refuses %s", (_, sections) => {
    expect(PageDocument.safeParse(doc(sections)).success).toBe(false)
  })

  it("gives a service page a slug and no other page one", () => {
    expect(
      PageDocument.safeParse({ page: "service", sections: [] }).success
    ).toBe(false)
    expect(
      PageDocument.safeParse(doc([], { slug: "deep-clean" })).success
    ).toBe(false)
    expect(
      PageDocument.safeParse({
        page: "service",
        slug: "deep-clean",
        sections: [],
      }).success
    ).toBe(true)
  })
})

describe("site.content", () => {
  const item = {
    id: "our-story",
    page: "about",
    title: "Our story",
    markdown: "We started in 2019.",
  }

  it("keeps the owner's pieces, each with an id and a page or none", () => {
    expect(
      FactValue.safeParse({
        key: "site.content",
        value: { items: [item, { ...item, id: "end-of-tenancy", page: null }] },
      }).success
    ).toBe(true)
  })

  it("refuses an empty piece and a page the site has no document for", () => {
    for (const bad of [
      { ...item, markdown: " " },
      { ...item, page: "blog" },
    ])
      expect(
        FactValue.safeParse({ key: "site.content", value: { items: [bad] } })
          .success
      ).toBe(false)
  })
})
