import { CosTurn } from "@workspace/contracts"
import {
  appendSessionEvent,
  handoffEvent,
  logEvent,
  newUlid,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DEFAULT_MODEL, WAKE_LINE } from "../src/cos/agent.ts"
import { SessionBusy } from "../src/cos/turns.ts"
import {
  isQuiet,
  WAKE_POSTS_PER_DAY,
  type WakeJob,
  wakeTurn,
} from "../src/wake.ts"
import { type Owner, owner, SUFFIX, stubOrchestrator } from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

type CallOptions = Parameters<MockLanguageModelV4["doStream"]>[0]

const said = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: {
        total: 1_000,
        noCache: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: { total: 50, text: 50, reasoning: 0 },
    },
  },
]

function replying(text: string) {
  const sent: CallOptions[] = []
  const model = new MockLanguageModelV4({
    modelId: DEFAULT_MODEL,
    doStream: async (options) => {
      sent.push(options)
      return { stream: convertArrayToReadableStream(said(text)) as never }
    },
  })
  return { model, sent }
}

describe("isQuiet", () => {
  it("reads the marker alone, opening or closing a reply, and an empty reply as quiet", () => {
    expect(isQuiet("[quiet]")).toBe(true)
    expect(isQuiet("[QUIET] nothing new")).toBe(true)
    expect(isQuiet("Nothing worth a word.\n[quiet]")).toBe(true)
    expect(isQuiet("")).toBe(true)
    expect(isQuiet("Your site is live. Say [quiet] if you like.")).toBe(false)
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)("a proactive turn", () => {
  const kit: Tenancy = tenancy(url as string, { max: 4 })
  const admin = postgres(url as string, { max: 2 })
  const sends: { key: string; channel: string }[] = []
  let realFetch: typeof fetch
  let me: Owner

  const bindings = () =>
    ({
      ...env(url as string),
      ORCHESTRATOR: stubOrchestrator(),
      SITE_HOST_SUFFIX: SUFFIX,
      SCHEDULE: { get: async () => null, put: async () => undefined },
      JOBS: { send: async () => undefined },
      AFTER_TURN: { send: async () => undefined },
      DELIVERIES: {
        send: async (body: { key: string; channel: string }) =>
          void sends.push(body),
      },
    }) as unknown as Env

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    me = await owner(kit, url as string, "cos-wake")
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await admin.end()
    await kit.close()
  })

  /** A new chat with a finished build logged in it, as the ingest logs one. */
  const chatWithResult = async () => {
    const made = await me.call(stubOrchestrator(), "/conversations", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    })
    const { id } = (await made.json()) as { id: string }
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      logEvent(
        db,
        { orgId: me.orgId, staffId: null, assignmentId: null },
        handoffEvent({
          outcome: "done",
          summary: "Done and live: a new photo gallery page",
          evidence: [],
          metadata: { kind: "site.change", state: "published" },
        })
      )
    )
    return id
  }

  /** The last hand-over's job, and its run as the orchestrator recorded it. */
  let last = { jobId: "", slot: "" }
  const wake = async (model: MockLanguageModelV4, beat?: WakeJob["beat"]) => {
    const slot = new Date().toISOString()
    // Paused, so no scan in a suite alongside finds it due.
    const [job] = await admin<{ id: string }[]>`
      insert into scheduled_jobs (org_id, kind, next_run_at, paused_at)
      values (${me.orgId}, ${beat ? "heartbeat" : "cos_wake"}, ${slot}, now())
      returning id`
    const jobId = job?.id as string
    await admin`insert into job_runs (job_id, org_id, run_at, outcome, detail)
      values (${jobId}, ${me.orgId}, ${slot}, 'done', 'handed')`
    last = { jobId, slot }
    return wakeTurn(
      bindings(),
      kit,
      {
        kind: "cos_wake",
        orgId: me.orgId,
        jobId,
        slot,
        ...(beat && { beat }),
      },
      { model }
    )
  }
  const lastRun = async () =>
    (
      await admin<{ outcome: string; detail: string }[]>`
        select outcome, detail from job_runs
        where job_id = ${last.jobId} and run_at = ${last.slot}`
    )[0]
  const heartbeat = (beat: Partial<NonNullable<WakeJob["beat"]>> = {}) => ({
    email: true,
    trusted: [],
    follow_ups: [],
    ...beat,
  })

  const posted = (prefix: string) =>
    admin<{ key: string; channel: string }[]>`
      select key, channel from deliveries
      where org_id = ${me.orgId} and starts_with(key, ${prefix})
      order by created_at, key`
  const logOf = (id: string) =>
    admin<{ type: string; payload: unknown }[]>`
      select type, payload from events where session_id = ${id} order by seq`
  const clearPosts = () =>
    admin`delete from deliveries where org_id = ${me.orgId}
      and (starts_with(key, 'wake:') or starts_with(key, 'heartbeat:')
        or starts_with(key, 'unprompted:'))`

  it("reads what was logged with the read tools only and posts one message through the outbox", async () => {
    await clearPosts()
    const id = await chatWithResult()
    sends.length = 0
    const { model, sent } = replying("Your photo gallery page is live.")
    expect(await wake(model)).toBe("ran")
    const prompt = JSON.stringify(sent[0]?.prompt)
    expect(prompt).toContain(WAKE_LINE)
    expect(prompt).toContain("Done and live: a new photo gallery page")
    const tools = (sent[0]?.tools ?? []).map((t) => t.name)
    expect(tools).toContain("get_workspace")
    for (const write of ["remember", "request_change", "create_reminder"])
      expect(tools).not.toContain(write)
    expect(sends).toEqual([
      expect.objectContaining({
        channel: "in_app",
        key: expect.stringMatching(`^wake:${me.orgId}:`),
        conversationId: id,
        message: { text: ["Your photo gallery page is live."] },
      }),
    ])
    expect(await posted(`wake:${me.orgId}:`)).toHaveLength(1)
    // The reply is logged by the post, as the assistant's notice, not as a turn message.
    const log = await logOf(id)
    expect(log.filter((e) => e.type === "cos.message")).toEqual([])
    const closed = log.filter((e) => e.type === "cos.turn")
    expect(closed.map((e) => CosTurn.parse(e.payload).outcome)).toEqual([
      "answered",
    ])
  }, 30_000)

  it("spends none of the day's posts on a [quiet] turn, and posts no fourth event-driven message in a day", async () => {
    await clearPosts()
    await chatWithResult()
    for (let n = 1; n < WAKE_POSTS_PER_DAY; n++)
      expect(await wake(replying(`Update ${n}.`).model)).toBe("ran")
    expect(await wake(replying("[quiet]").model)).toBe("ran")
    expect(await posted(`wake:${me.orgId}:`)).toHaveLength(
      WAKE_POSTS_PER_DAY - 1
    )
    expect(await wake(replying("Update 3.").model)).toBe("ran")
    expect(await posted(`wake:${me.orgId}:`)).toHaveLength(WAKE_POSTS_PER_DAY)
    const fourth = replying("Update 4.")
    expect(await wake(fourth.model)).toBe("capped")
    expect(fourth.sent).toEqual([])
  }, 60_000)

  it("opens no turn while a turn is open or the owner typed under two minutes ago", async () => {
    await clearPosts()
    const id = await chatWithResult()
    const turnId = newUlid()
    const append = (type: string) =>
      kit.withOrg({ orgId: me.orgId }, (db) =>
        appendSessionEvent(db, {
          orgId: me.orgId,
          staffId: null,
          assignmentId: null,
          sessionId: id,
          type,
          payload: { turn_id: turnId },
          taint: [],
        })
      )
    await append("cos.context")
    const open = replying("Hello.")
    await expect(wake(open.model)).rejects.toBeInstanceOf(SessionBusy)
    await append("cos.turn")

    const hi = crypto.randomUUID()
    await admin`
      insert into conversation_messages (conversation_id, id, org_id, format, content)
      values (${id}, ${hi}, ${me.orgId}, 'ai-sdk/v6',
        ${admin.json({ role: "user", parts: [{ type: "text", text: "hi" }] })})`
    const typed = replying("Hello.")
    expect(await wake(typed.model)).toBe("owner_active")
    expect(open.sent).toEqual([])
    expect(typed.sent).toEqual([])
    // Two minutes on, the owner is away again.
    await admin`update conversation_messages
      set created_at = now() - interval '3 minutes' where id = ${hi}`
    expect(await wake(replying("Hello.").model)).toBe("ran")
  }, 30_000)

  it("takes a heartbeat's one unprompted message only when it posts, and emails when asked", async () => {
    await clearPosts()
    await chatWithResult()
    expect(await wake(replying("[quiet] nothing new").model, heartbeat())).toBe(
      "ran"
    )
    expect(await posted("unprompted:")).toEqual([])
    sends.length = 0
    expect(
      await wake(replying("A review came in today.").model, heartbeat())
    ).toBe("ran")
    expect(await posted("unprompted:")).toHaveLength(1)
    expect(sends.map((s) => s.channel)).toEqual(["in_app", "email"])
    expect(await wake(replying("Another.").model, heartbeat())).toBe("capped")
  }, 60_000)

  it("posts nothing and records the run failed when the reply repeats a link injected into a review", async () => {
    await clearPosts()
    await chatWithResult()
    const followUp = `task:${crypto.randomUUID()}:records:blocked`
    await admin`insert into deliveries (org_id, key, channel, state)
      values (${me.orgId}, ${`heartbeat-item:${me.orgId}:${followUp}`}, 'in_app', 'sent')`
    sends.length = 0
    const beat = heartbeat({
      trusted: ["www.brightclean.test"],
      follow_ups: [followUp],
    })
    expect(
      await wake(
        replying(
          "Jo left a review. Book her again at https://evil.example/pay."
        ).model,
        beat
      )
    ).toBe("ran")
    expect(sends).toEqual([])
    expect(await posted(`heartbeat:${me.orgId}:`)).toEqual([])
    expect(await posted("unprompted:")).toEqual([])
    expect(await lastRun()).toEqual({
      outcome: "failed",
      detail: "unsourced_contact",
    })
    // The follow-up goes back to the ledger's unsurfaced, for a later beat.
    expect(await posted(`heartbeat-item:${me.orgId}:${followUp}`)).toEqual([])
    expect(
      await admin`select 1 from task_followups where fingerprint = ${followUp}`
    ).toHaveLength(0)

    // A trusted host is fine, and the post records the follow-up and carries the chip.
    expect(
      await wake(
        replying("Your DNS change at www.brightclean.test is still waiting.")
          .model,
        { ...beat, chip: "Connect Google" }
      )
    ).toBe("ran")
    expect(await lastRun()).toEqual({
      outcome: "done",
      detail: "sent:in_app,email",
    })
    expect(sends[0]).toMatchObject({
      channel: "in_app",
      message: {
        button: {
          label: "Connect Google",
          action: { kind: "connect", service: "google" },
        },
      },
    })
    expect(
      await admin`select 1 from task_followups where fingerprint = ${followUp}`
    ).toHaveLength(1)
  }, 60_000)

  it("keeps a heartbeat's follow-ups asked when the turn stays quiet", async () => {
    await clearPosts()
    await chatWithResult()
    const followUp = `task:${crypto.randomUUID()}:records:blocked`
    const ledger = `heartbeat-item:${me.orgId}:${followUp}`
    await admin`insert into deliveries (org_id, key, channel, state)
      values (${me.orgId}, ${ledger}, 'in_app', 'sent')`
    expect(
      await wake(
        replying("[quiet]").model,
        heartbeat({ follow_ups: [followUp] })
      )
    ).toBe("ran")
    expect(await lastRun()).toEqual({ outcome: "no_change", detail: "quiet" })
    expect(await posted(ledger)).toHaveLength(1)
  }, 30_000)

  it("runs no write tool, even one the model calls by name", async () => {
    await clearPosts()
    const id = await chatWithResult()
    const steps: Record<string, unknown>[][] = [
      [
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "call_put_off",
          toolName: "put_off",
          input: JSON.stringify({ kind: "google", days: 7 }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: said("").at(-1)?.usage,
        },
      ],
      said("[quiet]"),
    ]
    const model = new MockLanguageModelV4({
      modelId: DEFAULT_MODEL,
      doStream: async () => ({
        stream: convertArrayToReadableStream(
          steps.shift() ?? said("[quiet]")
        ) as never,
      }),
    })
    expect(await wake(model)).toBe("ran")
    const started = (await logOf(id)).filter(
      (e) => e.type === "cos.tool_started" || e.type === "cos.tool_result"
    )
    expect(started).toEqual([])
  }, 30_000)
})
