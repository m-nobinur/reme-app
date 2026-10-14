import { describe, expect, it } from "vitest"
import {
  type Batch,
  BatchError,
  batchClient,
  slugOf,
  textsOf,
} from "../src/cos/batch.ts"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

const done = (results: Batch["results"]): Batch => ({
  id: "batch_1",
  status: "completed",
  results,
})

describe("the batch client", () => {
  it("submits the slug and endpoint before the requests, with the key", async () => {
    const seen: { url: string; body: string; auth: string | null }[] = []
    const client = batchClient({
      apiKey: "or-key",
      fetch: async (url, init) => {
        seen.push({
          url: String(url),
          body: String(init?.body),
          auth: new Headers(init?.headers).get("authorization"),
        })
        return json({ id: "batch_1", status: "validating", results: null }, 202)
      },
    })
    const batch = await client.submit({
      model: "anthropic/claude-sonnet-5.5:batch",
      requests: [{ custom_id: "a", body: { messages: [] } }],
    })
    expect(batch.status).toBe("validating")
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/batches")
    expect(seen[0]?.auth).toBe("Bearer or-key")
    // The API answers 400 when `requests` comes first.
    const keys = Object.keys(JSON.parse(seen[0]?.body ?? "{}"))
    expect(keys).toEqual(["endpoint", "model", "requests"])
    expect(JSON.parse(seen[0]?.body ?? "{}").model).toBe(
      "anthropic/claude-sonnet-5.5"
    )
  })

  it("refuses an empty batch and a repeated custom_id before any call", () => {
    const client = batchClient({
      apiKey: "k",
      fetch: async () => {
        throw new Error("no call expected")
      },
    })
    expect(() => client.submit({ model: "m", requests: [] })).toThrow(
      "at least one"
    )
    const r = { custom_id: "a", body: {} }
    expect(() => client.submit({ model: "m", requests: [r, r] })).toThrow(
      "repeats"
    )
  })

  it("polls until the batch is terminal, then returns it with its results", async () => {
    const states = ["validating", "in_progress", "finalizing", "completed"]
    const slept: number[] = []
    const client = batchClient({
      apiKey: "k",
      sleep: async (ms) => {
        slept.push(ms)
      },
      fetch: async () => {
        const status = states.shift() ?? "completed"
        return json({
          id: "batch_1",
          status,
          results: status === "completed" ? [] : null,
        })
      },
    })
    const batch = await client.wait("batch_1", { everyMs: 1_000 })
    expect(batch.status).toBe("completed")
    expect(slept).toEqual([1_000, 1_000, 1_000])
  })

  it("gives up waiting at the timeout and says where the batch is", async () => {
    const client = batchClient({
      apiKey: "k",
      sleep: async () => undefined,
      fetch: async () =>
        json({ id: "batch_1", status: "in_progress", results: null }),
    })
    const batch = await client.wait("batch_1", { everyMs: 10, timeoutMs: 25 })
    expect(batch.status).toBe("in_progress")
  })

  it("turns an HTTP refusal into a typed error with the body", async () => {
    const client = batchClient({
      apiKey: "k",
      fetch: async () =>
        json({ error: { code: 400, message: "no :batch endpoint" } }, 400),
    })
    const error = await client
      .get("batch_1")
      .catch((e: unknown) => e as BatchError)
    expect(error).toBeInstanceOf(BatchError)
    expect((error as BatchError).code).toBe("batch.http_400")
    expect((error as BatchError).message).toContain("no :batch endpoint")
  })
})

describe("reading results", () => {
  it("maps each custom_id to its text or its reason", () => {
    const texts = textsOf(
      done([
        {
          custom_id: "ok",
          response: {
            status_code: 200,
            body: { choices: [{ message: { content: "hello" } }] },
          },
          error: null,
        },
        {
          custom_id: "rejected",
          response: null,
          error: { message: "content filtered" },
        },
        {
          custom_id: "empty",
          response: { status_code: 200, body: { choices: [] } },
          error: null,
        },
      ])
    )
    expect(texts.get("ok")).toEqual({ text: "hello" })
    expect(texts.get("rejected")).toEqual({
      error: '{"message":"content filtered"}',
    })
    expect(texts.get("empty")).toEqual({ error: "status 200, no text" })
  })

  it("has nothing for a batch with no results yet", () => {
    expect(
      textsOf({ id: "b", status: "in_progress", results: null }).size
    ).toBe(0)
  })

  it("drops the :batch suffix and nothing else", () => {
    expect(slugOf("openai/gpt-6.1-sol:batch")).toBe("openai/gpt-6.1-sol")
    expect(slugOf("openai/gpt-6.1-sol")).toBe("openai/gpt-6.1-sol")
  })
})
