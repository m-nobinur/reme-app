import { streamText, tool } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { gated, MAX_RERUNS, NUDGE } from "../src/cos/promise.ts"

/**
 * The promise gate with a model stood in for by `MockLanguageModelV4`: a step
 * that ends on text alone is run again inside the same step when the reading
 * says it promised work, at most twice, and a tool call from the re-run goes
 * through the SDK as any other.
 */

type Part = Record<string, unknown> & { type: string }

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
})

const said = (text: string): Part[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: text },
  { type: "text-end", id: "0" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(100, 10),
  },
]

const called: Part[] = [
  { type: "stream-start", warnings: [] },
  {
    type: "tool-call",
    toolCallId: "c1",
    toolName: "set_up",
    input: "{}",
  },
  {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: usage(100, 10),
  },
]

/** A model that answers each call with the next step (the last one again when they run out). */
function scripted(...steps: Part[][]) {
  const prompts: unknown[] = []
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt)
      const step = steps[Math.min(prompts.length, steps.length) - 1] as Part[]
      return { stream: convertArrayToReadableStream(step) as never }
    },
  })
  return { model, prompts }
}

const run = (
  model: MockLanguageModelV4,
  promised: (said: string) => Promise<boolean>
) => {
  let ran = 0
  const result = streamText({
    model: gated(model, promised),
    prompt: "Set it up",
    tools: {
      set_up: tool({
        description: "Sets it up",
        inputSchema: z.object({}),
        execute: async () => {
          ran++
          return "done"
        },
      }),
    },
    stopWhen: ({ steps }) => steps.length >= 3,
  })
  const done = result.consumeStream().then(() => result.steps)
  return { done, ran: () => ran }
}

describe("the promise gate", () => {
  it("runs a promise with no tool call again, and the tool the re-run calls runs", async () => {
    const { model, prompts } = scripted(
      said("I'll set that up now."),
      called,
      said("Done.")
    )
    const { done, ran } = run(model, async () => true)
    const steps = await done
    expect(ran()).toBe(1)
    // The re-run was sent the promise and the nudge; the next step was not.
    const rerun = prompts[1] as { role: string; content: { text: string }[] }[]
    expect(rerun.slice(-2).map((m) => [m.role, m.content[0]?.text])).toEqual([
      ["assistant", "I'll set that up now."],
      ["user", NUDGE],
    ])
    // One step held the promise and the call, and its usage is both calls'.
    expect(steps[0]?.text).toBe("I'll set that up now.")
    expect(steps[0]?.toolCalls).toHaveLength(1)
    expect(steps[0]?.usage.inputTokens).toBe(200)
    expect(steps).toHaveLength(2)
  })

  it("runs a model that keeps promising at most twice more, then lets the turn end", async () => {
    const { model, prompts } = scripted(said("I'll do it."))
    const { done, ran } = run(model, async () => true)
    const steps = await done
    expect(prompts).toHaveLength(1 + MAX_RERUNS)
    expect(steps).toHaveLength(1)
    expect(ran()).toBe(0)
  })

  it("leaves an honest ending, a tool call and a reading that fails as they are", async () => {
    for (const promised of [
      async () => false,
      async () => {
        throw new Error("jev is down")
      },
    ]) {
      const { model, prompts } = scripted(said("Your site is live."))
      await run(model, promised).done
      expect(prompts).toHaveLength(1)
    }
    const { model, prompts } = scripted(called, said("Done."))
    // A step that called a tool is never read, only the text-only one after it.
    const asked: string[] = []
    await run(model, async (text) => {
      asked.push(text)
      return false
    }).done
    expect(prompts).toHaveLength(2)
    expect(asked).toEqual(["Done."])
  })
})
