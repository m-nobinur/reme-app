import type { FlueObservation } from "@flue/runtime"
import { EventEnvelope } from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { contextHash, deriveContext } from "../src/derive.ts"
import { createTee, type EventSink, redact } from "../src/tee.ts"

const uuid = (n: number) =>
  `10000001-0000-4000-8000-${String(n).padStart(12, "0")}`
const ids = {
  org_id: uuid(1),
  staff_id: uuid(2),
  assignment_id: uuid(3),
  session_id: uuid(4),
}

// Assembled at run time so the repo's secret scan, which reads diffs for
// key-shaped literals, does not mistake a test fixture for a leak.
const KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-")
const DSN = ["postgresql:", "", "u:p@h", "db"].join("/")

const observation = (type: string, extra: Record<string, unknown> = {}) =>
  ({
    v: 3,
    eventIndex: 0,
    timestamp: "2026-09-15T00:00:00.000Z",
    type,
    ...extra,
  }) as unknown as FlueObservation

/** A sink that records rows and refuses a gap, the way the orchestrator's does. */
function memorySink(seed: number | null = null) {
  const rows: EventEnvelope[] = []
  let last = seed
  const sink: EventSink = {
    lastSeq: async () => last,
    append: async (batch) => {
      for (const row of batch) {
        EventEnvelope.parse(row)
        if (row.seq !== (last ?? -1) + 1) {
          throw new Error(`gap: got ${row.seq}, last was ${last}`)
        }
        last = row.seq
        rows.push(row)
      }
    },
  }
  return { sink, rows }
}

describe("the observe tee", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("appends every runtime event in seq order under waitUntil, seeded from the sink", async () => {
    const { sink, rows } = memorySink(6)
    const waited: Promise<unknown>[] = []
    const tee = createTee({ sink, ids, waitUntil: (p) => waited.push(p) })
    tee.subscriber(observation("agent_start"))
    tee.subscriber(observation("turn_start", { turnId: "t1" }))
    tee.emit("runtime.context_segment", { role: "developer" })
    tee.subscriber(
      observation("turn_messages", {
        turnId: "t1",
        message: { role: "assistant" },
        toolResults: [],
      })
    )
    await Promise.all(waited)
    expect(rows.map((r) => r.seq)).toEqual([7, 8, 9, 10])
    expect(rows.map((r) => r.type)).toEqual([
      "runtime.agent_start",
      "runtime.turn_start",
      "runtime.context_segment",
      "runtime.turn_messages",
    ])
    for (const row of rows) {
      expect(row).toMatchObject(ids)
      expect(row.event_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    }
  })

  it("redacts turn_request before storage, and no key survives in any row", async () => {
    const { sink, rows } = memorySink()
    const waited: Promise<unknown>[] = []
    const tee = createTee({ sink, ids, waitUntil: (p) => waited.push(p) })
    tee.subscriber(
      observation("turn_request", {
        turnId: "t1",
        purpose: "agent",
        request: {
          providerId: "openrouter",
          requestedModel: "deepseek/deepseek-v4.1-flash",
          api: "openai-completions",
          input: {
            systemPrompt: `You hold ${KEY} and Bearer ${KEY}`,
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }] },
            ],
            tools: [{ name: "bash" }],
          },
        },
      })
    )
    tee.subscriber(
      observation("log", {
        message: `connection ${DSN} and ${KEY}`,
      })
    )
    await Promise.all(waited)
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain(KEY)
    expect(stored).not.toContain(DSN)
    const request = rows[0]?.payload.request as Record<string, unknown>
    expect(request.input).toBeUndefined()
    expect(request.input_summary).toEqual({
      system_prompt_chars: expect.any(Number),
      messages: 1,
      tools: 1,
    })
  })

  it("re-seeds after a failed flush instead of numbering past the gap", async () => {
    let fail = true
    const { sink, rows } = memorySink(0)
    const failing: EventSink = {
      lastSeq: sink.lastSeq,
      append: async (batch) => {
        if (fail) {
          fail = false
          throw new Error("database away")
        }
        return sink.append(batch)
      },
    }
    const waited: Promise<unknown>[] = []
    const tee = createTee({
      sink: failing,
      ids,
      waitUntil: (p) => waited.push(p),
    })
    tee.subscriber(observation("agent_start"))
    await Promise.all(waited)
    expect(rows).toHaveLength(0)
    tee.subscriber(observation("agent_end"))
    await tee.flush()
    expect(rows.map((r) => [r.type, r.seq])).toEqual([
      ["runtime.agent_start", 1],
      ["runtime.agent_end", 2],
    ])
  })

  it("mints event ids that sort in write order within one millisecond", async () => {
    // A Worker's clock stands still within a request; this one does too.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
    const { sink, rows } = memorySink()
    const waited: Promise<unknown>[] = []
    const tee = createTee({ sink, ids, waitUntil: (p) => waited.push(p) })
    for (let i = 0; i < 200; i++) tee.emit("runtime.probe", { i })
    await Promise.all(waited)
    const written = rows.map((r) => r.event_id)
    expect(written).toHaveLength(200)
    expect([...written].sort()).toEqual(written)
  })

  it("keeps the redaction pure: the same observation redacts the same way", () => {
    const o = observation("turn", { response: { output: { text: KEY } } })
    expect(redact(o)).toEqual(redact(o))
  })
})

describe("deriveContext over a recorded session", () => {
  const record = async () => {
    const { sink, rows } = memorySink()
    const waited: Promise<unknown>[] = []
    const tee = createTee({ sink, ids, waitUntil: (p) => waited.push(p) })
    tee.emit("runtime.context_segment", {
      role: "developer",
      facts: [{ key: "business.phone", value: { e164: "+15550142" } }],
    })
    tee.subscriber(observation("turn_start", { turnId: "t1" }))
    tee.subscriber(
      observation("turn_messages", {
        turnId: "t1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Building." }],
        },
        toolResults: [{ role: "toolResult", output: "ok" }],
      })
    )
    tee.subscriber(observation("compaction", { summary: "nothing yet" }))
    await Promise.all(waited)
    return rows
  }

  it("yields the same hash twice, and one changed event changes it", async () => {
    const events = await record()
    const first = await contextHash(events)
    const second = await contextHash(events)
    expect(first).toBe(second)
    expect(deriveContext(events).parts.map((p) => p.kind)).toEqual([
      "segment",
      "turn",
      "compaction",
    ])

    const changed = events.map((e) =>
      e.type === "runtime.turn_messages"
        ? {
            ...e,
            payload: {
              ...e.payload,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Built." }],
              },
            },
          }
        : e
    )
    expect(await contextHash(changed)).not.toBe(first)

    // Framing carries no model-visible state, so more of it moves nothing.
    const framed = [
      ...events,
      {
        ...events[0],
        event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        seq: 99,
        type: "runtime.idle",
        payload: {},
      },
    ] as EventEnvelope[]
    expect(await contextHash(framed)).toBe(first)
  })
})
