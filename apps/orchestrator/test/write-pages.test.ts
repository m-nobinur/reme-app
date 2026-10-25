import { describe, expect, it } from "vitest"
import { pageCheck, sandboxFindings, type WriterTask } from "../src/fanout.ts"
import type { PhotoFile } from "../src/photo-step.ts"
import {
  createWarmer,
  fieldLines,
  followPhotos,
  landedOf,
  parseReply,
  reconcilePhotos,
  setValues,
  writePages,
} from "../src/write-pages.ts"

const CONFIG = [
  "const values = {",
  "  /** The home page's main heading. */",
  '  heroHeading: "",',
  "  /**",
  "   * The about page's heading.",
  "   */",
  '  aboutHeading: "",',
  '  service1Heading: "",',
  '  homeTitle: "",',
  "  heroImage:",
  '    "src/assets/generated/home_hero.jpg",',
  '  aboutImage: "src/assets/generated/about_hero.jpg",',
  "}",
  "const fields = {",
  '  heroHeading: { kind: "composed" },',
  "}",
].join("\n")

const TASKS: WriterTask[] = [
  { agent: "page", prompt: "Page home. Your fields: heroHeading." },
  { agent: "page", prompt: "Page about. Your fields: aboutHeading." },
  { agent: "copy", prompt: "SEO and FAQ copy. Your fields: homeTitle." },
  {
    agent: "page",
    prompt:
      "Page service. Service 1's own page, /services/<slug of service1Name>/, laid out by layout.service. If service1Name is empty, leave your fields empty. Your fields: service1Heading.",
    after: 0,
  },
]

/** A site config in memory, changed one change at a time, as the tool's queue does. */
function memorySite(source = CONFIG) {
  let text = source
  return {
    edit: async (change: (s: string) => string) => {
      text = change(text)
      return text
    },
    get text() {
      return text
    },
  }
}

const reply = (values: Record<string, string>, summary = "Filled.") =>
  JSON.stringify({ summary, values })

describe("the writers' lines in the site config", () => {
  it("gives a writer each field's line with its note, wrapped values included", () => {
    expect(
      fieldLines(CONFIG, ["heroHeading", "aboutHeading", "heroImage"])
    ).toBe(`  /** The home page's main heading. */
  heroHeading: "",
  /**
   * The about page's heading.
   */
  aboutHeading: "",
  heroImage:
    "src/assets/generated/home_hero.jpg",`)
  })

  it("writes each value into its own line and nothing else, quotes escaped", () => {
    const next = setValues(CONFIG, {
      heroHeading: 'Gardens "kept" tidy\nall year',
      heroImage: "src/assets/generated/home_hero.png",
    })
    expect(next).toContain(
      '  heroHeading: "Gardens \\"kept\\" tidy\\nall year",'
    )
    expect(next).toContain(
      '  heroImage:\n    "src/assets/generated/home_hero.png",'
    )
    // The `fields` map's entry of the same name is not a value line.
    expect(next).toContain('  heroHeading: { kind: "composed" },')
    expect(next.split("\n")).toHaveLength(CONFIG.split("\n").length)
  })

  it("keeps a reply to the task's own string fields and refuses one with none", () => {
    expect(
      parseReply(
        "```json\n" +
          reply({ heroHeading: "Hi", aboutHeading: "Not yours", x: "1" }) +
          "\n```",
        ["heroHeading"]
      )
    ).toEqual({ summary: "Filled.", values: { heroHeading: "Hi" } })
    expect(() => parseReply("no json here", ["heroHeading"])).toThrow(
      "not JSON"
    )
    expect(() => parseReply(reply({ other: "x" }), ["heroHeading"])).toThrow(
      "no values for your fields"
    )
  })
})

describe("write_pages's fan-out", () => {
  it("runs at most max at once, the first alone until the stagger, a service page after the home page", async () => {
    const site = memorySite()
    // What the panel hears: each writer as it starts, then as it is written.
    const heard: string[] = []
    let active = 0
    let most = 0
    const order: string[] = []
    const releases: (() => void)[] = []
    const staggered: (() => void)[] = []
    const fields: Record<number, string> = {
      0: "heroHeading",
      1: "aboutHeading",
      2: "homeTitle",
      3: "service1Heading",
    }
    const pending = writePages({
      tasks: TASKS,
      max: 2,
      staggerMs: 3000,
      sleep: () =>
        new Promise<void>((resolve) => {
          staggered.push(resolve)
        }),
      edit: site.edit,
      onStarted: (task) => heard.push(`started ${TASKS.indexOf(task)}`),
      onWritten: (task) => heard.push(`written ${TASKS.indexOf(task)}`),
      call: async (index) => {
        order.push(`start ${index}`)
        active++
        most = Math.max(most, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active--
        order.push(`end ${index}`)
        // A title the copy check passes: 50 to 60 characters.
        const text =
          index === 2
            ? "Hollin Garden Care: lawns, hedges and borders in Bristol"
            : `text ${index}`
        return reply({ [fields[index] as string]: text })
      },
    })
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    await tick()
    // The home page's call goes alone until the stagger ends.
    expect(order).toEqual(["start 0"])
    expect(heard).toEqual(["started 0"])
    for (const end of staggered) end()
    await tick()
    // Then one more, the bound: about. The copy writer and the service page wait.
    expect(order).toEqual(["start 0", "start 1"])
    // Two at work at once, so the panel shows both being written.
    expect(heard).toEqual(["started 0", "started 1"])
    releases.shift()?.()
    await tick()
    await tick()
    // Home is done: the copy writer takes its slot, and the service page may queue.
    expect(order.slice(2)).toEqual(["end 0", "start 2"])
    while (releases.length > 0 || order.length < 8) {
      releases.shift()?.()
      await tick()
    }
    const lines = await pending
    expect(most).toBe(2)
    for (const index of [0, 1, 2, 3])
      expect(heard.indexOf(`started ${index}`)).toBeLessThan(
        heard.indexOf(`written ${index}`)
      )
    expect(order.indexOf("start 3")).toBeGreaterThan(order.indexOf("end 0"))
    expect(lines).toEqual([
      "- home: Filled.",
      "- about: Filled.",
      "- copy: Filled.",
      "- service1: Filled.",
    ])
    expect(site.text).toContain('heroHeading: "text 0"')
    expect(site.text).toContain('service1Heading: "text 3"')
  })

  it("gives a writer the copy check's findings once, and a writer that fails hands its fields to the lead", async () => {
    const site = memorySite(
      CONFIG.replace(
        '  homeTitle: "",',
        '  ctaHeading: "",\n  aboutCtaHeading: "Ready for a tidier garden",'
      )
    )
    const users: string[] = []
    let fix = ""
    const lines = await writePages({
      tasks: [
        { agent: "page", prompt: "Page home. Your fields: ctaHeading." },
        { agent: "page", prompt: "Page about. Your fields: aboutHeading." },
      ],
      max: 4,
      staggerMs: 0,
      sleep: async () => undefined,
      edit: site.edit,
      call: async (index, attempt, user, strict) => {
        users.push(`${index}.${attempt}${strict ? " strict" : ""}`)
        if (index === 0 && attempt === 2) fix = user
        if (index === 1) return "not json"
        // A closing heading the copy check refuses: it repeats the about page's.
        return attempt === 1
          ? reply({ ctaHeading: "Ready for a tidier garden?" })
          : reply({ ctaHeading: "Questions about the garden" }, "Fixed.")
      },
    })
    // Only the retry after an unparsable reply asks for the schema: a strict
    // call misses the writers' shared prompt cache.
    expect([...users].sort((a, b) => a.localeCompare(b))).toEqual([
      "0.1",
      "0.2",
      "1.1",
      "1.2 strict",
    ])
    // The fix call sees its own reply and the findings, after its field's line.
    expect(fix).toContain('  ctaHeading: "",')
    expect(fix).toContain(
      '<your_reply>\n{"ctaHeading":"Ready for a tidier garden?"}'
    )
    expect(fix).toContain("Fix exactly these in one more reply")
    expect(lines[0]).toBe("- home: Fixed. Fixed what the copy check found.")
    expect(site.text).toContain('ctaHeading: "Questions about the garden"')
    expect(lines[1]).toMatch(
      /^- about: failed \(The reply was not JSON.*\)\. Its fields are yours: aboutHeading\.$/
    )
  })
})

describe("a writer's own check, before the lead sees its fields", () => {
  // Perf run 2: titles came back 91 characters as shown, four icons were
  // guesses, and the lead spent its integration turns on both.
  const source = [
    "const values = {",
    '  businessName: "Brightside Window and Gutter Care",',
    '  service1Title: "Window Cleaning in Bristol | Brightside Care",',
    '  service1Icon: "sparkles",',
    `  service1Body: "A seamless clean ${String.fromCharCode(0x2014)} every pane, every sill, inside and out, across Bristol homes and flats.",`,
    "}",
  ].join("\n")
  const prompt =
    "Page service. Service 1's own page. Your fields: service1Title, service1Icon, service1Body."

  it("names the shown title's length, an unknown icon, an em dash and a stock phrase", () => {
    const check = pageCheck(source, prompt) ?? ""
    expect(check).toContain(
      'service1Title shows as "Window Cleaning in Bristol | Brightside Care | Brightside Window and Gutter Care", 80 characters'
    )
    expect(check).toContain(
      'service1Icon "sparkles" is not an icon; name one of: broom,'
    )
    expect(check).toContain("service1Body has an em dash")
    expect(check).toContain('service1Body says "seamless"')
  })

  it("passes fields the build's copy check passes", () => {
    expect(
      sandboxFindings(
        { service1Icon: "sparkle", service1Body: "Every pane, by hand." },
        ["service1Icon", "service1Body"]
      )
    ).toEqual([])
  })
})

describe("the photos while the pages are written", () => {
  const file = (slot_id: string, key: string, type = "image/jpeg") =>
    ({
      slot_id,
      status: "generated",
      key,
      content_type: type,
    }) as PhotoFile

  it("places each photo once as it lands and returns the step's final list", async () => {
    const polls: { files: PhotoFile[]; settled: PhotoFile[] | null }[] = [
      { files: [], settled: null },
      { files: [file("home_hero", "k1")], settled: null },
      { files: [file("home_hero", "k1")], settled: null },
      {
        files: [file("home_hero", "k1")],
        // A retry redrew the card: its new key is placed again.
        settled: [
          file("home_hero", "k1"),
          file("service_1_card", "k2", "image/png"),
        ],
      },
    ]
    const placed: string[][] = []
    let kicks = 0
    const got = await followPhotos({
      slots: ["home_hero", "service_1_card", "about_hero"],
      landed: async () => polls.shift() as (typeof polls)[number],
      place: async (files) => placed.push(files.map((f) => f.key as string)),
      onPlaced: () => kicks++,
      pollMs: 1,
      timeoutMs: 60_000,
      sleep: async () => undefined,
    })
    expect(placed).toEqual([["k1"], ["k2"]])
    expect(kicks).toBe(2)
    expect(got.timedOut).toBe(false)
    expect(got.files.map((f) => f.slot_id)).toEqual([
      "home_hero",
      "service_1_card",
    ])
  })

  it("stops waiting at the deadline with what landed, and waits for nothing when no slot is drawn", async () => {
    let now = 0
    const got = await followPhotos({
      slots: ["home_hero"],
      landed: async () => ({ files: [file("home_hero", "k1")], settled: null }),
      place: async () => undefined,
      pollMs: 2000,
      timeoutMs: 5000,
      sleep: async (ms) => {
        now += ms
      },
      now: () => now,
    })
    expect(got).toEqual({ files: [file("home_hero", "k1")], timedOut: true })
    expect(
      await followPhotos({
        slots: [],
        landed: () => {
          throw new Error("never read")
        },
        place: async () => undefined,
        pollMs: 1,
        timeoutMs: 1,
      })
    ).toEqual({ files: [], timedOut: false })
  })

  it("stops waiting the moment the Workflow says the photo step failed, with what had landed", async () => {
    const progress = {
      type: "build.progress",
      payload: {
        stage: "photos",
        item: "home_hero",
        status: "generated",
        key: "k1",
        content_type: "image/jpeg",
      },
    }
    // Before any settlement it waits; a fallback row is no photo.
    expect(
      landedOf([
        progress,
        {
          type: "build.progress",
          payload: { stage: "photos", item: "about_hero", status: "fallback" },
        },
      ])
    ).toEqual({ files: [file("home_hero", "k1")], settled: null })
    const failed = [
      progress,
      { type: "site.photos_failed", payload: { reason: "Error: draw" } },
    ]
    expect(landedOf(failed).settled).toEqual([file("home_hero", "k1")])
    // The step's own final list wins when it exists.
    expect(
      landedOf([
        progress,
        { type: "site.photos", payload: { step: { files: [] } } },
      ]).settled
    ).toEqual([])
    // One poll and no sleep: nothing waits out the five minutes.
    let polls = 0
    const got = await followPhotos({
      slots: ["home_hero", "about_hero"],
      landed: async () => {
        polls++
        return landedOf(failed)
      },
      place: async () => undefined,
      pollMs: 2000,
      timeoutMs: 5 * 60_000,
      sleep: () => {
        throw new Error("waited")
      },
    })
    expect(polls).toBe(1)
    expect(got).toEqual({ files: [file("home_hero", "k1")], timedOut: false })
  })

  it("points each slot's field at the photo as it landed, or empties it", () => {
    const next = reconcilePhotos(
      CONFIG,
      ["home_hero", "about_hero"],
      [file("home_hero", "k1", "image/png")]
    )
    expect(next).toContain('"src/assets/generated/home_hero.png",')
    expect(next).toContain('aboutImage: "",')
  })

  it("never runs two warm builds at once, and runs once more for what came during one", async () => {
    let active = 0
    let most = 0
    let runs = 0
    const finish: (() => void)[] = []
    const warm = createWarmer(async () => {
      runs++
      active++
      most = Math.max(most, active)
      await new Promise<void>((resolve) => finish.push(resolve))
      active--
    })
    warm.kick()
    warm.kick()
    warm.kick()
    const idle = warm.idle()
    finish.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    finish.shift()?.()
    await idle
    expect(runs).toBe(2)
    expect(most).toBe(1)
    await warm.idle()
  })
})
