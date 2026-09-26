import {
  type AskFactInput,
  Conversation,
  ConversationHistory,
  ConversationList,
  ErrorEnvelope,
  FactList,
  type FactRecord,
  type FactValue,
} from "@workspace/contracts"
import { conversationMessages, eq, type Tenancy, tenancy } from "@workspace/db"
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  readUIMessageStream,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ASK_REPLY,
  CANCELLED,
  chat,
  firstMessage,
  nextStep,
  ONBOARDING_GOAL,
  type Part,
  type Script,
  STREAM_HEADERS,
  type ToolPart,
} from "../src/chat.ts"
import {
  type Owner,
  owner,
  type Stub,
  SUFFIX,
  stubOrchestrator,
} from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

/** Ids in the order asked for, the same on every run. */
const counter = (prefix = "id") => {
  let n = 0
  return () => `${prefix}${++n}`
}

const facts = (...keys: string[]) =>
  keys.map((key) => ({ key })) as unknown as FactRecord[]
const REQUIRED = [
  "business.name",
  "business.phone",
  "business.email",
  "hours.weekday",
  "service_area.radius",
  "pricing.standard_clean_hourly",
]
const script = (over: Partial<Script> = {}): Script => ({
  kind: "onboarding",
  facts: [],
  orgName: "Brightclean (fixture)",
  skipped: [],
  offered: false,
  message: null,
  newId: counter(),
  ...over,
})

describe("the onboarding script", () => {
  it("asks for the business name first, filled in with the org's name", () => {
    expect(nextStep(script())).toEqual([
      {
        type: "tool-ask_fact",
        toolCallId: "id1",
        state: "input-available",
        input: {
          key: "business.name",
          skippable: false,
          prefill: { name: "Brightclean (fixture)" },
        },
      },
    ])
  })

  it("prefills nothing when the org's name is not a business name", () => {
    const [ask] = nextStep(script({ orgName: "   " })) as [ToolPart]
    expect((ask.input as AskFactInput).prefill).toBeNull()
  })

  it("asks for the next missing key, and only pricing may be skipped", () => {
    const asked = (held: string[]) =>
      (nextStep(script({ facts: facts(...held) }))[0] as ToolPart)
        .input as AskFactInput
    expect(asked(["business.name"])).toEqual({
      key: "business.phone",
      skippable: false,
      prefill: null,
    })
    expect(asked(REQUIRED.slice(0, 5))).toEqual({
      key: "pricing.standard_clean_hourly",
      skippable: true,
      prefill: null,
    })
  })

  it("re-asks the missing key when the owner types instead", () => {
    const [ask] = nextStep(
      script({ message: { mode: "act", text: "Just build it" } })
    ) as ToolPart[]
    expect(ask?.type).toBe("tool-ask_fact")
  })

  it("offers the first build once every key is held or skipped", () => {
    const held = script({
      facts: facts(...REQUIRED.slice(0, 5)),
      skipped: ["pricing.standard_clean_hourly"],
    })
    expect(nextStep(held)).toEqual([
      {
        type: "tool-request_change",
        toolCallId: "id1",
        state: "approval-requested",
        input: { text: ONBOARDING_GOAL },
        approval: { id: "id2" },
      },
    ])
  })

  it("offers the owner's own words when they type at the end", () => {
    const [offer] = nextStep(
      script({
        facts: facts(...REQUIRED),
        message: { mode: "ask", text: "Make it green" },
      })
    ) as ToolPart[]
    expect(offer?.input).toEqual({ text: "Make it green" })
  })

  it.each([
    ["an onboarding that offered its build", { offered: true }],
    ["an assistant conversation", { kind: "assistant" as const }],
  ])(
    "after %s, turns an Act message into a change and answers Ask with one line",
    (_name, over) => {
      const act = nextStep(
        script({ ...over, message: { mode: "act", text: "Add Saturdays" } })
      )
      expect(act).toMatchObject([
        {
          type: "tool-request_change",
          state: "approval-requested",
          input: { text: "Add Saturdays" },
        },
      ])
      expect(
        nextStep(script({ ...over, message: { mode: "ask", text: "Why?" } }))
      ).toEqual([{ type: "text", text: ASK_REPLY, state: "done" }])
      expect(nextStep(script({ ...over, message: null }))).toEqual([])
    }
  )

  it("makes the first row from the same script", () => {
    expect(firstMessage("Brightclean (fixture)", counter())).toEqual({
      id: "id2",
      parentId: null,
      format: "ai-sdk/v6",
      content: {
        role: "assistant",
        parts: [{ type: "step-start" }, ...nextStep(script())],
      },
    })
  })

  it("streams with the AI SDK's headers", () => {
    expect(STREAM_HEADERS).toEqual(UI_MESSAGE_STREAM_HEADERS)
  })
})

const url = process.env.DATABASE_URL

/** The SSE body as chunks, checking the frame format and the closing `[DONE]`. */
function chunksOf(body: string): UIMessageChunk[] {
  const frames = body.split("\n\n")
  expect(frames.pop()).toBe("")
  expect(frames.pop()).toBe("data: [DONE]")
  return frames.map((frame) => {
    expect(frame.startsWith("data: ")).toBe(true)
    return JSON.parse(frame.slice("data: ".length)) as UIMessageChunk
  })
}

/** What a client holds after applying `chunks` to `message`. */
async function replay(
  message: UIMessage | undefined,
  chunks: UIMessageChunk[]
): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined
  for await (const snapshot of readUIMessageStream({
    message: message && structuredClone(message),
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    terminateOnError: true,
  })) {
    last = snapshot
  }
  return last
}

/** Undefined keys dropped, as a stored row has them. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const sha256 = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

const FIXED_BUILD = "0f1e2d3c-4b5a-4968-8776-655443322110"
const AT = "2026-09-26T09:30:00.000Z"

/** An orchestrator that starts every build with the same ids and times. */
const building = () =>
  stubOrchestrator(async (request) => {
    const body = (await request.clone().json()) as {
      kind: string
      goal: string
    }
    return Response.json(
      {
        assignment_id: FIXED_BUILD,
        org_id: "00000000-0000-4000-8000-000000000000",
        staff_id: "00000000-0000-4000-8000-000000000001",
        created_by_staff_id: "00000000-0000-4000-8000-000000000002",
        parent_assignment_id: null,
        revision_of_assignment_id: null,
        kind: body.kind,
        state: "queued",
        expected_version: 0,
        goal: body.goal,
        acceptance_criteria: ["probe"],
        fact_snapshot_id: "00000000-0000-4000-8000-000000000003",
        pack_refs: [],
        budget_usd: 5,
        deadline: null,
        priority: "normal",
        created_at: AT,
        updated_at: AT,
      },
      { status: 201 }
    )
  })

const STATED: FactValue[] = [
  { key: "business.phone", value: { e164: "+441632960001" } },
  { key: "business.email", value: { address: "hello@brightclean.invalid" } },
  { key: "hours.weekday", value: { open: "08:00", close: "18:00" } },
  {
    key: "service_area.radius",
    value: { centre: "Fictional Town", radius_km: 12 },
  },
]

describe.skipIf(!url)("POST /chat, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch

  beforeAll(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  /** The owner's side of a chat: turns sent with this id source. */
  const talker = (
    who: Owner,
    newId: () => string = () => crypto.randomUUID()
  ) => {
    const session = {
      workosUserId: who.workosUserId,
      sessionId: "session_probe",
      impersonated: false,
      email: "owner@chat-probe.invalid",
      name: "Probe Owner",
    }
    const send = async (body: unknown, stub: Stub = stubOrchestrator()) => {
      const response = await chat(
        new Request("http://api.invalid/chat", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        {
          ...env(url as string),
          ORCHESTRATOR: stub,
          SITE_HOST_SUFFIX: SUFFIX,
        } as unknown as Env,
        kit,
        { orgId: who.orgId, session },
        newId
      )
      return { response, text: await response.text() }
    }
    const rows = (conversationId: string) =>
      kit.withOrg({ orgId: who.orgId }, (db) =>
        db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
          .orderBy(conversationMessages.seq)
      )
    const asMessage = (row: { id: string; content: unknown }) =>
      ({ id: row.id, ...(row.content as object) }) as UIMessage
    const tail = async (conversationId: string) => {
      const row = (await rows(conversationId)).at(-1)
      if (!row) throw new Error("the conversation holds no rows")
      return asMessage(row)
    }
    const history = async (conversationId: string) =>
      ConversationHistory.parse(
        await (
          await who.call(
            stubOrchestrator(),
            `/conversations/${conversationId}/messages`
          )
        ).json()
      )
    /**
     * One turn, checked the way a reload is: the stored row the turn
     * continued, with the emitted chunks applied, is the stored row after.
     */
    const turn = async (
      conversationId: string,
      body: {
        turn: { kind: string; message_id: string } & Record<string, unknown>
      } & Record<string, unknown>,
      stub?: Stub
    ) => {
      const before =
        body.turn.kind === "message" ? undefined : await tail(conversationId)
      const sent = await send(
        { conversation_id: conversationId, mode: "act", ...body },
        stub
      )
      expect(sent.response.status, sent.text).toBe(200)
      const chunks = chunksOf(sent.text)
      const after = await tail(conversationId)
      expect(plain(await replay(before, chunks))).toStrictEqual(plain(after))
      return { ...sent, chunks, after }
    }
    const onboarding = async () => {
      const list = ConversationList.parse(
        await (await who.call(stubOrchestrator(), "/conversations")).json()
      )
      const found = list.conversations.find((c) => c.kind === "onboarding")
      if (!found) throw new Error("no onboarding conversation")
      return found.id
    }
    return { send, rows, tail, history, turn, onboarding }
  }

  const pendingCall = (message: UIMessage) =>
    message.parts.find(
      (p) =>
        "toolCallId" in p &&
        (p.state === "input-available" || p.state === "approval-requested")
    ) as unknown as ToolPart

  /** The whole script: confirm the name, four facts, skip pricing, approve. */
  async function onboard(ids: () => string) {
    const who = await owner(kit, url as string, "chat-script", ids)
    const me = talker(who, ids)
    const id = await me.onboarding()
    const bodies: string[] = []
    const answer = async (output: unknown) => {
      const at = await me.tail(id)
      const call = pendingCall(at)
      const done = await me.turn(id, {
        turn: {
          kind: "answer",
          message_id: at.id,
          tool_call_id: call.toolCallId,
          output,
        },
      })
      bodies.push(done.text)
      return done
    }
    await answer({
      answer: "stated",
      fact: { key: "business.name", value: { name: who.name } },
    })
    for (const fact of STATED) await answer({ answer: "stated", fact })
    await answer({ answer: "skipped" })
    const offer = pendingCall(await me.tail(id))
    const approved = await me.turn(
      id,
      {
        turn: {
          kind: "approval",
          message_id: (await me.tail(id)).id,
          approval_id: offer.approval?.id,
          approved: true,
        },
      },
      building()
    )
    bodies.push(approved.text)
    const history = await me.history(id)
    const hash = await sha256(
      bodies.join("") +
        JSON.stringify(
          history.messages.map(
            ({ content: { metadata: _, ...content }, ...m }) => ({
              ...m,
              content,
            })
          )
        )
    )
    return { who, me, id, hash, final: approved.after }
  }

  it("runs the whole script to the same bytes twice", async () => {
    const first = await onboard(counter("run_"))
    const second = await onboard(counter("run_"))
    expect(second.hash).toBe(first.hash)

    // The facts are the owner's, as the profile page will show them.
    const listed = FactList.parse(
      await (await first.who.call(stubOrchestrator(), "/facts")).json()
    )
    expect(
      listed.facts.map((f) => [f.key, f.provenance.source]).sort()
    ).toEqual(
      [
        "business.email",
        "business.name",
        "business.phone",
        "hours.weekday",
        "service_area.radius",
      ].map((key) => [key, "owner_stated"])
    )

    // The build started, and the transcript ends where no helper sends again.
    const parts = first.final.parts
    expect(parts.at(-1)).toEqual({ type: "step-start" })
    expect(parts.at(-2)).toMatchObject({
      type: "tool-request_change",
      state: "output-available",
      approval: { approved: true },
      output: { outcome: "started", build: { assignment_id: FIXED_BUILD } },
    })
    const messages = [first.final]
    expect(
      lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
        lastAssistantMessageIsCompleteWithApprovalResponses({ messages })
    ).toBe(false)
  }, 120_000)

  describe("an answer", () => {
    let who: Owner
    let me: ReturnType<typeof talker>
    let id: string
    beforeAll(async () => {
      who = await owner(kit, url as string, "chat-answer")
      me = talker(who)
      id = await me.onboarding()
    }, 60_000)

    const answering = async (output: unknown, over: object = {}) => {
      const at = await me.tail(id)
      return me.send({
        conversation_id: id,
        mode: "ask",
        turn: {
          kind: "answer",
          message_id: at.id,
          tool_call_id: pendingCall(at).toolCallId,
          output,
          ...over,
        },
      })
    }

    it("refuses a fact for another key, and a skip of a key the site needs", async () => {
      const before = await me.rows(id)
      for (const output of [
        { answer: "stated", fact: STATED[0] },
        { answer: "skipped" },
      ]) {
        const { response, text } = await answering(output)
        expect(response.status, text).toBe(400)
        expect(ErrorEnvelope.parse(JSON.parse(text)).code).toBe(
          "chat.answer_invalid"
        )
      }
      expect(await me.rows(id)).toEqual(before)
    })

    it("refuses a call the tail does not hold, and a message that is not the tail", async () => {
      for (const over of [
        { tool_call_id: "not_a_call" },
        { message_id: "not_the_tail" },
      ]) {
        const { response, text } = await answering({ answer: "skipped" }, over)
        expect(response.status, text).toBe(409)
        expect(ErrorEnvelope.parse(JSON.parse(text)).code).toBe("chat.stale")
      }
    })

    it("states the fact as the owner's, replays a retry and refuses a change of mind", async () => {
      const at = await me.tail(id)
      const call = pendingCall(at)
      const body = {
        conversation_id: id,
        mode: "act",
        turn: {
          kind: "answer",
          message_id: at.id,
          tool_call_id: call.toolCallId,
          output: {
            answer: "stated",
            fact: {
              key: "business.name",
              value: { name: "Sparkle (fixture)" },
            },
          },
        },
      }
      const first = await me.send(body)
      expect(first.response.status).toBe(200)
      expect(first.response.headers.get("content-type")).toBe(
        "text/event-stream"
      )
      const stored = await me.rows(id)
      const again = await me.send(body)
      expect(again.text).toBe(first.text)
      expect(await me.rows(id)).toEqual(stored)
      const changed = await me.send({
        ...body,
        turn: {
          ...body.turn,
          output: {
            answer: "stated",
            fact: { key: "business.name", value: { name: "Other (fixture)" } },
          },
        },
      })
      expect(changed.response.status).toBe(409)
      const listed = FactList.parse(
        await (await who.call(stubOrchestrator(), "/facts")).json()
      )
      expect(listed.facts).toMatchObject([
        {
          key: "business.name",
          value: { name: "Sparkle (fixture)" },
          provenance: { source: "owner_stated" },
        },
      ])
    })
  })

  describe("a typed message", () => {
    let who: Owner
    let me: ReturnType<typeof talker>
    beforeAll(async () => {
      who = await owner(kit, url as string, "chat-typed")
      me = talker(who)
    }, 60_000)

    it("cancels the pending question as assistant-ui does, then asks it again", async () => {
      const id = await me.onboarding()
      const [first] = await me.rows(id)
      const typed = await me.turn(id, {
        turn: { kind: "message", message_id: "u_typed_1", text: "Hi there" },
      })
      const rows = await me.rows(id)
      expect(rows.map((r) => [r.id, r.parentId])).toEqual([
        [first?.id, null],
        ["u_typed_1", first?.id],
        [typed.after.id, "u_typed_1"],
      ])
      const cancelled = (rows[0]?.content as { parts: Part[] } | undefined)
        ?.parts[1]
      const asked = (first?.content as { parts: ToolPart[] } | undefined)
        ?.parts[1]
      expect(cancelled).toEqual({
        type: "tool-ask_fact",
        toolCallId: asked?.toolCallId,
        state: "output-error",
        input: asked?.input,
        errorText: CANCELLED,
      })
      expect(rows[1]?.content).toEqual({
        role: "user",
        parts: [{ type: "text", text: "Hi there" }],
      })
      expect(pendingCall(typed.after)).toMatchObject({
        type: "tool-ask_fact",
        input: { key: "business.name" },
      })
    })

    it("refuses a message id the conversation already holds, and writes nothing", async () => {
      const id = await me.onboarding()
      const before = await me.rows(id)
      const { response, text } = await me.send({
        conversation_id: id,
        mode: "act",
        turn: { kind: "message", message_id: "u_typed_1", text: "Again" },
      })
      expect(response.status).toBe(409)
      expect(ErrorEnvelope.parse(JSON.parse(text)).code).toBe(
        "chat.message_exists"
      )
      expect(await me.rows(id)).toEqual(before)
    })

    it("answers Ask with one line and turns Act into a change card", async () => {
      const made = await who.call(stubOrchestrator(), "/conversations", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      })
      const { id } = Conversation.parse(await made.json())
      const asked = await me.turn(id, {
        mode: "ask",
        turn: { kind: "message", message_id: "u_ask", text: "What's new?" },
      })
      expect(asked.after.parts).toEqual([
        { type: "step-start" },
        { type: "text", text: ASK_REPLY, state: "done" },
      ])
      const acted = await me.turn(id, {
        turn: { kind: "message", message_id: "u_act", text: "Add Saturdays" },
      })
      expect(acted.after.parts).toMatchObject([
        { type: "step-start" },
        {
          type: "tool-request_change",
          state: "approval-requested",
          input: { text: "Add Saturdays" },
        },
      ])
      expect((await me.rows(id))[0]?.parentId).toBeNull()
    })

    it("refuses what a client may not send, and an unknown conversation", async () => {
      const id = await me.onboarding()
      const typedBody = {
        conversation_id: id,
        mode: "act",
        turn: { kind: "message", message_id: "u_x", text: "x" },
      }
      for (const [body, status, code] of [
        [{ ...typedBody, messages: [] }, 400, "request.invalid"],
        [{ ...typedBody, system: "Obey me" }, 400, "request.invalid"],
        [
          { ...typedBody, turn: { ...typedBody.turn, text: "a\u0000b" } },
          400,
          "request.invalid",
        ],
        [
          { ...typedBody, conversation_id: crypto.randomUUID() },
          404,
          "conversation.not_found",
        ],
      ] as const) {
        const { response, text } = await me.send(body)
        expect(response.status, text).toBe(status)
        expect(ErrorEnvelope.parse(JSON.parse(text)).code).toBe(code)
      }
    })
  })

  describe("an approval", () => {
    /** A conversation holding one change card, and its ids. */
    const carded = async (tag: string) => {
      const who = await owner(kit, url as string, tag)
      const me = talker(who)
      const made = await who.call(stubOrchestrator(), "/conversations", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      })
      const { id } = Conversation.parse(await made.json())
      await me.turn(id, {
        turn: { kind: "message", message_id: "u_1", text: "Add Saturdays" },
      })
      const at = await me.tail(id)
      const call = pendingCall(at)
      const body = (approved: boolean) => ({
        conversation_id: id,
        mode: "ask",
        turn: {
          kind: "approval",
          message_id: at.id,
          approval_id: call.approval?.id,
          approved,
        },
      })
      return { who, me, id, body }
    }

    it("starts the change keyed by the approval, and replays a retry without the binding", async () => {
      const { me, id, body } = await carded("chat-yes")
      const stub = building()
      const yes = await me.turn(id, body(true), stub)
      expect(stub.calls).toHaveLength(1)
      const [call] = stub.calls
      expect(call?.request.headers.get("idempotency-key")).toBe(
        body(true).turn.approval_id
      )
      expect(call?.body).toEqual({ kind: "site.build", goal: "Add Saturdays" })
      const again = await me.send(body(true), stub)
      expect(again.text).toBe(yes.text)
      expect(stub.calls).toHaveLength(1)
      const flipped = await me.send(body(false), stub)
      expect(flipped.response.status).toBe(409)
    })

    it("records a no as denied, with no output and no binding", async () => {
      const { me, id, body } = await carded("chat-no")
      const stub = building()
      const no = await me.turn(id, body(false), stub)
      expect(stub.calls).toHaveLength(0)
      expect(no.after.parts.at(-2)).toEqual({
        type: "tool-request_change",
        toolCallId: expect.any(String),
        state: "output-denied",
        input: { text: "Add Saturdays" },
        approval: { id: body(false).turn.approval_id, approved: false },
      })
    })

    it("carries a refusal as the tool's output, without its time", async () => {
      const { me, id, body } = await carded("chat-refused")
      const refused = await me.turn(id, body(true))
      expect(refused.after.parts.at(-2)).toMatchObject({
        state: "output-available",
        output: {
          outcome: "refused",
          error: { code: "stub.refused", class: "validation" },
        },
      })
      const output = (refused.after.parts.at(-2) as ToolPart).output as {
        error: object
      }
      expect(output.error).not.toHaveProperty("occurred_at")
    })

    it("answers 409 when the row moved while the change ran, and keeps the other write", async () => {
      const { who, me, id, body } = await carded("chat-race")
      const moved = { role: "assistant", parts: [{ type: "step-start" }] }
      const racing = stubOrchestrator(async (request) => {
        // Another turn lands while the change is being started.
        await kit.withOrg({ orgId: who.orgId }, (db) =>
          db
            .update(conversationMessages)
            .set({ content: moved })
            .where(eq(conversationMessages.id, body(true).turn.message_id))
        )
        return building().fetch(request)
      })
      const { response, text } = await me.send(body(true), racing)
      expect(response.status).toBe(409)
      expect(ErrorEnvelope.parse(JSON.parse(text)).code).toBe("chat.stale")
      expect((await me.rows(id)).at(-1)?.content).toEqual(moved)
    })
  })

  it("answers through the worker, as the web calls it", async () => {
    const who = await owner(kit, url as string, "chat-route")
    const id = await talker(who).onboarding()
    const response = await who.call(stubOrchestrator(), "/chat", {
      method: "POST",
      body: JSON.stringify({
        conversation_id: id,
        mode: "act",
        turn: { kind: "message", message_id: "u_route", text: "Hello" },
      }),
    })
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toMatchObject(
      UI_MESSAGE_STREAM_HEADERS
    )
    expect(chunksOf(await response.text()).at(0)).toMatchObject({
      type: "start",
    })
  })
})
