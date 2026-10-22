import { COS_TOOLS } from "@workspace/contracts"
import {
  isStepCount,
  type TextStreamPart,
  ToolLoopAgent,
  type ToolSet,
  tool,
} from "ai"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanedChange, INSTRUCTIONS, withoutStep } from "../src/cos/agent.ts"
import { cleanStep, dashesToCommas, voiced } from "../src/cos/voice.ts"
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

describe("request_change's step", () => {
  it("cleans a step to what the panel may show", () => {
    expect(cleanStep("  Adding   the new photos\n to the home page ")).toBe(
      "Adding the new photos to the home page"
    )
    expect(cleanStep("Updating the page — now")).toBe("Updating the page, now")
    expect(cleanStep("x".repeat(90))).toHaveLength(60)
    expect(cleanStep("Changing 3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0d")).toBe(
      undefined
    )
    expect(cleanStep("Opening build ead99cb0")).toBeUndefined()
    expect(cleanStep("   ")).toBeUndefined()
    expect(cleanStep(undefined)).toBeUndefined()
  })

  it("is cleaned on the logged call and stripped before the body runs", async () => {
    const seen: unknown[] = []
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "request_change",
            input: JSON.stringify({
              text: "Add photos",
              step: " Adding   the photos — now ",
            }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ] as never) as never,
      }),
    })
    const agent = new ToolLoopAgent({
      model,
      tools: {
        request_change: tool({
          inputSchema: COS_TOOLS.request_change.input,
          execute: async (input) => {
            seen.push(withoutStep(input))
            return "ok"
          },
        }),
      },
      stopWhen: isStepCount(1),
      experimental_refineToolInput: { request_change: cleanedChange },
    })
    const result = await agent.stream({ prompt: "go" })
    await result.consumeStream()
    expect((await result.steps)[0]?.toolCalls[0]?.input).toEqual({
      text: "Add photos",
      step: "Adding the photos, now",
    })
    expect(seen).toEqual([{ text: "Add photos" }])
  })
})
