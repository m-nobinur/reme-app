import type { TextStreamPart, ToolSet } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { INSTRUCTIONS } from "../src/cos/agent.ts"
import { withoutRestated } from "../src/cos/run.ts"
import { voiced } from "../src/cos/voice.ts"
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

  it("passes every delta through as the model wrote it", async () => {
    const deltas = ["Open Mon–Fri", ", 9am–5pm", " — ", "have a look."]
    expect(await readDeltas(deltas)).toEqual(deltas)
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
