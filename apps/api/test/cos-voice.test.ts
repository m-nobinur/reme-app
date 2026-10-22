import type { TextStreamPart, ToolSet } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { INSTRUCTIONS } from "../src/cos/agent.ts"
import { dashesToCommas, voiced } from "../src/cos/voice.ts"
import { VOICE } from "../src/voice.ts"

type Part = TextStreamPart<ToolSet>

/** Runs text through the transform in `deltas`, and returns what the owner reads. */
async function read(deltas: string[]) {
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
  return seen.flatMap((p) => (p.type === "text-delta" ? [p.text] : [])).join("")
}

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
