import { RULES, TELLS } from "@workspace/gates/rubric"
import { describe, expect, it, vi } from "vitest"
import {
  type Complete,
  criticPrompt,
  critique,
  FIXES_MAX,
  type Fix,
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
  images: ["QQ==", "Qg==", "Qw=="],
}
const replying =
  (text: string): Complete =>
  async () => ({ text, usage: { cost: 0.01 }, model: route.model })

describe("the critic's prompt", () => {
  it("reads the rubric's own rules and tells, and the Blueprint", () => {
    const { system, user } = criticPrompt({ blueprint: { direction: "x" } })
    for (const r of [...RULES, ...TELLS]) expect(system).toContain(r.id)
    expect(user).toContain('"direction":"x"')
    expect(user).toContain("390, 768, 1440")
    expect(user).not.toContain("on the build before this one")
  })

  it("names the earlier fixes on the second look", () => {
    const { user } = criticPrompt({ blueprint: {}, earlier: [fix("Hero")] })
    expect(user).toContain("on the build before this one")
    expect(user).toContain("Hero breaks a rule.")
  })
})

describe("critique", () => {
  it("sends the three screenshots as pictures and returns the fixes", async () => {
    const complete = vi.fn(
      replying(JSON.stringify({ fixes: [fix("Hero"), fix("Faq")] }))
    )
    const out = await critique({ ...base, complete })
    expect(out.fixes).toEqual([fix("Hero"), fix("Faq")])
    expect(out.errors).toEqual([])
    const call = complete.mock.calls[0]?.[0]
    expect(call?.images).toEqual([
      { data: "QQ==", mimeType: "image/png" },
      { data: "Qg==", mimeType: "image/png" },
      { data: "Qw==", mimeType: "image/png" },
    ])
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
    expect(out).toMatchObject({ fixes: [], errors: [] })
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
      errors: ["provider.unavailable"],
    })
    const prose = await critique({ ...base, complete: replying("Looks fine.") })
    expect(prose.fixes).toEqual([])
    expect(prose.errors[0]).toContain("no JSON object")
    // A reply that parsed but is not a fixes list is the same as no reply.
    const odd = await critique({ ...base, complete: replying('{"ok":true}') })
    expect(odd.errors[0]).toContain("no fixes list")
    const complete = vi.fn(replying('{"fixes":[]}'))
    const blind = await critique({ ...base, images: [], complete })
    expect(blind).toMatchObject({
      fixes: [],
      errors: ["no screenshots were taken"],
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it("keeps the model's usage for the meter, even when the reply is unusable", async () => {
    const out = await critique({ ...base, complete: replying("Looks fine.") })
    expect(out.calls).toEqual([{ usage: { cost: 0.01 }, model: route.model }])
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
