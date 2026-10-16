import { RULES, TELLS } from "@workspace/gates/rubric"
import { describe, expect, it, vi } from "vitest"
import {
  type Complete,
  changedPieces,
  criticPrompt,
  critique,
  FIXES_MAX,
  type Fix,
  type Piece,
  payloadOf,
  readFixes,
  settle,
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
