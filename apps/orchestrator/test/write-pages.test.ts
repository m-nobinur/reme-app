import type { Asset, ImageSlot, PageDocument } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import type { Brief } from "../src/brief.ts"
import {
  offeredNames,
  sandboxFindings,
  type WriterTask,
  writerCheck,
} from "../src/fanout.ts"
import type { PhotoFile } from "../src/photo-step.ts"
import { STARTER_FILES } from "../src/seed.ts"
import {
  createWarmer,
  fieldLines,
  followPhotos,
  landedOf,
  parseReply,
  type Reply,
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

const task = (
  over: Partial<WriterTask> & Pick<WriterTask, "page">
): WriterTask => ({
  agent: "page",
  file: `${over.page}.json`,
  sections: [],
  meta: false,
  fields: [],
  prompt: `Page ${over.page}.`,
  ...over,
})

const TASKS: WriterTask[] = [
  task({ page: "home", fields: ["heroHeading"] }),
  task({ page: "about", fields: ["aboutHeading"] }),
  task({ agent: "copy", page: "home", sections: ["faq"] }),
  task({
    page: "service",
    offering: 1,
    file: "services/1.json",
    fields: ["service1Heading"],
    after: 0,
  }),
]

/**
 * A site in memory, each reply written one at a time as the tool's queue
 * does, and the check `check` gives back for each write.
 */
function memorySite(
  tasks: readonly WriterTask[],
  source = CONFIG,
  check: (index: number, reply: Reply) => string | null = () => null
) {
  let text = source
  const written: Reply["written"][] = []
  return {
    user: async (index: number) =>
      fieldLines(text, (tasks[index] as WriterTask).fields),
    apply: async (index: number, given: Reply) => {
      text = setValues(text, given.values)
      written[index] = given.written
      return check(index, given)
    },
    written,
    get text() {
      return text
    },
  }
}

const reply = (
  values: Record<string, string>,
  summary = "Filled.",
  extra: Record<string, unknown> = {}
) => JSON.stringify({ summary, values, ...extra })

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

  it("names each service from the offerings before any writer runs, six at most", () => {
    const items = ["Deep cleans", "Move-out cleans", "a", "b", "c", "d", "e"]
    const brief = {
      snapshot: { facts: [{ key: "business.offerings", value: { items } }] },
    } as unknown as Brief
    expect(offeredNames(brief)).toEqual({
      service1Name: "Deep cleans",
      service2Name: "Move-out cleans",
      service3Name: "a",
      service4Name: "b",
      service5Name: "c",
      service6Name: "d",
    })
  })

  it("keeps a reply to the task's own fields and sections, and refuses one with neither", () => {
    const own = {
      fields: ["heroHeading"],
      sections: ["hero"],
      meta: true,
    }
    expect(
      parseReply(
        "```json\n" +
          reply(
            { heroHeading: "Hi", aboutHeading: "Not yours", x: "1" },
            "Filled.",
            {
              title: "A title",
              description: 7,
              sections: {
                hero: { heading: "Gardens", kind: "faq", blocks: [] },
                faq: { heading: "Not yours" },
              },
            }
          ) +
          "\n```",
        own
      )
    ).toEqual({
      summary: "Filled.",
      values: { heroHeading: "Hi" },
      written: {
        title: "A title",
        sections: { hero: { heading: "Gardens", blocks: [] } },
      },
    })
    // The page's title is its page writer's, never the FAQ writer's.
    expect(
      parseReply(reply({}, "x", { title: "Mine?", sections: { faq: {} } }), {
        fields: [],
        sections: ["faq"],
        meta: false,
      }).written
    ).toEqual({ sections: { faq: {} } })
    expect(() => parseReply("no json here", own)).toThrow("not JSON")
    expect(() => parseReply(reply({ other: "x" }), own)).toThrow(
      "nothing for your task: values for heroHeading and sections hero"
    )
  })
})

describe("write_pages's fan-out", () => {
  it("runs at most max at once, the first alone until the stagger, a service page after the home page", async () => {
    const site = memorySite(TASKS)
    // What the panel hears: each writer as it starts, then as it is written.
    const heard: string[] = []
    let active = 0
    let most = 0
    const order: string[] = []
    const releases: (() => void)[] = []
    const staggered: (() => void)[] = []
    const pending = writePages({
      tasks: TASKS,
      max: 2,
      staggerMs: 3000,
      sleep: () =>
        new Promise<void>((resolve) => {
          staggered.push(resolve)
        }),
      user: site.user,
      apply: site.apply,
      onStarted: (t) => heard.push(`started ${TASKS.indexOf(t)}`),
      onWritten: (t) => heard.push(`written ${TASKS.indexOf(t)}`),
      call: async (index) => {
        order.push(`start ${index}`)
        active++
        most = Math.max(most, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active--
        order.push(`end ${index}`)
        const own = TASKS[index] as WriterTask
        return reply(
          Object.fromEntries(own.fields.map((f) => [f, `text ${index}`])),
          "Filled.",
          { sections: { faq: { heading: "Before your first clean" } } }
        )
      },
    })
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    await tick()
    // The home page's call goes alone until the stagger ends.
    expect(order).toEqual(["start 0"])
    expect(heard).toEqual(["started 0"])
    for (const end of staggered) end()
    await tick()
    // Then one more, the bound: about. The FAQ writer and the service page wait.
    expect(order).toEqual(["start 0", "start 1"])
    // Two at work at once, so the panel shows both being written.
    expect(heard).toEqual(["started 0", "started 1"])
    releases.shift()?.()
    await tick()
    await tick()
    // Home is done: the FAQ writer takes its slot, and the service page may queue.
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
      "- faq: Filled.",
      "- service1: Filled.",
    ])
    expect(site.text).toContain('heroHeading: "text 0"')
    expect(site.text).toContain('service1Heading: "text 3"')
    expect(site.written[2]).toEqual({
      sections: { faq: { heading: "Before your first clean" } },
    })
  })

  it("gives a writer the copy check's findings once, and a writer that fails hands its part to the lead", async () => {
    const tasks = [
      task({ page: "home", fields: ["heroHeading"], sections: ["cta-band"] }),
      task({ page: "about", fields: ["aboutHeading"] }),
    ]
    let checked = 0
    const site = memorySite(tasks, CONFIG, (index) =>
      index === 0 && checked++ === 0
        ? "The copy gate's check of what you wrote, before the build, found:\n- the heading repeats the about page's\nFix exactly these in one more reply, then stop."
        : null
    )
    const users: string[] = []
    let fix = ""
    const lines = await writePages({
      tasks,
      max: 4,
      staggerMs: 0,
      sleep: async () => undefined,
      user: site.user,
      apply: site.apply,
      call: async (index, attempt, user, strict) => {
        users.push(`${index}.${attempt}${strict ? " strict" : ""}`)
        if (index === 0 && attempt === 2) fix = user
        if (index === 1) return "not json"
        return attempt === 1
          ? reply({ heroHeading: "Ready for a tidier garden?" })
          : reply({ heroHeading: "Gardens kept tidy in Bristol" }, "Fixed.")
      },
    })
    // Only the retry after an unparsable reply asks for strict output: a
    // strict call misses the writers' shared prompt cache.
    expect([...users].sort((a, b) => a.localeCompare(b))).toEqual([
      "0.1",
      "0.2",
      "1.1",
      "1.2 strict",
    ])
    // The fix call sees its own reply and the findings, after its field's line.
    expect(fix).toContain('  heroHeading: "",')
    expect(fix).toContain(
      '<your_reply>\n{"values":{"heroHeading":"Ready for a tidier garden?"},"sections":{}}'
    )
    expect(fix).toContain("Fix exactly these in one more reply")
    expect(lines[0]).toBe("- home: Fixed. Fixed what the copy check found.")
    expect(site.text).toContain('heroHeading: "Gardens kept tidy in Bristol"')
    expect(lines[1]).toMatch(
      /^- about: failed \(The reply was not JSON.*\)\. Its part is yours: src\/site-config\.ts fields aboutHeading\.$/
    )
  })

  it("fixes what the check refuses even after a retry, as a third call", async () => {
    const tasks = [task({ page: "service", fields: ["service1Heading"] })]
    const refused =
      'Your sections are not a page document\'s yet, so nothing of them was written:\n- sections.1.blocks.0: Unrecognized key: "body"\nFix them in one more reply, then stop.'
    let checked = 0
    const site = memorySite(tasks, CONFIG, () =>
      checked++ === 0 ? refused : null
    )
    const calls: string[] = []
    let fix = ""
    const lines = await writePages({
      tasks,
      max: 1,
      staggerMs: 0,
      sleep: async () => undefined,
      user: site.user,
      apply: site.apply,
      call: async (_, attempt, user) => {
        calls.push(String(attempt))
        if (attempt === 3) fix = user
        return attempt === 1
          ? ""
          : reply({ service1Heading: "Deep cleans in Leeds" }, "Filled.")
      },
    })
    expect(calls).toEqual(["1", "2", "3"])
    expect(fix).toContain('Unrecognized key: "body"')
    expect(lines[0]).toBe("- service: Filled. Fixed what the copy check found.")
  })
})

describe("a writer's own check, before the lead sees its work", () => {
  // Perf run 2: titles came back 91 characters as shown, four icons were
  // guesses, and the lead spent its integration turns on both.
  const values = {
    businessName: "Brightside Window and Gutter Care",
    service1Icon: "sparkles",
    service1Body: `A seamless clean ${String.fromCharCode(0x2014)} every pane, every sill, inside and out, across Bristol homes and flats.`,
  }
  const service = task({
    page: "service",
    offering: 1,
    file: "services/1.json",
    sections: ["hero", "content"],
    meta: true,
    fields: ["service1Icon", "service1Body"],
  })
  const doc: PageDocument = {
    page: "service",
    slug: "window-cleaning",
    title: "Window Cleaning in Bristol | Brightside Care",
    description: "Too short.",
    sections: [
      { id: "hero", kind: "hero", heading: "Window cleaning in Bristol" },
      {
        id: "content",
        kind: "content",
        heading: "How it differs from gutter clearing",
        blocks: [
          {
            id: "kinds",
            type: "cards",
            provenance: "trade",
            items: [
              { title: "Frames", body: "Wiped by hand.", icon: "sparkles" },
            ],
          },
        ],
      },
    ],
  }

  it("names the shown title's length, an unknown icon, an em dash and a stock phrase", () => {
    const check =
      writerCheck({ task: service, values, doc, others: [], services: 2 }) ?? ""
    expect(check).toContain(
      'the title shows as "Window Cleaning in Bristol | Brightside Care | Brightside Window and Gutter Care", 80 characters'
    )
    expect(check).toContain("the description is 10 characters")
    expect(check).toContain(
      'service1Icon "sparkles" is not an icon; name one of: broom,'
    )
    expect(check).toContain(`section content's icon "sparkles" is not an icon`)
    expect(check).toContain("service1Body has an em dash")
    expect(check).toContain('service1Body says "seamless"')
  })

  it("holds a writer to its own sections, and passes what the build's copy check passes", () => {
    const faq = task({ agent: "copy", page: "service", sections: ["hero"] })
    expect(
      writerCheck({
        task: faq,
        values: {},
        doc: { ...doc, title: "x", description: "x" },
        others: [],
        services: 1,
      })
    ).toBeNull()
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

  it("writes every planned photo's path and alt into the starter's own fields", () => {
    const slot = (id: string, page: string, section: string) =>
      ({
        id,
        page,
        section,
        aspect: "4:3",
        resolution: "1K",
        subject: id,
        alt: `${id} alt`,
        source: "generated",
      }) as ImageSlot
    const assetId = "0b0c5f4e-6a59-4f1e-9a43-1c1b3f0e7a11"
    const upload = {
      ...slot("gallery_1", "home", "gallery"),
      source: "upload",
      asset_id: assetId,
    } as ImageSlot
    const next = reconcilePhotos(
      STARTER_FILES["src/site-config.ts"] as string,
      [
        slot("home_hero", "home", "hero"),
        slot("service_2_hero", "service", "hero"),
        slot("service_1_card", "home", "service_cards"),
        slot("about_hero", "about", "hero"),
        slot("home_cta_photo", "home", "cta_band"),
        slot("contact_hero", "contact", "hero"),
        upload,
      ],
      [
        file("home_hero", "k1", "image/png"),
        file("service_2_hero", "k2"),
        file("service_1_card", "k3", "image/webp"),
        file("about_hero", "k4"),
        file("home_cta_photo", "k5"),
      ],
      [{ id: assetId, content_type: "image/jpeg" } as Asset]
    )
    for (const line of [
      'heroImage: "src/assets/generated/home_hero.png",',
      'heroImageAlt: "home_hero alt",',
      'service2HeaderImage: "src/assets/generated/service_2_hero.jpg",',
      'service2HeaderImageAlt: "service_2_hero alt",',
      'service1Image: "src/assets/generated/service_1_card.webp",',
      'aboutImage: "src/assets/generated/about_hero.jpg",',
      'ctaImage: "src/assets/generated/home_cta_photo.jpg",',
      `photo1Src: "/uploads/${assetId}.jpg",`,
      'photo1Alt: "gallery_1 alt",',
      'contactImage: "",',
      'contactImageAlt: "",',
    ])
      expect(next).toContain(line)
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
