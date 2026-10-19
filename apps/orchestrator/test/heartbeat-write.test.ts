import { describe, expect, it } from "vitest"
import {
  LIMITS,
  overLimit,
  readReply,
  writerPrompt,
} from "../src/heartbeat-write.ts"

describe("reading the writer's reply", () => {
  // Ported from hermes tests/gateway/test_response_filters.py:8-19 (MIT).
  it.each([
    ["[quiet]", ""],
    ["[quiet] nothing new", "nothing new"],
    ["[QUIET]: only the times moved", "only the times moved"],
    ["2 items checked\n\n[quiet]", "2 items checked"],
    [
      "[quiet]\nThe review was already mentioned.",
      "The review was already mentioned.",
    ],
    ["quiet", ""],
    ["Quiet.", ""],
    ["quiet: nothing the owner needs", "nothing the owner needs"],
  ])("%j is quiet", (raw, reason) => {
    expect(readReply(raw)).toEqual({ kind: "quiet", reason })
  })

  it.each([
    "Your site went live, and I won't keep [quiet] about it.",
    "Quiet week on search, but Jane's review is now on your site.",
    "The approval for your prices has waited since Monday. Shall I keep it open?",
  ])("%j is a message", (raw) => {
    expect(readReply(raw)).toEqual({ kind: "message", text: raw })
  })

  it("treats an empty reply as an error, not silence", () => {
    expect(readReply("")).toEqual({ kind: "error", detail: "empty" })
    expect(readReply("  \n ")).toEqual({ kind: "error", detail: "empty" })
  })

  it("keeps a long reason short enough for the run's detail", () => {
    const reply = readReply(`[quiet] ${"x".repeat(600)}`)
    expect(reply.kind === "quiet" && reply.reason.length).toBe(200)
  })
})

describe("the message's limits", () => {
  it("passes a short message with one question and a decimal", () => {
    expect(
      overLimit(
        "Your 4.5 star review from Jane is on the site now. Want me to pin it to the top?"
      )
    ).toBeNull()
  })

  it("refuses a fourth sentence, a second question or a 451st character", () => {
    expect(overLimit("One. Two. Three. Four.")).toBe("sentences")
    expect(overLimit("Is it done? Shall I move it?")).toBe("questions")
    expect(overLimit("a".repeat(LIMITS.chars + 1))).toBe("chars")
    expect(overLimit("a".repeat(LIMITS.chars))).toBeNull()
  })
})

describe("the writer's instructions", () => {
  it("change the bar with the dial and always allow quiet", () => {
    const low = writerPrompt("low")
    const high = writerPrompt("high")
    expect(low).toMatch(/finished/)
    expect(high).toMatch(/on track/)
    expect(low).not.toEqual(high)
    for (const prompt of [low, writerPrompt("default"), high])
      expect(prompt).toMatch(/\[quiet\]/)
  })
})
