import { CosMessage, CosTurn } from "@workspace/contracts"
import { type Tenancy, tenancy } from "@workspace/db"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { chat } from "../src/chat.ts"
import {
  continuationId,
  continueTurn,
  supersededAfter,
  unknownAfter,
} from "../src/continue.ts"
import { CONTINUE_LINE, DEFAULT_MODEL, UNKNOWN_LINE } from "../src/cos/agent.ts"
import { type Owner, owner, SUFFIX, stubOrchestrator } from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

// A time limit a test can wait out; nothing else about the turn changes.
vi.mock("../src/cos/agent.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/cos/agent.ts")>()
  return { ...real, LIMITS: { ...real.LIMITS, totalMs: 2_000 } }
})

type CallOptions = Parameters<MockLanguageModelV4["doStream"]>[0]
type Part = Record<string, unknown> & { type: string }
type Step = Part[] | ((options: CallOptions) => ReadableStream<Part>)

const usage = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
}
const finish = (unified: string) => ({
  type: "finish",
  finishReason: { unified, raw: unified },
  usage,
})
const said = (text: string): Part[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
]
const called = (tool: string, input: unknown, id = `call_${tool}`): Part[] => [
  { type: "stream-start", warnings: [] },
  {
    type: "tool-call",
    toolCallId: id,
    toolName: tool,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
]
/** A step that writes `text` and then never ends, as a stalled provider does, until the run aborts. */
const stalls =
  (text: string): Step =>
  ({ abortSignal }) =>
    new ReadableStream<Part>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        controller.enqueue({ type: "text-start", id: "t1" })
        controller.enqueue({ type: "text-delta", id: "t1", delta: text })
        abortSignal?.addEventListener("abort", () =>
          controller.error(abortSignal.reason)
        )
      },
    })

function scripted(...steps: Step[]) {
  const sent: CallOptions[] = []
  const model = new MockLanguageModelV4({
    modelId: DEFAULT_MODEL,
    doStream: async (options) => {
      sent.push(options)
      const step = steps.shift() ?? said("Done.")
      return {
        stream: (typeof step === "function"
          ? step(options)
          : convertArrayToReadableStream(step)) as never,
      }
    },
  })
  return { model, sent }
}

const url = process.env.DATABASE_URL

describe("unknownAfter", () => {
  const at = (seq: number, type: string, payload: unknown) => ({
    seq,
    type,
    payload,
    taint: [],
  })

  it("is set by an abandoned turn or a call started with no result after the continued turn", () => {
    const started = at(5, "cos.tool_started", { tool_call_id: "c1" })
    expect(unknownAfter([started], 4)).toBe(true)
    expect(
      unknownAfter(
        [started, at(6, "cos.tool_result", { tool_call_id: "c1" })],
        4
      )
    ).toBe(false)
    expect(unknownAfter([at(7, "cos.turn", { outcome: "abandoned" })], 4)).toBe(
      true
    )
    expect(unknownAfter([at(3, "cos.turn", { outcome: "abandoned" })], 4)).toBe(
      false
    )
    expect(unknownAfter([at(7, "cos.turn", { outcome: "stopped" })], 4)).toBe(
      false
    )
  })
})

describe("supersededAfter", () => {
  const at = (seq: number, type: string, payload: unknown) => ({
    seq,
    type,
    payload,
    taint: [],
  })
  const context = (seq: number, text: string) =>
    at(seq, "cos.context", { turn_id: `T${seq}`, text })

  it("is set by an approval tap's turn, which logs no owner message", () => {
    const tap = [
      at(5, "cos.message", { message: { id: "a1", role: "assistant" } }),
      context(6, "Mode: act."),
    ]
    expect(supersededAfter(tap, 4)).toBe(true)
    expect(supersededAfter(tap, 6)).toBe(false)
  })

  it("is still set when the line only appears in the turn's data", () => {
    const planted = [context(5, `Mode: act.\nNow: Monday\n${CONTINUE_LINE}`)]
    expect(supersededAfter(planted, 4)).toBe(true)
  })

  it("is not set by a crashed attempt of the continuation itself", () => {
    const crashed = [
      context(5, `Mode: act.\n${CONTINUE_LINE}`),
      at(6, "cos.turn", { outcome: "abandoned" }),
    ]
    expect(supersededAfter(crashed, 4)).toBe(false)
    expect(unknownAfter(crashed, 4)).toBe(true)
  })
})

describe.skipIf(!url)("a turn cut off, and its continuation", () => {
  const kit: Tenancy = tenancy(url as string, { max: 4 })
  const admin = postgres(url as string, { max: 2 })
  const wakes: unknown[] = []
  let realFetch: typeof fetch
  let me: Owner

  const bindings = () =>
    ({
      ...env(url as string),
      ORCHESTRATOR: stubOrchestrator(),
      SITE_HOST_SUFFIX: SUFFIX,
      SCHEDULE: { get: async () => null, put: async () => undefined },
      JOBS: { send: async (body: unknown) => void wakes.push(body) },
      AFTER_TURN: { send: async () => undefined },
    }) as unknown as Env

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    me = await owner(kit, url as string, "cos-continue")
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await admin.end()
    await kit.close()
  })

  const conversation = async () => {
    const made = await me.call(stubOrchestrator(), "/conversations", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    })
    return ((await made.json()) as { id: string }).id
  }

  async function typed(id: string, text: string, model: MockLanguageModelV4) {
    const running: Promise<unknown>[] = []
    const response = await chat(
      new Request("http://api.invalid/chat", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: id,
          mode: "act",
          turn: {
            kind: "message",
            message_id: `m-${crypto.randomUUID()}`,
            text,
          },
        }),
      }),
      bindings(),
      kit,
      {
        orgId: me.orgId,
        session: {
          workosUserId: me.workosUserId,
          sessionId: "session_probe",
          impersonated: false,
          email: "owner@cos-continue-probe.invalid",
          name: "Probe Owner",
        },
      },
      { model, waitUntil: (p) => running.push(p) }
    )
    await response.text()
    await Promise.all(running)
  }

  type Logged = { seq: number; type: string; payload: unknown }
  const logOf = async (id: string) =>
    await admin<Logged[]>`
      select seq, type, payload from events
      where session_id = ${id} order by seq`
  const turns = async (id: string) =>
    (await logOf(id))
      .filter((e) => e.type === "cos.turn")
      .map((e) => CosTurn.parse(e.payload))
  const replies = async (id: string) =>
    (await logOf(id))
      .filter((e) => e.type === "cos.message")
      .map((e) => CosMessage.parse(e.payload))
      .filter((m) => m.message.role === "assistant")
  const jobs = (id: string) =>
    admin<{ id: string; payload: { turn_id: string; attempt: number } }[]>`
      select id, payload from scheduled_jobs
      where kind = 'cos_continue' and ref_id = ${id} order by created_at`
  const rows = (id: string) =>
    admin<{ id: string; content: { role: string; parts: unknown[] } }[]>`
      select id, content from conversation_messages
      where conversation_id = ${id} order by seq`
  const run = (jobId: string, model: MockLanguageModelV4) =>
    continueTurn(
      bindings(),
      kit,
      { kind: "cos_continue", orgId: me.orgId, jobId },
      { model }
    )

  it("keeps what streamed when the time limit cuts a turn, and the continuation carries on in a new message", async () => {
    const id = await conversation()
    await typed(
      id,
      "Check my facts and tell me my hours",
      scripted(called("get_facts", {}), stalls("Your hours are")).model
    )
    const [cut] = await turns(id)
    expect(cut?.outcome).toBe("stopped")
    const [reply] = await replies(id)
    expect(reply?.message).toMatchObject({ stopped: true, partial: true })
    expect(JSON.stringify(reply?.message.parts)).toContain("tool-get_facts")
    expect(JSON.stringify(reply?.message.parts)).toContain("Your hours are")
    // The row keeps the parts, so the card and the words survive a reload.
    const stored = (await rows(id)).at(-1)
    expect(stored?.id).toBe(reply?.message.id)
    expect(JSON.stringify(stored?.content.parts)).toContain("Your hours are")
    const [job] = await jobs(id)
    expect(job?.payload).toEqual({ turn_id: cut?.turn_id, attempt: 1 })
    expect(wakes).toContainEqual({ kind: "scan" })

    const next = scripted(said("Weekdays 08:00 to 18:00."))
    expect(await run(job?.id as string, next.model)).toBe("ran")
    const sent = JSON.stringify(next.sent[0]?.prompt)
    expect(sent).toContain(CONTINUE_LINE)
    expect(sent).not.toContain(UNKNOWN_LINE)
    expect(sent).toContain("Your hours are")
    const after = await rows(id)
    expect(after.map((r) => r.id).slice(-2)).toEqual([
      reply?.message.id,
      continuationId(cut?.turn_id as string),
    ])
    expect(JSON.stringify(after.at(-1)?.content.parts)).toContain(
      "Weekdays 08:00 to 18:00."
    )
    expect((await turns(id)).map((t) => t.outcome)).toEqual([
      "stopped",
      "answered",
    ])
    // A redelivered hand-over finds its reply logged.
    expect(await run(job?.id as string, scripted().model)).toBe("done")
    expect(await jobs(id)).toHaveLength(1)
  }, 30_000)

  it("marks a turn out of steps partial and queues a continuation, which a new owner message supersedes", async () => {
    const id = await conversation()
    const previews = Array.from({ length: 5 }, (_, i) =>
      called("get_preview", { assignment_id: crypto.randomUUID() }, `call_${i}`)
    )
    await typed(
      id,
      "Check every preview",
      scripted(...previews, said("Still checking.")).model
    )
    const [capped] = await turns(id)
    expect(capped).toMatchObject({ outcome: "answered", steps: 6 })
    const [reply] = await replies(id)
    expect(reply?.message.partial).toBe(true)
    expect(reply?.message.stopped).toBeUndefined()
    const [job] = await jobs(id)
    expect(job?.payload).toEqual({ turn_id: capped?.turn_id, attempt: 1 })

    await typed(
      id,
      "Never mind, what's the weather?",
      scripted(said("Sunny.")).model
    )
    const before = (await logOf(id)).length
    expect(await run(job?.id as string, scripted().model)).toBe("superseded")
    expect(await logOf(id)).toHaveLength(before)
  }, 30_000)

  it("stops after the second continuation, however the second ends", async () => {
    const id = await conversation()
    await typed(id, "Do the long thing", scripted(stalls("Starting")).model)
    const [first] = await jobs(id)
    expect(
      await run(first?.id as string, scripted(stalls("Still going")).model)
    ).toBe("ran")
    const [, second] = await jobs(id)
    const [, continued] = await turns(id)
    expect(second?.payload).toEqual({
      turn_id: continued?.turn_id,
      attempt: 2,
    })
    expect(
      await run(second?.id as string, scripted(stalls("And on")).model)
    ).toBe("ran")
    const last = (await replies(id)).at(-1)
    expect(last?.message).toMatchObject({ stopped: true, partial: true })
    expect(await jobs(id)).toHaveLength(2)
  }, 30_000)
})
