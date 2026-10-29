import type { TextStreamPart, ToolSet } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { INSTRUCTIONS } from "../src/cos/agent.ts"
import { withoutRestated } from "../src/cos/run.ts"
import { dashesToCommas, voiced } from "../src/cos/voice.ts"
import { VOICE } from "../src/voice.ts"

type Part = TextStreamPart<ToolSet>

/** Runs text through the transform in `deltas`, and returns what the owner reads. */
async function readDeltas(deltas: string[]) {
  const parts: Part[] = [
    { type: "text-start", id: "t" },
    ...deltas.map((text) => ({ type: "text-delta", id: "t", text }) as Part),
    { type: "text-end", id: "t" },
  ]
  const out = new ReadableStream<Part>({
    start(c) {
      for (const p of parts) c.enqueue(p)
      c.close()
    },
  }).pipeThrough(voiced("turn-1")())
  const seen: Part[] = []
  for await (const p of out) seen.push(p)
  return seen.flatMap((p) => (p.type === "text-delta" ? [p.text] : []))
}

const read = async (deltas: string[]) => (await readDeltas(deltas)).join("")

describe("voiced", () => {
  afterEach(() => vi.restoreAllMocks())

  it("swaps a dash for a comma however the deltas are cut", async () => {
    const text = "Done — your page is up. It took 9–5 minutes — nearly."
    for (const cut of [1, 3, 7, text.length]) {
      const deltas = text.match(new RegExp(`.{1,${cut}}`, "gs")) ?? []
      expect(await read(deltas)).toBe(
        "Done, your page is up. It took 9 to 5 minutes, nearly."
      )
    }
  })

  it("reads a range with a currency sign or unit on either side as to", async () => {
    expect(dashesToCommas("£80–£150")).toBe("£80 to £150")
    expect(dashesToCommas("£80 – £150 a job")).toBe("£80 to £150 a job")
    expect(dashesToCommas("10%–20%")).toBe("10% to 20%")
    expect(dashesToCommas("9am–5pm")).toBe("9am to 5pm")
    expect(dashesToCommas("£5k—£10k")).toBe("£5k to £10k")
    expect(dashesToCommas("$40–60")).toBe("$40 to 60")
    expect(dashesToCommas("Mon–Fri")).toBe("Mon, Fri")
    const text = "I'd use £80–£150, excluding parts — a rough guide."
    for (const cut of [1, 2, 3, 5, text.length]) {
      const deltas = text.match(new RegExp(`.{1,${cut}}`, "gs")) ?? []
      expect(await read(deltas)).toBe(
        "I'd use £80 to £150, excluding parts, a rough guide."
      )
    }
  })

  it("passes text through at once, holding back only a trailing space or dash", async () => {
    expect(await readDeltas(["Your website", " is live", ". Have"])).toEqual([
      "Your website",
      " is live",
      ". Have",
    ])
    expect(await readDeltas(["Done ", "— ", "now"])).toEqual(["Done", ", now"])
  })

  it("keeps a reply without dashes as it was", async () => {
    expect(await read(["Your website is live. ", "Have a look."])).toBe(
      "Your website is live. Have a look."
    )
    expect(dashesToCommas("a-b")).toBe("a-b")
  })

  it("logs a soft hit by kind with the turn id, and never the words", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await read(["Certainly, that is wonderful. Feel free to ask."])
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]))
    expect(line).toMatchObject({
      code: "cos.voice",
      turn_id: "turn-1",
      hard: 0,
    })
    expect(line.soft).toEqual([
      "Leave out ceremony or praise",
      "Leave out a sign-off",
    ])
    expect(JSON.stringify(line)).not.toContain("wonderful")
  })

  it("says nothing for a clean reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await read(["Your website is live."])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("the instructions", () => {
  it("carry the voice and no plan review", () => {
    expect(INSTRUCTIONS).toContain(VOICE)
    expect(INSTRUCTIONS).not.toMatch(/blueprint/i)
  })
})

describe("a text said again after a tool", () => {
  const text = (t: string) => ({ type: "text", text: t })
  const tool = { type: "tool-check_domain" }

  it("keeps only the later text when it restates the one before the tool", () => {
    const before = text(
      "The only thing left is adding the domain records at your provider."
    )
    const after = text(
      "The domain records still aren't showing, so adding those is the only step left."
    )
    expect(withoutRestated([before, tool, after])).toEqual([tool, after])
  })

  it("keeps a text the later one does not repeat, a short one, and one with no tool after it", () => {
    const card = text(
      "I'd go with pebblewickbikefix.com: short and easy to say."
    )
    const reply = text("It's connected, and the certificate is on its way.")
    expect(withoutRestated([card, tool, reply])).toEqual([card, tool, reply])
    expect(
      withoutRestated([text("On it."), tool, text("On it.")])
    ).toHaveLength(3)
    expect(withoutRestated([reply, reply])).toHaveLength(2)
  })
})
