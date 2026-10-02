import { convertArrayToReadableStream } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  retryableStatus,
  retryMiddleware,
  withoutReasoning,
} from "../src/cos/retry.ts"

type Part = Record<string, unknown> & { type: string }
type WrapStream = NonNullable<typeof retryMiddleware.wrapStream>
type Options = Parameters<WrapStream>[0]

const start: Part = { type: "stream-start", warnings: [] }
const rateLimited: Part = {
  type: "error",
  error: { code: 429, message: "rate-limited upstream" },
}
const answer: Part[] = [
  start,
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Hello" },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
]
const result = (parts: Part[]) => ({
  stream: convertArrayToReadableStream(parts) as never,
})

const pinned = {
  providerOptions: {
    openrouter: { reasoning_details: [{ type: "reasoning.encrypted" }] },
  },
}
const prompt = [
  { role: "user", content: [{ type: "text", text: "Hi" }] },
  {
    role: "assistant",
    ...pinned,
    content: [
      { type: "reasoning", text: "thinking", ...pinned },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "get_facts",
        input: {},
        ...pinned,
      },
    ],
  },
  { role: "tool", content: [] },
]

/** Runs the middleware over a first attempt and a model's later ones, and reads it all. */
async function run(first: Part[], later: Part[][]) {
  const sent: unknown[] = []
  const model = {
    doStream: vi.fn(async (params: { prompt: unknown }) => {
      sent.push(params.prompt)
      return result(later.shift() ?? answer)
    }),
  }
  const wrapped = await (retryMiddleware.wrapStream as WrapStream)({
    doStream: async () => result(first),
    params: { prompt } as never,
    model,
  } as unknown as Options)
  const parts: Part[] = []
  const reader = wrapped.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as Part)
  }
  return { parts, sent, calls: model.doStream.mock.calls.length }
}

describe("retrying a CoS step that fails before any content", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  afterEach(() => log.mockClear())
  const retries = () =>
    log.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((l) => l.code === "cos.retry")

  it("tries the same host again after an in-stream 429, and the owner sees only the answer", async () => {
    const { parts, sent, calls } = await run([start, rateLimited], [answer])
    expect(calls).toBe(1)
    expect(sent[0]).toEqual(prompt)
    expect(parts.map((p) => p.type)).not.toContain("error")
    expect(parts).toContainEqual(expect.objectContaining({ delta: "Hello" }))
    expect(retries()).toEqual([{ code: "cos.retry", attempt: 2, status: 429 }])
  })

  it("drops the encrypted reasoning on the third attempt, so any host can answer", async () => {
    const { parts, sent } = await run(
      [start, rateLimited],
      [[start, rateLimited], answer]
    )
    expect(sent[0]).toEqual(prompt)
    expect(JSON.stringify(sent[1])).not.toContain("reasoning")
    expect(parts).toContainEqual(expect.objectContaining({ delta: "Hello" }))
    expect(retries().map((l) => l.attempt)).toEqual([2, 3])
  })

  it("passes the last failure through as it came, after three attempts", async () => {
    const { parts, calls } = await run(
      [start, rateLimited],
      [
        [start, rateLimited],
        [start, rateLimited],
      ]
    )
    expect(calls).toBe(2)
    expect(parts.at(-1)).toEqual(rateLimited)
  })

  it("never retries once content has passed, or for a refusal", async () => {
    const late = [
      start,
      { type: "text-delta", id: "t1", delta: "Hel" },
      rateLimited,
    ]
    expect((await run(late, [])).calls).toBe(0)
    expect((await run(late, [])).parts.at(-1)).toEqual(rateLimited)
    const refused = {
      type: "error",
      error: { code: 400, message: "bad request" },
    }
    const once = await run([start, refused], [])
    expect(once.calls).toBe(0)
    expect(once.parts.at(-1)).toEqual(refused)
    expect(retries()).toEqual([])
  })
})

describe("the parts of a retry", () => {
  it("reads a status from an in-stream error or an API error", () => {
    expect(retryableStatus({ code: 429 })).toBe(429)
    expect(retryableStatus({ code: "503" })).toBe(503)
    expect(retryableStatus({ statusCode: 408 })).toBe(408)
    expect(retryableStatus({ code: 400 })).toBeNull()
    expect(retryableStatus(new Error("x"))).toBeNull()
  })

  it("keeps everything but the encrypted reasoning", () => {
    const bare = withoutReasoning(prompt as never) as typeof prompt
    expect(bare[0]).toEqual(prompt[0])
    expect(bare[2]).toEqual(prompt[2])
    expect(bare[1]?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "get_facts",
        input: {},
        providerOptions: { openrouter: {} },
      },
    ])
    expect(JSON.stringify(bare)).not.toContain("reasoning")
  })
})
