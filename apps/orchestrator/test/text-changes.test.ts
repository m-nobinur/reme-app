import { describe, expect, it, vi } from "vitest"

const base = {
  revision: "20000000-0000-4000-8000-0000000000aa" as string | null,
}
vi.mock("../src/revise.ts", () => ({
  reviseSource: async () =>
    base.revision ? { revision_id: base.revision } : null,
}))

const { collect, cut, recordTextChanges, textPairs } = await import(
  "../src/text-changes.ts"
)

const page = (parts: { hero?: string; body?: string[]; footer?: string }) =>
  `<!doctype html><html><head><title>Acme</title><meta name="description" content="${parts.hero}"></head><body>` +
  `<main><section><h1>${parts.hero ?? "Welcome"}</h1><p>Weekly cleaning</p></section>` +
  `${(parts.body ?? []).map((text) => `<section><p>${text}</p></section>`).join("")}</main>` +
  `<footer><p>${parts.footer ?? "Call us"}</p></footer></body></html>`

describe("textPairs", () => {
  it("pairs a rewritten heading as one before and after", () => {
    expect(
      textPairs(
        page({ hero: "Clean homes" }),
        page({ hero: "Come home to calm" })
      )
    ).toEqual([{ before: "Clean homes", after: "Come home to calm" }])
  })

  it("reads text, not markup, attributes or the head's meta", () => {
    const plain = '<html><body><p class="a">Hi   there</p></body></html>'
    const styled = '<html><body><p class="b" id="x">Hi there</p></body></html>'
    expect(textPairs(plain, styled)).toEqual([])
  })

  it("shows text with no partner as an addition or a removal", () => {
    const old = page({ body: ["Pets welcome"] })
    const now = page({})
    expect(textPairs(old, now)).toEqual([{ before: "Pets welcome", after: "" }])
    expect(textPairs(now, old)).toEqual([{ before: "", after: "Pets welcome" }])
  })

  it("does not count a reordered section as a change", () => {
    const one = page({ body: ["First section", "Second section"] })
    const two = page({ body: ["Second section", "First section"] })
    expect(textPairs(one, two)).toEqual([])
  })

  it("shows an inserted section as an addition and leaves the rest alone", () => {
    const old = page({ body: ["Pets welcome"] })
    const now = page({ body: ["Pets welcome", "New offer"] })
    expect(textPairs(old, now)).toEqual([{ before: "", after: "New offer" }])
  })
})

describe("cut", () => {
  it("leaves 300 characters alone and cuts a longer text at a word", () => {
    const exact = "a".repeat(300)
    expect(cut(exact)).toBe(exact)
    const long = `${"word ".repeat(80)}end`
    const cutLong = cut(long)
    expect(cutLong.length).toBeLessThanOrEqual(300)
    expect(cutLong.endsWith("word…")).toBe(true)
  })

  it("hard-cuts a text with no space", () => {
    expect(cut("a".repeat(400))).toBe(`${"a".repeat(299)}…`)
  })
})

describe("collect", () => {
  it("records a footer edit on six pages once, naming five of them", () => {
    const files = [
      "index.html",
      ...["a", "b", "c", "d", "e"].map((s) => `${s}/index.html`),
    ]
    const result = collect(
      files.map((file) => ({
        file,
        before: page({ footer: "Call 555 0100" }),
        after: page({ footer: "Call 555 0199" }),
      }))
    )
    expect(result).toEqual({
      text_changes: [
        {
          before: "Call 555 0100",
          after: "Call 555 0199",
          pages: ["/", "/a/", "/b/", "/c/", "/d/"],
        },
      ],
    })
  })

  it("keeps eight pairs and counts the rest", () => {
    const body = Array.from({ length: 11 }, (_, i) => `Line ${i}`)
    const result = collect([
      {
        file: "index.html",
        before: page({ body }),
        after: page({ body: body.map((text) => `${text} changed`) }),
      },
    ])
    expect(result.text_changes).toHaveLength(8)
    expect(result.text_changes_left).toBe(3)
  })

  it("is an empty list when the pages differ and no text does", () => {
    expect(
      collect([{ file: "index.html", before: page({}), after: page({}) }])
    ).toEqual({ text_changes: [] })
  })
})

describe("recordTextChanges", () => {
  const ORG = "10000001-0000-4000-8000-000000000000"
  const OLD = `sites/${ORG}/${base.revision}/`
  const NEW = `sites/${ORG}/20000000-0000-4000-8000-0000000000bb/`
  const manifest = (files: Record<string, string>) =>
    JSON.stringify({
      revision_id: "20000000-0000-4000-8000-0000000000bb",
      site_id: ORG,
      org_id: ORG,
      routes: [],
      headers: {},
      files,
      built_at: "2026-10-31T00:00:00.000Z",
    })
  const run = async (options: {
    kind?: string
    objects: Record<string, string>
    /** The stored size reported for every object. */
    size?: number
    dbFails?: boolean
  }) => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            if (options.dbFails) throw new Error("connection reset")
            return [{ kind: options.kind ?? "site.revise" }]
          },
        }),
      }),
    }
    const reads: string[] = []
    const result = await recordTextChanges({
      kit: {
        withOrg: (_: unknown, fn: (d: unknown) => unknown) => fn(db),
      } as never,
      sites: {
        get: async (key: string) => {
          reads.push(key)
          const body = options.objects[key]
          return body === undefined
            ? null
            : { size: options.size, text: async () => body }
        },
      },
      orgId: ORG,
      assignmentId: "a",
      prefix: NEW,
    })
    return { result, reads }
  }
  const hash = (digit: string) => digit.repeat(64)
  const stored = (before: string, after: string) => ({
    [`${OLD}manifest.json`]: manifest({
      "index.html": hash("1"),
      "app.css": hash("c"),
    }),
    [`${NEW}manifest.json`]: manifest({
      "index.html": hash("2"),
      "app.css": hash("d"),
    }),
    [`${OLD}dist/index.html`]: before,
    [`${NEW}dist/index.html`]: after,
  })

  it("reads only the pages whose hash changed and pairs their text", async () => {
    const { result, reads } = await run({
      objects: stored(page({ hero: "Old title" }), page({ hero: "New title" })),
    })
    expect(result).toEqual({
      text_changes: [{ before: "Old title", after: "New title", pages: ["/"] }],
    })
    expect(reads.filter((key) => key.includes("/dist/"))).toHaveLength(2)
  })

  it("records nothing for a first build and never reads the bucket", async () => {
    const { result, reads } = await run({ kind: "site.build", objects: {} })
    expect(result).toEqual({})
    expect(reads).toEqual([])
  })

  it("records nothing, and does not fail, when the base was swept", async () => {
    const objects = stored(page({ hero: "Old" }), page({ hero: "New" }))
    delete objects[`${OLD}manifest.json`]
    expect((await run({ objects })).result).toEqual({})
    const gone = stored(page({ hero: "Old" }), page({ hero: "New" }))
    delete gone[`${OLD}dist/index.html`]
    expect((await run({ objects: gone })).result).toEqual({})
  })

  it("records nothing, and does not fail, when the database read fails", async () => {
    const objects = stored(page({ hero: "Old" }), page({ hero: "New" }))
    expect((await run({ objects, dbFails: true })).result).toEqual({})
  })

  it("reads no page of more than a megabyte", async () => {
    const objects = stored(page({ hero: "Old" }), page({ hero: "New" }))
    expect((await run({ objects, size: 1_000_001 })).result).toEqual({})
    expect((await run({ objects, size: 1_000_000 })).result).toMatchObject({
      text_changes: [{ before: "Old", after: "New" }],
    })
  })

  it("reads no pages at all when more than forty changed", async () => {
    const names = Array.from({ length: 41 }, (_, i) => `p${i}/index.html`)
    const files = (digit: string) =>
      Object.fromEntries(names.map((name) => [name, hash(digit)]))
    const objects = {
      [`${OLD}manifest.json`]: manifest(files("1")),
      [`${NEW}manifest.json`]: manifest(files("2")),
      ...Object.fromEntries(
        names.flatMap((name) => [
          [`${OLD}dist/${name}`, page({ hero: "Old" })],
          [`${NEW}dist/${name}`, page({ hero: "New" })],
        ])
      ),
    }
    const { result, reads } = await run({ objects })
    expect(result).toEqual({})
    expect(reads.filter((key) => key.includes("/dist/"))).toEqual([])
  })

  it("records nothing, and does not fail, when a manifest does not parse", async () => {
    const objects = stored(page({ hero: "Old" }), page({ hero: "New" }))
    objects[`${NEW}manifest.json`] = "not json"
    expect((await run({ objects })).result).toEqual({})
  })

  it("leaves a page added or removed by the change out", async () => {
    const objects = stored(page({}), page({}))
    objects[`${OLD}manifest.json`] = manifest({
      "index.html": hash("1"),
      "about/index.html": hash("e"),
    })
    objects[`${NEW}manifest.json`] = manifest({
      "index.html": hash("1"),
      "faq/index.html": hash("f"),
    })
    expect((await run({ objects })).result).toEqual({ text_changes: [] })
  })
})
