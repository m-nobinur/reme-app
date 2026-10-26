import { describe, expect, it } from "vitest"
import { VOICE, voiceProblems } from "../src/voice.ts"

const hits = (text: string, assistantNamed = false) => {
  const { hard, soft } = voiceProblems(text, { assistantNamed })
  return hard.length + soft.length
}

describe("voiceProblems", () => {
  // Before (seen or likely) and after, from the plan's VO3 table.
  const BEFORE = [
    "Ellie, reporting for duty! Let's make our partnership official.",
    "Offering eco-friendly products will certainly give clients peace of mind!",
    "Build ead99cb0 is ready for your review.",
    "Your site is live — spark.mnobinur.dev",
    "It's an honour to officially be on the team.",
    "Great question! I'd be happy to help.",
    "All done. Let me know if you need anything else.",
    "As your assistant, I can do that.",
    "Thank you for picking me to be the business assistant.",
    "Good to be officially on the team.",
  ]
  const AFTER = [
    "I'm Ellie. Now a few questions about the website.",
    "Eco-friendly products, noted.",
    "Your changes are ready. Have a look in the panel.",
    "Your website is live at spark.mnobinur.dev.",
    "Here's the one change to make at Cloudflare. I'll watch for it.",
    "Your purchase is ready to pay for.",
  ]

  it("flags every line of the before column", () => {
    for (const line of BEFORE) expect(hits(line), line).toBeGreaterThan(0)
  })

  it("passes every line of the after column", () => {
    for (const line of AFTER) expect(hits(line), line).toBe(0)
  })

  it("treats dashes and internals as hard, ceremony and praise as soft", () => {
    expect(voiceProblems("One thing – then another.").hard).toHaveLength(1)
    expect(voiceProblems("Build ead99cb0 is ready.").hard).toHaveLength(1)
    expect(
      voiceProblems("Run 0f8f8431-aaaa-4bbb-8ccc-123456789abc").hard
    ).toHaveLength(2)
    expect(voiceProblems("It uses site_config.").hard).toHaveLength(1)
    expect(voiceProblems("Ask STF-204 about it.").hard).toHaveLength(1)
    const praise = voiceProblems("That is wonderful.")
    expect(praise.hard).toEqual([])
    expect(praise.soft).toHaveLength(1)
  })

  it("leaves a phone number, a plain word and a host alone", () => {
    for (const ok of [
      "Call +447700900412 or 07700 900 412.",
      "The room was defaced overnight.",
      "Your website is live at spark.mnobinur.dev.",
      "The site works on a phone, of course.",
    ]) {
      expect(hits(ok), ok).toBe(0)
    }
  })

  it("flags Reme only once the owner has named the assistant", () => {
    expect(hits("Reme will build it.")).toBe(0)
    expect(hits("Reme will build it.", true)).toBe(1)
  })

  it("is the same for the start of a message as for the whole", () => {
    const whole = "Noted, weddings it is. Absolutely, I'd be happy to help."
    expect(hits("Noted, weddings it is.")).toBe(0)
    expect(hits(whole)).toBeGreaterThan(0)
  })

  it("gives both models the same rules", () => {
    expect(VOICE).toContain("past tense")
    expect(VOICE).not.toMatch(/[—–]/)
  })
})
