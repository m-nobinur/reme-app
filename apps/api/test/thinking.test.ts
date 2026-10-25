import { describe, expect, it } from "vitest"
import { thoughtHeadings, thoughtLine } from "../src/thinking.ts"

describe("a thought's heading as the waiting line", () => {
  it("reads each measured heading in sentence case and British spelling", () => {
    expect(thoughtLine("Considering maintenance options")).toBe(
      "Considering maintenance options"
    )
    expect(thoughtLine("Evaluating Service Models")).toBe(
      "Evaluating service models"
    )
    expect(thoughtLine("Prioritizing Recurring Revenue")).toBe(
      "Prioritising recurring revenue"
    )
    expect(thoughtLine("Organization Of The Saturday Rota:")).toBe(
      "Organisation of the Saturday rota"
    )
    expect(thoughtLine("Checking SEO And Prize Size")).toBe(
      "Checking SEO and prize size"
    )
  })

  it("drops a heading that says anything internal or runs long", () => {
    for (const heading of [
      "Calling request_change",
      "Reading `facts`",
      "Checking the requestChange call",
      "Choosing the right tool",
      "Following the system prompt",
      "Clarifying the user's request",
      "Parsing the JSON",
      "Opening https://example.com",
      "Matching id 4f2a9c81",
      "Handing over to the Developer",
      "Planning: next steps — then the build",
      "Weighing every single option for the cleaning business at length",
      "",
    ]) {
      expect(thoughtLine(heading), heading).toBeNull()
    }
  })
})

describe("the headings of a reasoning stream", () => {
  it("sends each new heading once, across split deltas, never the reasoning", () => {
    let now = 0
    const sent: string[] = []
    const read = thoughtHeadings(
      (line) => sent.push(line),
      () => now
    )
    read("**Evaluating Ser")
    read("vice Models**\n\nThe owner offers regular and one-off cleans.")
    expect(sent).toEqual(["Evaluating service models"])
    // Closer than a second: held until the next delta after it.
    now = 400
    read(" More.\n\n**Prioritizing Recurring Revenue**\n\nRegular cleans ")
    expect(sent).toHaveLength(1)
    now = 1_200
    read("pay the bills.")
    expect(sent).toEqual([
      "Evaluating service models",
      "Prioritising recurring revenue",
    ])
    // An internal heading keeps the line it had.
    now = 3_000
    read("\n\n**Calling request_change**\n\nNow.")
    expect(sent).toHaveLength(2)
    expect(sent.join(" ")).not.toContain("bills")
  })

  it("opens on a summary's heading and ignores bold inside a sentence", () => {
    const sent: string[] = []
    const read = thoughtHeadings((line) => sent.push(line))
    read("**Considering maintenance options**\n\nI think the ")
    read("**key** part is weekly.")
    expect(sent).toEqual(["Considering maintenance options"])
  })
})
