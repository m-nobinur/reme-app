import { readFileSync } from "node:fs"
import { URL } from "node:url"
import { RULES, TELLS } from "@workspace/gates/rubric"
import { layout, site } from "@workspace/starter-site/site-config"
import { describe, expect, it, vi } from "vitest"
import {
  type Complete,
  type Config,
  changedPieces,
  criticPrompt,
  critique,
  FIXES_MAX,
  type Fix,
  type Piece,
  payloadOf,
  readConfig,
  readFixes,
  settle,
  unmakeable,
  verdictOf,
  whyNot,
  withBefore,
} from "../src/critic.ts"

// critic.ts reaches brief.ts, which names the registry host from sandbox.ts.
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
}))

const fix = (section: string, page = "home"): Fix => ({
  page,
  section,
  problem: `${section} breaks a rule.`,
  change: `Change ${section}.`,
})

const route = {
  model: "openrouter/anthropic/claude-sonnet-5.5",
  effort: "medium" as const,
  maxTokens: 4_000,
}
const base = {
  route,
  sessionId: "assignment-1",
  blueprint: { direction: "calm_daylight" },
  images: [
    { width: 390, part: 1, data: "QQ==" },
    { width: 1440, part: 1, data: "Qg==" },
    { width: 1440, part: 2, data: "Qw==" },
  ] satisfies Piece[],
}
const replying =
  (text: string): Complete =>
  async () => ({ text, usage: { cost: 0.01 }, model: route.model })

describe("the critic's prompt", () => {
  it("reads the rubric's own rules and tells, and the Blueprint", () => {
    const { system, user } = criticPrompt({ blueprint: { direction: "x" } })
    for (const r of [...RULES, ...TELLS]) expect(system).toContain(r.id)
    expect(user).toContain('"direction":"x"')
    expect(user).toContain("- 390 px wide: 0 pieces")
    expect(user).not.toContain("on the build before this one")
  })

  it("tells the critic how many pieces of each width it is shown", () => {
    const pieces = [
      [390, 1],
      [390, 2],
      [390, 3],
      [1440, 2],
    ].map(([width, part]) => ({
      width: width as number,
      part: part as number,
      data: "QQ==",
    }))
    const { user } = criticPrompt({ blueprint: {}, pieces })
    expect(user).toContain("- 390 px wide: 3 pieces, screens 1, 2, 3")
    // A recheck shows only what changed, so a width can hold a later screen alone.
    expect(user).toContain("- 1440 px wide: 1 piece, screens 2")
    expect(user).not.toContain("768")
  })

  it("names the earlier fixes on the second look", () => {
    const { user } = criticPrompt({ blueprint: {}, earlier: [fix("Hero")] })
    expect(user).toContain("on the build before this one")
    expect(user).toContain("Hero breaks a rule.")
  })
})

describe("critique", () => {
  it("sends every piece as a picture, in order, and returns the fixes", async () => {
    const complete = vi.fn(
      replying(JSON.stringify({ fixes: [fix("Hero"), fix("Faq")] }))
    )
    const out = await critique({ ...base, complete })
    expect(out.fixes).toEqual([fix("Hero"), fix("Faq")])
    expect(out).toMatchObject({ ran: true, errors: [] })
    const call = complete.mock.calls[0]?.[0]
    expect(call?.images).toEqual([
      { data: "QQ==", mimeType: "image/jpeg" },
      { data: "Qg==", mimeType: "image/jpeg" },
      { data: "Qw==", mimeType: "image/jpeg" },
    ])
    expect(call?.cacheRetention).toBe("none")
    expect(call?.maxTokens).toBe(4_000)
    expect(call?.schema.name).toBe("design_critique")
  })

  it("keeps five fixes at most", async () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((s) => fix(s))
    const out = await critique({
      ...base,
      complete: replying(`Here:\n${JSON.stringify({ fixes: six })}`),
    })
    expect(out.fixes).toHaveLength(FIXES_MAX)
    expect(out.fixes.at(-1)?.section).toBe("e")
  })

  it("drops a fix with a missing or empty field rather than guessing", () => {
    const rows = [
      fix("Hero"),
      { page: "home", section: "Faq", problem: "", change: "x" },
      { page: "home", section: "Steps", problem: "y" },
      null,
    ]
    expect(readFixes(JSON.stringify({ fixes: rows }))).toEqual([fix("Hero")])
  })

  it("answers an empty list when the site holds", async () => {
    const out = await critique({ ...base, complete: replying('{"fixes":[]}') })
    expect(out).toMatchObject({ fixes: [], ran: true, errors: [] })
  })

  it("never throws: a failed call, a bad reply or no screenshots are no fixes and a reason", async () => {
    const failed = await critique({
      ...base,
      complete: async () => {
        throw new Error("provider.unavailable")
      },
    })
    expect(failed).toMatchObject({
      fixes: [],
      ran: false,
      errors: ["provider.unavailable"],
    })
    const prose = await critique({ ...base, complete: replying("Looks fine.") })
    expect(prose.fixes).toEqual([])
    expect(prose.errors[0]).toContain("no JSON object")
    expect(prose.ran).toBe(false)
    // A reply that parsed but is not a fixes list is the same as no reply.
    const odd = await critique({ ...base, complete: replying('{"ok":true}') })
    expect(odd.errors[0]).toContain("no fixes list")
    const complete = vi.fn(replying('{"fixes":[]}'))
    const blind = await critique({ ...base, images: [], complete })
    expect(blind).toMatchObject({
      fixes: [],
      ran: false,
      errors: ["no screenshots were taken"],
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it("keeps the model's usage for the meter, even when the reply is unusable", async () => {
    const out = await critique({ ...base, complete: replying("Looks fine.") })
    expect(out.calls).toEqual([{ usage: { cost: 0.01 }, model: route.model }])
  })
})

describe("the recheck's pictures", () => {
  it("are the pieces the repair changed, or that are new, and no others", () => {
    const before: Piece[] = [
      { width: 390, part: 1, data: "A" },
      { width: 390, part: 2, data: "B" },
      { width: 1440, part: 1, data: "C" },
    ]
    const now: Piece[] = [
      { width: 390, part: 1, data: "A" },
      { width: 390, part: 2, data: "B2" },
      { width: 1440, part: 1, data: "C" },
      { width: 1440, part: 2, data: "D" },
    ]
    expect(changedPieces(now, before).map((p) => [p.width, p.part])).toEqual([
      [390, 2],
      [1440, 2],
    ])
    expect(changedPieces(now, now)).toEqual([])
  })

  it("make no call, and no verdict, when the picture is the same", async () => {
    const complete = vi.fn(replying('{"fixes":[]}'))
    const out = await critique({
      ...base,
      images: [],
      skip: "no screenshot changed since the first look",
      complete,
    })
    expect(out).toMatchObject({
      ran: false,
      errors: ["no screenshot changed since the first look"],
    })
    expect(complete).not.toHaveBeenCalled()
  })
})

describe("settle", () => {
  it("marks a fix fixed unless the second look raises the same page and section", () => {
    const earlier = [fix("Hero"), fix("Faq"), fix("Steps", "about")]
    const now = [fix("hero section"), fix("Footer")]
    const settled = settle(earlier, now)
    expect(settled.fixes.map((f) => [f.section, f.fixed])).toEqual([
      ["Hero", false],
      ["Faq", true],
      ["Steps", true],
    ])
    expect(settled.new).toEqual([fix("Footer")])
  })

  it("does not match a section on another page", () => {
    expect(settle([fix("Hero", "about")], [fix("Hero")]).fixes[0]?.fixed).toBe(
      true
    )
  })
})

describe("what the lead can act on", () => {
  it("tells the critic what the builder can change and to mark the rest", () => {
    const { system } = criticPrompt({ blueprint: {} })
    expect(system).toContain("The builder can change only these")
    expect(system).toContain('needs "component"')
    expect(system).toContain("never reaches the builder")
  })

  // Perf run 2: four of five fixes were in read-only components.
  it("sends the lead copy and layout fixes and logs the component ones aside", () => {
    const fixes = readFixes(
      JSON.stringify({
        fixes: [
          { ...fix("trust_strip"), needs: "component", target: "" },
          {
            ...fix("faq"),
            needs: "copy",
            target: "faqHeading",
            how: "shorter",
          },
          { ...fix("cta_band"), needs: "layout", target: "cta_band:photo" },
          { ...fix("hero"), needs: "sideways", target: "homeIntro" },
        ],
      })
    )
    expect(fixes.map((f) => f.needs)).toEqual([
      "component",
      "copy",
      "layout",
      undefined,
    ])
    const payload = payloadOf({ fixes, ran: true }, 1)
    expect(payload.fixes?.map((f) => f.section)).toEqual([
      "faq",
      "cta_band",
      "hero",
    ])
    expect(payload.starter?.map((f) => f.section)).toEqual(["trust_strip"])
    expect(payload).not.toHaveProperty("dropped")
  })
})

// Perf run 3: the critic still sent 2 of 5 fixes the lead could not make, and
// the lead said so in its report. These are that look's five, as the new
// schema words them.
const RUN3: Fix[] = [
  {
    page: "home",
    section: "trust_strip",
    problem:
      "The strip shows four items, including 'Covering 4 local areas' and 'Request a quote online', though the Blueprint asked for only the two facts.",
    change:
      "Empty the label fields of the 'Covering 4 local areas' and 'Request a quote online' items so only the two proof facts show.",
    needs: "copy",
    target: "trust4",
    how: "empty",
  },
  {
    page: "home",
    section: "value_props",
    problem:
      "The 'Why us' list puts a small icon circle beside each numbered item, so the numbers 01-03 are tiny and pale.",
    change:
      "Switch the value_props section to a variant without icons that leads with the numerals.",
    needs: "layout",
    target: "value_props:numerals",
    how: "other",
  },
  {
    page: "home",
    section: "service_area",
    problem: "The white card reads 'Bristol and nearby neighbourhoods'.",
    change:
      "Rewrite the card's heading to name the four areas plainly instead of 'nearby neighbourhoods'.",
    needs: "copy",
    target: "areaCardLine",
    how: "other",
  },
  {
    page: "home",
    section: "hero",
    problem: "The hero lede lists the areas and jobs at length.",
    change: "Shorten the hero lede to two short sentences.",
    needs: "copy",
    target: "homeIntro",
    how: "shorter",
  },
  {
    page: "home",
    section: "cta_band",
    problem: "The closing band's body line is small and the buttons far right.",
    change: "Lengthen the CTA band body line.",
    needs: "copy",
    target: "ctaBody",
    how: "longer",
  },
]
const [TRUST, VALUE] = RUN3 as [Fix, Fix]

describe("a fix that maps to nothing the builder can edit", () => {
  it("tells the critic the variants, the limits and the field keys, from the starter", () => {
    const { system } = criticPrompt({ blueprint: {} })
    expect(system).toContain("- trust_strip (variants: icons, phrases)")
    expect(system).toContain("trust1 to trust3")
    expect(system).toContain("- value_props (variants: default)")
    expect(system).toContain("valuePropNTitle")
    expect(system).toContain("`kind:variant`")
    expect(system).toContain("A component fix has an empty target.")
  })

  it("drops the trust strip's extra items: no field holds them", () => {
    expect(whyNot(TRUST)).toBe("there is no field trust4")
    // Written without a target, the same fix names nothing at all.
    expect(whyNot({ ...TRUST, target: "" })).toBe(
      "it names no field or variant"
    )
    // And the strip's real fields are makeable.
    expect(whyNot({ ...TRUST, target: "trust3", how: "shorter" })).toBe(null)
  })

  it("drops a variant the section does not have: value props has only its default", () => {
    expect(whyNot(VALUE)).toBe("value_props has no variant numerals")
    expect(whyNot({ ...VALUE, target: "faq:stacked" })).toBe(null)
    expect(whyNot({ ...VALUE, target: "faq:grid" })).toBe(
      "faq has no variant grid"
    )
    expect(whyNot({ ...VALUE, target: "order:faq" })).toBe(null)
    expect(whyNot({ ...VALUE, target: "order:ticker" })).toBe(
      "there is no section ticker"
    )
    expect(whyNot({ ...VALUE, target: "palette" })).toBe(null)
    // An emptied icon field is picked again from its words, so no icon goes.
    expect(
      whyNot({
        ...VALUE,
        needs: "copy",
        target: "valueProp1Icon",
        how: "empty",
      })
    ).toContain("icon stays")
  })

  it("sends the lead three of run 3's five and logs the two aside with why", () => {
    const payload = payloadOf({ fixes: RUN3, ran: true }, 1)
    expect(payload.fixes?.map((f) => f.section)).toEqual([
      "service_area",
      "hero",
      "cta_band",
    ])
    expect(payload.dropped?.map((f) => [f.section, f.why])).toEqual([
      ["trust_strip", "there is no field trust4"],
      ["value_props", "value_props has no variant numerals"],
    ])
    expect(unmakeable(RUN3)).toHaveLength(2)
    // A component fix is the platform's, not a dropped one.
    expect(unmakeable([{ ...TRUST, needs: "component", target: "" }])).toEqual(
      []
    )
  })
})

describe("the site's config as text", () => {
  const source = readFileSync(
    new URL(
      "../../../packages/starter-site/src/site-config.ts",
      import.meta.url
    ),
    "utf8"
  )

  it("reads every field value and every section of the starter's own file", () => {
    const config = readConfig(source)
    expect(config.values).toEqual(site)
    for (const [page, sections] of Object.entries(layout))
      expect(config.layout[page]).toEqual(sections)
  })

  it("reads a lead's edits: single quotes, a multi-line string, a variant", () => {
    const edited = source
      .replace(/^ {2}homeIntro: .*$/m, "  homeIntro: 'It\\'s plain.',")
      .replace(/^ {2}ctaBody: .*$/m, '  ctaBody:\n    "Two lines of words",')
      .replace(
        '{ kind: "faq" },\n    { kind: "cta_band" },\n  ],\n  service:',
        '{ kind: "faq", variant: "stacked" },\n    { kind: "cta_band" },\n  ],\n  service:'
      )
    const config = readConfig(edited)
    expect(config.values.homeIntro).toBe("It's plain.")
    expect(config.values.ctaBody).toBe("Two lines of words")
    const pages: Record<string, Config["layout"][string] | undefined> =
      config.layout
    expect(pages.services?.find((s) => s.kind === "faq")?.variant).toBe(
      "stacked"
    )
  })
})

// Perf run 3: the recheck (Haiku, shown screens it did see changed) said 0 of 5
// fixed though the lead had shortened the hero lede, rewritten the coverage
// card and lengthened the CTA body, and declined the other two. Code compares
// the fields the fixes named, before and after the lead's round.
describe("the second look's verdicts from the config", () => {
  const before: Config = {
    values: {
      homeIntro:
        "Harbourside Property Care looks after homes and rental properties in Bristol, Clifton, Redland and Bishopston. Homeowners and landlords hand over the gutters, the paintwork and the small jobs that pile up, and get a well kept property back.",
      areaCardLine: "Bristol and nearby neighbourhoods",
      ctaBody: "Tell us about the job.",
      trust3: "Fully insured",
    },
    layout: { home: [{ kind: "hero" }, { kind: "faq" }, { kind: "cta_band" }] },
  }
  const after: Config = {
    values: {
      homeIntro:
        "Harbourside Property Care looks after homes and rental properties across Bristol. Homeowners and landlords hand over the gutters, the paintwork and the small jobs that pile up.",
      areaCardLine: "Bristol, Clifton, Redland and Bishopston",
      ctaBody:
        "Tell us about the job and we will work out your quote, with no obligation.",
      trust3: "Fully insured",
    },
    layout: { home: [{ kind: "hero" }, { kind: "faq" }, { kind: "cta_band" }] },
  }
  // Three the lead makes, and two it declines, as in run 3 (here worded as
  // fixes the builder could have made).
  const asked = withBefore(
    [
      ...RUN3.slice(2),
      { ...TRUST, target: "trust3", how: "empty" as const },
      { ...VALUE, target: "faq:stacked" },
    ],
    before
  ) as [Fix, Fix, Fix, Fix, Fix]

  it("notes what each target held when the fix was asked", () => {
    expect(asked.map((f) => f.before)).toEqual([
      before.values.areaCardLine,
      before.values.homeIntro,
      before.values.ctaBody,
      "Fully insured",
      "",
    ])
    // A target the file does not show has nothing to note.
    expect(withBefore([TRUST], before)[0]).not.toHaveProperty("before")
  })

  it("marks the three the lead made fixed and the two it declined not", () => {
    const held = asked.map((f) => verdictOf(f, after))
    expect(held).toEqual([true, true, true, false, false])
    const settled = payloadOf({ fixes: [], ran: true, held }, 2, asked)
    expect(settled.fixes?.map((f) => f.fixed)).toEqual(held)
    expect(settled.new).toEqual([])
  })

  it("holds a variant fix fixed once the section has the variant", () => {
    const stacked: Config = {
      ...after,
      layout: {
        home: [
          { kind: "hero" },
          { kind: "faq", variant: "stacked" },
          { kind: "cta_band" },
        ],
      },
    }
    expect(verdictOf(asked[4], stacked)).toBe(true)
    const reordered = {
      ...asked[4],
      target: "order:faq",
      before: "hero,faq,cta_band",
    }
    expect(verdictOf(reordered, after)).toBe(false)
    expect(
      verdictOf(reordered, {
        ...after,
        layout: { home: [{ kind: "faq" }, { kind: "hero" }] },
      })
    ).toBe(true)
  })

  it("has no verdict from code where it cannot tell, and the model's stands", () => {
    const [card, lede] = asked
    // No snapshot from before, no config now, a target the file does not
    // show, the palette: a picture is what shows those.
    expect(verdictOf({ ...card, before: undefined }, after)).toBe(null)
    expect(verdictOf(card, null)).toBe(null)
    expect(verdictOf({ ...card, before: "x", target: "trust4" }, after)).toBe(
      null
    )
    expect(verdictOf({ ...card, before: "x", target: "palette" }, after)).toBe(
      null
    )
    // 'shorter' needs fewer words, not just different ones.
    expect(
      verdictOf(
        { ...lede, before: "one two" },
        { ...after, values: { homeIntro: "one two three" } }
      )
    ).toBe(false)
    // Where code has no verdict, the second look's own is used.
    expect(
      settle([fix("Hero"), fix("Faq")], [], true, [null, true]).fixes.map(
        (f) => f.fixed
      )
    ).toEqual([true, true])
    // And a verdict from code stands even when the look did not run.
    expect(
      settle([fix("Hero"), fix("Faq")], [], false, [true, null]).fixes.map(
        (f) => f.fixed
      )
    ).toEqual([true, null])
  })
})

describe("the recheck's verdicts", () => {
  const earlier = ["trust_strip", "faq", "service_area", "service_cards"].map(
    (s) => fix(s)
  )

  it("asks for a verdict on each earlier fix by number, on its own schema", async () => {
    const complete = vi.fn(
      replying(
        JSON.stringify({
          checks: [
            { fix: 1, fixed: false },
            { fix: 2, fixed: true },
            { fix: 9, fixed: true },
            { fix: 3, fixed: "yes" },
          ],
          fixes: [],
        })
      )
    )
    const out = await critique({ ...base, earlier, complete })
    expect(out.held).toEqual([false, true, null, null])
    const call = complete.mock.calls[0]?.[0]
    expect(call?.schema.name).toBe("design_recheck")
    expect(call?.user).toContain('"fix":1')
    expect(call?.user).not.toContain("list it again")
  })

  // Perf run 2: the recheck listed all five again and every one read as not
  // fixed, though the lead had made four of the changes.
  it("takes the verdict over a fix the reply also listed again", () => {
    const held = [false, true, true, true]
    const settled = payloadOf({ fixes: earlier, ran: true, held }, 2, earlier)
    expect(settled.fixes?.map((f) => f.fixed)).toEqual(held)
    expect(settled.new).toEqual([])
    // With no verdict for a fix, the old reading stands.
    expect(
      settle(earlier, [fix("faq")], true, [true]).fixes.map((f) => f.fixed)
    ).toEqual([true, false, true, true])
  })
})

describe("a look that did not run", () => {
  const earlier = [fix("Hero"), fix("Faq")]

  it("is recorded as not run, never as a site that holds", () => {
    const failed = { fixes: [], ran: false }
    expect(payloadOf(failed, 1)).toEqual({ ran: false, fixes: null })
    expect(payloadOf({ fixes: [], ran: true }, 1)).toEqual({
      ran: true,
      fixes: [],
    })
  })

  it("leaves the earlier fixes unknown on the second look, not fixed", () => {
    const second = payloadOf({ fixes: [], ran: false }, 2, earlier)
    expect(second.ran).toBe(false)
    expect(second.fixes?.map((f) => f.fixed)).toEqual([null, null])
    // The same empty answer from a look that did run is what "fixed" means.
    const held = payloadOf({ fixes: [], ran: true }, 2, earlier)
    expect(held.fixes?.map((f) => f.fixed)).toEqual([true, true])
  })

  it("settle takes a look that did not run as no verdict", () => {
    expect(settle(earlier, [], false).fixes.map((f) => f.fixed)).toEqual([
      null,
      null,
    ])
  })
})
