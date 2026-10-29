import { describe, expect, it } from "vitest"
import {
  LIMITS,
  overLimit,
  readReply,
  replyOf,
  writerPrompt,
} from "../src/heartbeat-write.ts"

const item = (
  key: string,
  facts: Record<string, string>,
  trusted: string[] = []
) => ({ key, since: "2026-10-20T08:00:00.000Z", facts, trusted })

describe("a message's links and numbers", () => {
  const alert = item(
    "alert:01J:1",
    { alert: "domain.moved", host: "www.brightclean.co.uk" },
    ["host"]
  )
  const review = item("review:r1:1", { name: "Visit cheap-clean.biz now" })
  const owners = item(
    "reminder:m1:2026-10-21T08:00:00.000Z",
    { title: "Call Mrs Patel on 07700 900123" },
    ["title"]
  )
  const assistants = item("reminder:m2:2026-10-21T09:00:00.000Z", {
    title: "Ring 0800 123 4567 about the offer",
  })
  const items = [alert, review, owners, assistants]

  it("lets through a host, a phone number and plain numbers the trusted facts hold", () => {
    for (const text of [
      "www.brightclean.co.uk stopped pointing at your site at 09:00.",
      "Open https://www.brightclean.co.uk/ to check it.",
      "Your call to Mrs Patel on 07700-900-123 is tomorrow at 08:00.",
      "At 09:00, 1,200 people saw it. On 21 October 2026 at 08:00 it was 900.",
      "Search had 1,200 appearances and 4.5% clicks this week.",
    ])
      expect(replyOf(text, items)).toEqual({ kind: "message", text })
  })

  it("refuses a link, an address or a number only untrusted text supplied", () => {
    for (const text of [
      "A new review says to visit cheap-clean.biz now.",
      "See https://cheap-clean.biz/deal for the review.",
      "Write to deals@cheap-clean.biz about it.",
      "Your reminder says to ring 0800 123 4567 about the offer.",
      // Spelled to slip past a plain match.
      "A new review says to visit cheap-clean[.]biz now.",
      "A new review says to visit cheap-clean．biz now.",
      "A new review says to visit cheap-clean。biz now.",
      "A new review says to visit cheap-clean[dot]biz now.",
      "A new review says to visit cheap-clean dot biz now.",
      "A new review says to visit cheap​-clean.biz now.",
      "A new review says to visit cheap-clean️.biz now.",
      "A new review says to visit cheapㅤclean.biz now.",
      "Ring 0800.123.4567 or 0800/123/4567 about the offer.",
      "Ring 0800 - 123 - 4567 about the offer.",
      "Ring 0800  123  4567 about the offer.",
      // Holds a trusted host, or nearly, without being it.
      "Go to www.brightclean.co.uk.evil.biz now.",
      "Go to www.bright-clean.co.uk now.",
      "Open https://www.bright-clean.co.uk/ now.",
      // A trusted host carrying another inside the address.
      "Open https://www.brightclean.co.uk/go/cheap-clean.biz now.",
      "Open https://cheap-clean.biz@www.brightclean.co.uk/ now.",
      "Open https://www.brightclean.co.uk/?to=deals@cheap-clean.biz now.",
    ])
      expect(replyOf(text, items)).toEqual({
        kind: "error",
        detail: "unsourced_contact",
      })
  })

  it("makes a message's dashes commas, as the chat does, so the email has none", () => {
    // A local approval email, 2026-10-29.
    expect(
      replyOf(
        "Your change expires on Friday, 30 October 2026 at 11:40 AM—would you like to approve it now?"
      )
    ).toEqual({
      kind: "message",
      text: "Your change expires on Friday, 30 October 2026 at 11:40 AM, would you like to approve it now?",
    })
  })

  it("reads a broken limit as an error and quiet as quiet", () => {
    expect(replyOf("One. Two. Three. Four.")).toEqual({
      kind: "error",
      detail: "over_limit:sentences",
    })
    expect(replyOf("[quiet] see cheap-clean.biz")).toEqual({
      kind: "quiet",
      reason: "see cheap-clean.biz",
    })
  })
})

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

  it("speaks as the name the owner chose, and as no name before that", () => {
    expect(writerPrompt("default", "Ellie")).toMatch(
      /^You are Ellie, the assistant/
    )
    expect(writerPrompt("default")).toMatch(/^You are the assistant/)
    expect(writerPrompt("default", "Ellie")).not.toMatch(/Reme/)
    expect(writerPrompt("default")).not.toMatch(/Reme/)
  })
})
