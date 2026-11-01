import { describe, expect, it } from "vitest"
import { inline, parseMarkdown, plainOf } from "../src/markdown"

const text = (t: string) => ({ type: "text", text: t })

describe("parseMarkdown", () => {
  it("reads headings, paragraphs, lists and a table", () => {
    const blocks = parseMarkdown(
      [
        "## What we cover",
        "",
        "Every room, top to bottom,",
        "and the oven.",
        "",
        "### Kitchen",
        "- Hob",
        "- Inside the fridge",
        "  and freezer",
        "",
        "1. Book",
        "2. Clean",
        "",
        "| Room | Time |",
        "| --- | ---: |",
        "| Kitchen | 2 hours |",
        "| Bath |",
      ].join("\n")
    )
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "list",
      "table",
    ])
    expect(blocks[1]).toEqual({
      type: "paragraph",
      children: [text("Every room, top to bottom, and the oven.")],
    })
    expect(blocks[2]).toMatchObject({ type: "heading", level: 3 })
    expect(blocks[3]).toEqual({
      type: "list",
      ordered: false,
      items: [[text("Hob")], [text("Inside the fridge and freezer")]],
    })
    expect(blocks[4]).toMatchObject({ type: "list", ordered: true })
    expect(blocks[5]).toEqual({
      type: "table",
      head: [[text("Room")], [text("Time")]],
      rows: [
        [[text("Kitchen")], [text("2 hours")]],
        [[text("Bath")], []],
      ],
    })
  })

  it("never makes a page h1: one hash is an h2, four are an h3", () => {
    expect(
      parseMarkdown("# Big\n#### Small").map(
        (b) => b.type === "heading" && b.level
      )
    ).toEqual([2, 3])
  })

  it("keeps a tag as text, for Astro to escape", () => {
    expect(
      parseMarkdown('<script>alert("x")</script>\n<img src=x onerror=y>')
    ).toEqual([
      {
        type: "paragraph",
        children: [text('<script>alert("x")</script> <img src=x onerror=y>')],
      },
    ])
  })
})

describe("inline", () => {
  it("reads bold, italic and a link, nested", () => {
    expect(inline("**Fully** *booked* see [our *prices*](/quote/)")).toEqual([
      { type: "strong", children: [text("Fully")] },
      text(" "),
      { type: "em", children: [text("booked")] },
      text(" see "),
      {
        type: "link",
        href: "/quote/",
        children: [text("our "), { type: "em", children: [text("prices")] }],
      },
    ])
  })

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,x",
    "//evil.example",
    "vbscript:x",
  ])("leaves a link to %s as the words typed", (href) => {
    expect(plainOf(inline(`[click](${href})`))).toBe(`[click](${href})`)
    expect(inline(`[click](${href})`).some((n) => n.type === "link")).toBe(
      false
    )
  })

  it.each([
    "https://a.example/x",
    "mailto:a@b.example",
    "tel:+15550142",
    "#faq",
    "/about/",
  ])("links to %s", (href) => {
    expect(inline(`[x](${href})`)).toEqual([
      { type: "link", href, children: [text("x")] },
    ])
  })

  it("reads arithmetic and snake_case as text", () => {
    expect(inline("2 * 3 * 4 rooms")).toEqual([text("2 * 3 * 4 rooms")])
    expect(inline("end_of_tenancy")).toEqual([text("end_of_tenancy")])
  })

  it("takes a backslash as a literal mark", () => {
    expect(inline("\\*not\\* \\[a](/x)")).toEqual([text("*not* [a](/x)")])
  })

  it("puts no link inside a link", () => {
    for (const node of inline("[a [b](/b)](/a) [[c](/c)](/d)"))
      if (node.type === "link")
        expect(node.children.every((child) => child.type === "text")).toBe(true)
  })
})
