import type { UIMessageChunk } from "ai"
import { afterEach, describe, expect, it } from "vitest"
import { clock, pace, readingBeat, wordsOf } from "../src/pacing.ts"

const text = "Lovely, a cleaning business in Leeds. Let me set a few things up."
const chunks: UIMessageChunk[] = [
  { type: "start-step" },
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: text },
  { type: "text-end", id: "text" },
  { type: "tool-input-available", toolCallId: "c", toolName: "ask", input: {} },
  { type: "finish-step" },
]

const real = clock.sleep
afterEach(() => {
  clock.sleep = real
})

async function run(spent = 0, said = false) {
  const waits: number[] = []
  clock.sleep = (ms) => {
    waits.push(ms)
    return Promise.resolve()
  }
  const out: UIMessageChunk[] = []
  await pace(
    chunks,
    (c) => out.push(c),
    { typed: 40, since: Date.now() - spent },
    said
  )
  return { out, waits }
}

const total = (waits: number[]) => waits.reduce((a, b) => a + b, 0)

describe("pace", () => {
  it("joins the words back to the exact text, with the card after it", async () => {
    const { out } = await run()
    const types = out.map((c) => c.type)
    const deltas = out.flatMap((c) =>
      c.type === "text-delta" ? [c.delta] : []
    )
    expect(deltas.length).toBeGreaterThan(3)
    expect(deltas.join("")).toBe(text)
    expect(types.indexOf("tool-input-available")).toBeGreaterThan(
      types.lastIndexOf("text-delta")
    )
    expect(out.filter((c) => c.type !== "text-delta")).toEqual(
      chunks.filter((c) => c.type !== "text-delta")
    )
  })

  it("keeps whitespace in any shape", () => {
    for (const s of ["", " ", "  a  b\n\nc d e ", "one"]) {
      expect(wordsOf(s).join("")).toBe(s)
    }
  })

  it("waits a reading beat, then the words, then a card beat", async () => {
    const [beat, ...rest] = (await run()).waits
    expect(beat).toBeGreaterThanOrEqual(600)
    expect(beat).toBeLessThanOrEqual(1200)
    const card = rest.at(-1) as number
    expect(card).toBeGreaterThanOrEqual(300)
    expect(card).toBeLessThanOrEqual(500)
  })

  it("takes the time the turn already spent off the reading beat", async () => {
    expect((await run(5000)).waits[0]).toBe(0)
    expect(readingBeat(40, 400)).toBeCloseTo(readingBeat(40, 0) - 400)
  })

  it("adds at most 2.5 s of typing, however long the message", async () => {
    const waits: number[] = []
    clock.sleep = (ms) => {
      waits.push(ms)
      return Promise.resolve()
    }
    await pace(
      [{ type: "text-delta", id: "text", delta: "word ".repeat(2000) }],
      () => undefined,
      { typed: 0, since: 0 },
      true
    )
    expect(total(waits)).toBeLessThanOrEqual(2500)
  })

  it("skips the reading beat when words already streamed", async () => {
    const { waits } = await run(0, true)
    expect(Math.max(...waits.slice(0, -1))).toBeLessThan(100)
    expect(waits.at(-1)).toBeGreaterThanOrEqual(300)
  })
})
