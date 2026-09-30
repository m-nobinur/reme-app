import {
  Conversation,
  ConversationHistory,
  ConversationList,
  ErrorEnvelope,
  FactList,
  type FactRecord,
  type FactValue,
  StaffDirectory,
} from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  eq,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  readUIMessageStream,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  ASK_REPLY,
  CANCELLED,
  chat,
  firstMessage,
  nextStep,
  ONBOARDING_GOAL,
  type Part,
  readScript,
  type Script,
  type ToolPart,
} from "../src/chat.ts"
import {
  type Onboarding,
  onboardingStep,
  opening,
  stepOf,
} from "../src/onboarding.ts"
import {
  type Owner,
  owner,
  type Stub,
  SUFFIX,
  seed,
  stubOrchestrator,
} from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

/** Ids in the order asked for, the same on every run. */
const counter = (prefix = "id") => {
  let n = 0
  return () => `${prefix}${++n}`
}

/**
 * UUID-shaped ids, since the onboarding conversation's id comes from the same
 * source. The namespace is this process's, so a parallel run elsewhere never
 * collides; both script runs here share it, and the first is deleted before
 * the second makes the same ids again.
 */
const NS = crypto.randomUUID().slice(0, 8)
const uuids = () => {
  let n = 0
  return () => `${NS}-0000-4000-8000-${String(++n).padStart(12, "0")}`
}

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110"
const state = (over: Partial<Onboarding> = {}): Onboarding => ({
  orgId: ORG,
  facts: [{ key: "business.name", value: { name: "Brightclean (fixture)" } }],
  passed: [],
  closed: [],
  offered: false,
  builder: null,
  orgName: "Brightclean (fixture)",
  ownerName: "Probe Owner",
  ...over,
})
const script = (over: Partial<Script> = {}): Script => ({
  onboarding: state(),
  message: null,
  newId: counter(),
  ...over,
})

describe("the script's next step", () => {
  it("is onboarding's while it runs, typed message or not", () => {
    const expected = onboardingStep(state(), counter())
    expect(nextStep(script())).toEqual(expected)
    expect(
      nextStep(script({ message: { mode: "act", text: "Just build it" } }))
    ).toEqual(expected)
  })

  it("after onboarding, turns an Act message into a change and answers Ask with one line", () => {
    const act = nextStep(
      script({
        onboarding: null,
        message: { mode: "act", text: "Add Saturdays" },
      })
    )
    expect(act).toMatchObject([
      {
        type: "tool-request_change",
        state: "approval-requested",
        input: { text: "Add Saturdays" },
      },
    ])
    expect(
      nextStep(
        script({ onboarding: null, message: { mode: "ask", text: "Why?" } })
      )
    ).toEqual([{ type: "text", text: ASK_REPLY, state: "done" }])
    expect(nextStep(script({ onboarding: null }))).toEqual([])
  })

  it("makes the first row from the same script: the opener, then the industry card", () => {
    const row = firstMessage(
      {
        orgId: ORG,
        orgName: "Brightclean (fixture)",
        ownerName: "Probe Owner",
      },
      [
        {
          key: "business.name",
          value: { name: "Brightclean (fixture)" },
        } as unknown as FactRecord,
      ],
      counter()
    )
    expect(row).toEqual({
      id: "id2",
      parentId: null,
      format: "ai-sdk/v6",
      content: {
        role: "assistant",
        parts: [{ type: "step-start" }, ...opening(state(), counter())],
      },
    })
    expect(row.content.parts[2]).toMatchObject({
      type: "tool-ask_choice",
      input: { step: "industry" },
    })
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

/** What the owner types or picks for each step of the script. */
const FACTS: Record<string, FactValue> = {
  "business.offerings": {
    key: "business.offerings",
    value: { items: ["Regular cleaning", "Deep cleans"] },
  },
  "business.audience": {
    key: "business.audience",
    value: { text: "Busy families in Fictional Town." },
  },
  "business.overview": {
    key: "business.overview",
    value: { text: "We visit, agree the work, then clean every week." },
  },
  "service_area.text": {
    key: "service_area.text",
    value: { text: "Fictional Town and the villages around it" },
  },
  "business.phone": { key: "business.phone", value: { e164: "+441632960001" } },
  "business.email": {
    key: "business.email",
    value: { address: "hello@brightclean.invalid" },
  },
  "assistant.name": { key: "assistant.name", value: { name: "Robin" } },
  "owner.preferred_name": {
    key: "owner.preferred_name",
    value: { name: "Sam" },
  },
}
const CHOSEN: Record<string, string[]> = {
  industry: ["cleaning"],
  pronouns: ["she_her"],
  tone: ["friendly"],
  build_for_me: ["yes"],
  template: ["classic"],
  palette: ["ocean"],
  font: ["clean_sans"],
  pages: ["services", "about"],
}
/** A card's answer as the web sends it; the tagline and the photos are skipped. */
const answerFor = (card: ToolPart): unknown => {
  const step = stepOf(card) as string
  if (card.type === "tool-ask_choice") {
    return { answer: "chosen", ids: CHOSEN[step], other: null }
  }
  const fact = FACTS[step]
  return fact ? { answer: "stated", fact } : { answer: "skipped" }
}

/** Every fact before the photos, as `/facts` takes them. */
const UP_TO_PHOTOS: FactValue[] = [
  { key: "business.name", value: { name: "Held (fixture)" } },
  {
    key: "business.industry",
    value: { name: "Cleaning and home services", category: "cleaning" },
  },
  ...Object.values(FACTS),
  { key: "business.tagline", value: { tagline: "Fresh homes" } },
  { key: "assistant.pronouns", value: { id: "she_her" } },
  { key: "assistant.tone", value: { id: "friendly" } },
  { key: "site.build_mode", value: { mode: "assistant" } },
  { key: "site.template", value: { id: "classic" } },
  { key: "site.palette", value: { id: "ocean" } },
  { key: "site.font", value: { id: "clean_sans" } },
  { key: "site.pages", value: { ids: ["home", "quote"] } },
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
    const send = async (
      body: unknown,
      stub: Stub = stubOrchestrator(),
      using: Tenancy = kit
    ) => {
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
        using,
        { orgId: who.orgId, session },
        { newId }
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

  /** The call the message waits on, if any. */
  const waiting = (message: UIMessage) =>
    message.parts.find(
      (p) =>
        "toolCallId" in p &&
        (p.state === "input-available" || p.state === "approval-requested")
    ) as unknown as ToolPart | undefined
  const pendingCall = (message: UIMessage) => waiting(message) as ToolPart

  /** Wording varies by org, so a run's bytes are compared with the words taken out. */
  const wordless = (text: string) =>
    text.replace(/"delta":"(?:[^"\\]|\\.)*"/g, '"delta":""')

  /** The whole script through its cards: the build starts on the photo skip. */
  async function onboard(ids: () => string) {
    const who = await owner(kit, url as string, "chat-script", ids)
    const me = talker(who, ids)
    const id = await me.onboarding()
    const bodies: string[] = []
    const stub = building()
    for (let i = 0; i < 30; i++) {
      const at = await me.tail(id)
      const call = waiting(at)
      if (!call) break
      const done = await me.turn(
        id,
        {
          turn: {
            kind: "results",
            message_id: at.id,
            results: [
              {
                kind: "answer",
                tool_call_id: call.toolCallId,
                output: answerFor(call),
              },
            ],
          },
        },
        stub
      )
      bodies.push(wordless(done.text))
    }
    const history = await me.history(id)
    const hash = await sha256(
      bodies.join("") +
        JSON.stringify(
          history.messages.map(
            ({ content: { metadata: _, ...content }, ...m }) => ({
              ...m,
              content: {
                ...content,
                parts: content.parts.map((p) =>
                  p.type === "text" ? { ...p, text: "" } : p
                ),
              },
            })
          )
        )
    )
    const listed = FactList.parse(
      await (await who.call(stubOrchestrator(), "/facts")).json()
    )
    const team = StaffDirectory.parse(
      await (await who.call(stubOrchestrator(), "/staff")).json()
    )
    // Gone, so the next run can make the same ids.
    await kit.withOrg({ orgId: who.orgId }, async (db) => {
      await db
        .delete(conversationMessages)
        .where(eq(conversationMessages.conversationId, id))
      await db.delete(conversations).where(eq(conversations.id, id))
    })
    return {
      id,
      hash,
      final: await Promise.resolve(history.messages.at(-1)),
      facts: listed.facts,
      chief: team.staff.find((m) => m.staff_code === "COS-001")?.display_name,
      stub,
    }
  }

  it("runs the whole script to the same bytes twice, and starts the build itself", async () => {
    const first = await onboard(uuids())
    const second = await onboard(uuids())
    expect(second.hash).toBe(first.hash)
    // The conversation's id came from the same source as every other.
    expect(first.id).toBe(`${NS}-0000-4000-8000-000000000001`)

    // Every answer is the owner's, as the profile page will show them.
    expect(first.facts.map((f) => [f.key, f.provenance.source]).sort()).toEqual(
      [
        "assistant.name",
        "assistant.pronouns",
        "assistant.tone",
        "business.email",
        "business.industry",
        "business.name",
        "business.offerings",
        "business.audience",
        "business.overview",
        "business.phone",
        "owner.preferred_name",
        "service_area.text",
        "site.build_mode",
        "site.font",
        "site.pages",
        "site.palette",
        "site.template",
      ]
        .sort()
        .map((key) => [key, "owner_stated"])
    )

    // The staff directory shows the Chief of Staff by the name the owner gave it.
    expect(first.chief).toBe("Robin")

    // One build, keyed by the conversation, with no second approval.
    expect(first.stub.calls).toHaveLength(1)
    expect(first.stub.calls[0]?.request.headers.get("idempotency-key")).toBe(
      `onboarding:${first.id}`
    )
    expect(first.stub.calls[0]?.body).toEqual({
      kind: "site.build",
      goal: ONBOARDING_GOAL,
    })

    // The build card is resolved, and the transcript ends where no helper sends again.
    const parts = (first.final?.content.parts ?? []) as unknown as Part[]
    expect(parts.slice(-3)).toMatchObject([
      {
        type: "tool-request_change",
        state: "output-available",
        output: { outcome: "started", build: { assignment_id: FIXED_BUILD } },
      },
      { type: "step-start" },
      { type: "text", state: "done" },
    ])
    const messages = [
      { id: "m", role: "assistant", parts } as unknown as UIMessage,
    ]
    expect(
      lastAssistantMessageIsCompleteWithToolCalls({ messages }) ||
        lastAssistantMessageIsCompleteWithApprovalResponses({ messages })
    ).toBe(false)
  }, 180_000)

  describe("an answer", () => {
    let who: Owner
    let me: ReturnType<typeof talker>
    let id: string
    beforeAll(async () => {
      who = await owner(kit, url as string, "chat-answer")
      me = talker(who)
      id = await me.onboarding()
    }, 60_000)

    const answering = async (
      output: unknown,
      over: { message_id?: string; tool_call_id?: string } = {}
    ) => {
      const at = await me.tail(id)
      const { message_id = at.id, ...call } = over
      return me.send({
        conversation_id: id,
        mode: "ask",
        turn: {
          kind: "results",
          message_id,
          results: [
            {
              kind: "answer",
              tool_call_id: pendingCall(at).toolCallId,
              output,
              ...call,
            },
          ],
        },
      })
    }

    it("refuses an option the card did not offer, a fact, and a skip of a step that needs an answer", async () => {
      const before = await me.rows(id)
      for (const output of [
        { answer: "chosen", ids: ["moon"], other: null },
        { answer: "chosen", ids: ["cleaning", "legal"], other: null },
        { answer: "stated", fact: FACTS["business.phone"] },
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

    it("refuses a results turn that resolves more than the one call it waits on", async () => {
      const before = await me.rows(id)
      const at = await me.tail(id)
      const answer = {
        kind: "answer",
        tool_call_id: pendingCall(at).toolCallId,
        output: { answer: "skipped" },
      }
      const { response, text } = await me.send({
        conversation_id: id,
        mode: "ask",
        turn: { kind: "results", message_id: at.id, results: [answer, answer] },
      })
      expect(response.status, text).toBe(409)
      expect(ErrorEnvelope.parse(JSON.parse(text)).code).toBe("chat.stale")
      expect(await me.rows(id)).toEqual(before)
    })

    it("refuses an answer to a call that is not the last step's only pending call", async () => {
      const other = await owner(kit, url as string, "chat-steps")
      const them = talker(other)
      const conversation = await them.onboarding()
      const at = await them.tail(conversation)
      const call = pendingCall(at)
      const store = (parts: unknown[]) =>
        kit.withOrg({ orgId: other.orgId }, (db) =>
          db
            .update(conversationMessages)
            .set({ content: { role: "assistant", parts } })
            .where(eq(conversationMessages.id, at.id))
        )
      for (const parts of [
        // A second call waits in the same step.
        [...at.parts, { ...call, toolCallId: "call_second" }],
        // The call is pending, but a later step opened after it.
        [...at.parts, { type: "step-start" }],
      ]) {
        await store(parts)
        const before = await them.rows(conversation)
        const { response, text } = await them.send({
          conversation_id: conversation,
          mode: "ask",
          turn: {
            kind: "results",
            message_id: at.id,
            results: [
              {
                kind: "answer",
                tool_call_id: call.toolCallId,
                output: { answer: "skipped" },
              },
            ],
          },
        })
        expect(response.status, text).toBe(409)
        expect(ErrorEnvelope.parse(JSON.parse(text)).code).toBe("chat.stale")
        expect(await them.rows(conversation)).toEqual(before)
      }
    })

    it("states the choice as the owner's fact, replays a retry and refuses a change of mind", async () => {
      const at = await me.tail(id)
      const call = pendingCall(at)
      const body = {
        conversation_id: id,
        mode: "act",
        turn: {
          kind: "results",
          message_id: at.id,
          results: [
            {
              kind: "answer",
              tool_call_id: call.toolCallId,
              output: { answer: "chosen", ids: ["cleaning"], other: null },
            },
          ],
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
          results: [
            {
              kind: "answer",
              tool_call_id: call.toolCallId,
              output: { answer: "chosen", ids: ["legal"], other: null },
            },
          ],
        },
      })
      expect(changed.response.status).toBe(409)
      const listed = FactList.parse(
        await (await who.call(stubOrchestrator(), "/facts")).json()
      )
      expect(
        listed.facts.map((f) => [f.key, f.value, f.provenance.source]).sort()
      ).toEqual([
        [
          "business.industry",
          { name: "Cleaning and home services", category: "cleaning" },
          "owner_stated",
        ],
        ["business.name", expect.any(Object), "owner_stated"],
      ])
      // The next step is the next question, in the same row.
      expect(pendingCall(await me.tail(id))).toMatchObject({
        type: "tool-ask_fact",
        input: { key: "business.offerings" },
      })
    })
  })

  describe("a typed message", () => {
    let who: Owner
    let me: ReturnType<typeof talker>
    beforeAll(async () => {
      who = await owner(kit, url as string, "chat-typed")
      me = talker(who)
    }, 60_000)

    it("cancels the pending card as assistant-ui does, and answers it with the owner's words", async () => {
      const id = await me.onboarding()
      const [first] = await me.rows(id)
      const typed = await me.turn(id, {
        turn: {
          kind: "message",
          message_id: "u_typed_1",
          text: "Dog grooming",
        },
      })
      const rows = await me.rows(id)
      expect(rows.map((r) => [r.id, r.parentId])).toEqual([
        [first?.id, null],
        ["u_typed_1", first?.id],
        [typed.after.id, "u_typed_1"],
      ])
      const cancelled = (rows[0]?.content as { parts: Part[] } | undefined)
        ?.parts[2]
      const asked = (first?.content as { parts: ToolPart[] } | undefined)
        ?.parts[2]
      expect(cancelled).toEqual({
        type: "tool-ask_choice",
        toolCallId: asked?.toolCallId,
        state: "output-error",
        input: asked?.input,
        errorText: CANCELLED,
      })
      expect(rows[1]?.content).toEqual({
        role: "user",
        parts: [{ type: "text", text: "Dog grooming" }],
      })
      const listed = FactList.parse(
        await (await who.call(stubOrchestrator(), "/facts")).json()
      )
      expect(
        listed.facts.find((f) => f.key === "business.industry")?.value
      ).toEqual({ name: "Dog grooming", category: null })
      expect(typed.after.parts.slice(1)).toMatchObject([
        { type: "text", state: "done" },
        { type: "tool-ask_fact", input: { key: "business.offerings" } },
      ])
    })

    it("asks again with a gentle line when a typed answer does not fit", async () => {
      const fresh = await owner(kit, url as string, "chat-retry")
      const talk = talker(fresh)
      const set = await fresh.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          facts: [
            FACTS["business.offerings"],
            FACTS["business.audience"],
            FACTS["business.overview"],
            FACTS["service_area.text"],
          ],
        }),
      })
      expect(set.status).toBe(200)
      const id = await talk.onboarding()
      const industry = await talk.turn(id, {
        turn: { kind: "message", message_id: "u_1", text: "cleaning" },
      })
      expect(pendingCall(industry.after)).toMatchObject({
        input: { key: "business.phone" },
      })
      const again = await talk.turn(id, {
        turn: { kind: "message", message_id: "u_2", text: "01632 960001" },
      })
      expect(again.after.parts.slice(1)).toMatchObject([
        { type: "text", text: expect.stringContaining("country code") },
        {
          type: "tool-ask_fact",
          state: "input-available",
          input: pendingCall(industry.after).input,
        },
      ])
      const fixed = await talk.turn(id, {
        turn: { kind: "message", message_id: "u_3", text: "+44 1632 960001" },
      })
      expect(pendingCall(fixed.after)).toMatchObject({
        input: { key: "business.email" },
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

    it("starts the build on a typed skip of the photos, keyed by the conversation", async () => {
      const fresh = await owner(kit, url as string, "chat-photos")
      const talk = talker(fresh)
      const set = await fresh.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ facts: UP_TO_PHOTOS }),
      })
      expect(set.status).toBe(200)
      const id = await talk.onboarding()
      const progress = () =>
        kit.withOrg({ orgId: fresh.orgId }, (db) => readScript(db, id))
      const asked = await talk.turn(id, {
        turn: {
          kind: "message",
          message_id: "u_kind",
          text: "Cleaning and home services",
        },
      })
      expect(pendingCall(asked.after).type).toBe("tool-ask_upload")
      const stub = building()
      const skipped = await talk.turn(
        id,
        {
          mode: "ask",
          turn: { kind: "message", message_id: "u_skip", text: "No thanks" },
        },
        stub
      )
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.request.headers.get("idempotency-key")).toBe(
        `onboarding:${id}`
      )
      expect(skipped.after.parts).toMatchObject([
        { type: "step-start" },
        {
          type: "tool-request_change",
          state: "output-available",
          output: { outcome: "started" },
        },
        { type: "step-start" },
        { type: "text", text: expect.stringContaining("Held (fixture)") },
      ])
      expect(await progress()).toEqual({
        passed: ["upload"],
        closed: ["industry", "upload"],
        offered: true,
        builder: null,
      })
    })

    it("ends on the Skip branch with the builder question and a closing line", async () => {
      const fresh = await owner(kit, url as string, "chat-manual")
      const talk = talker(fresh)
      await fresh.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ facts: UP_TO_PHOTOS.slice(0, -5) }),
      })
      const id = await talk.onboarding()
      const asked = await talk.turn(id, {
        turn: { kind: "message", message_id: "u_kind", text: "cleaning" },
      })
      const card = pendingCall(asked.after)
      expect(card).toMatchObject({ input: { step: "build_for_me" } })
      const skipped = await talk.turn(id, {
        turn: {
          kind: "results",
          message_id: asked.after.id,
          results: [
            {
              kind: "answer",
              tool_call_id: card.toolCallId,
              output: { answer: "chosen", ids: ["skip"], other: null },
            },
          ],
        },
      })
      expect(pendingCall(skipped.after)).toMatchObject({
        input: { step: "manual_builder" },
      })
      const done = await talk.turn(id, {
        turn: { kind: "message", message_id: "u_no", text: "No" },
      })
      expect(done.after.parts).toEqual([
        { type: "step-start" },
        { type: "text", text: expect.any(String), state: "done" },
      ])
      expect(
        await kit.withOrg({ orgId: fresh.orgId }, (db) => readScript(db, id))
      ).toEqual({
        passed: [],
        closed: ["industry", "build_for_me", "manual_builder"],
        offered: false,
        builder: false,
      })
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
        // The contract's shape, but a zone `Intl` does not know.
        [
          { ...typedBody, time_zone: "Mars/Olympus_Mons" },
          400,
          "request.invalid",
        ],
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
          kind: "results",
          message_id: at.id,
          results: [
            {
              kind: "approval",
              approval_id: call.approval?.id,
              approved,
              ...(approved ? {} : { reason: "Not this week." }),
            },
          ],
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
        body(true).turn.results.at(0)?.approval_id
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
        approval: {
          id: body(false).turn.results.at(0)?.approval_id,
          approved: false,
        },
      })
    })

    it("carries a refusal as the tool's output with its class, code and message only", async () => {
      const { who, me, id, body } = await carded("chat-refused")
      // An envelope whose detail holds what the model must never read, and a
      // message past the refusal's cap.
      const leaky = stubOrchestrator(async () =>
        Response.json(
          {
            class: "validation",
            code: "stub.refused",
            message: `Refused. ${"a".repeat(600)}`,
            detail: { org_id: who.orgId, preview: { url: "https://x/?sig=1" } },
            occurred_at: new Date().toISOString(),
          },
          { status: 409 }
        )
      )
      const refused = await me.turn(id, body(true), leaky)
      const { output } = refused.after.parts.at(-2) as ToolPart
      expect(output).toStrictEqual({
        outcome: "refused",
        error: {
          class: "validation",
          code: "stub.refused",
          message: `Refused. ${"a".repeat(600)}`.slice(0, 500),
        },
      })
    })

    it("replays one build for a double-clicked yes", async () => {
      const { me, id, body } = await carded("chat-double")
      const stub = building()
      const kits = [0, 1].map(() => tenancy(url as string, { max: 2 }))
      try {
        const [a, b] = await Promise.all(
          kits.map((own) => me.send(body(true), stub, own))
        )
        // The second click either finds the turn open and is busy, or
        // comes after it and replays it.
        const [first, second] = [a, b].sort(
          (x, y) => (x?.response.status ?? 0) - (y?.response.status ?? 0)
        )
        expect(first?.response.status).toBe(200)
        if (second?.response.status === 409) {
          expect(ErrorEnvelope.parse(JSON.parse(second.text)).code).toBe(
            "chat.busy"
          )
        } else {
          expect(second?.text).toBe(first?.text)
        }
        expect(stub.calls).toHaveLength(1)
        expect(
          (await me.tail(id)).parts.filter((p) => p.type === "step-start")
        ).toHaveLength(2)
      } finally {
        await Promise.all(kits.map((own) => own.close()))
      }
    })

    const typedTurn = (id: string, messageId: string) => ({
      conversation_id: id,
      mode: "act",
      turn: { kind: "message", message_id: messageId, text: "Wait" },
    })

    it("keeps a refused cancel as the card's answer, so the retry calls nothing", async () => {
      const { who, me, id, body } = await carded("chat-not-cancelled")
      // An open review, so the yes replaces it.
      const s = seed(kit, who)
      const reviewing = await s.assignment("awaiting_review")
      await s.approval(reviewing, await s.revision(reviewing, 1), 72)
      const refusal = (code: string) =>
        Response.json(
          {
            class: "validation",
            code,
            message: "Refused.",
            detail: {},
            occurred_at: AT,
          },
          { status: 409 }
        )
      const created = building()
      const refusing = stubOrchestrator((request) => {
        const path = new URL(request.url).pathname
        if (path === "/assignments/") return created.fetch(request)
        return refusal(
          path.endsWith("/cancel") ? "assignment.state" : "approval.gone"
        )
      })
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined)
      try {
        const first = await me.turn(id, body(true), refusing)
        expect(first.after.parts.at(-2)).toMatchObject({
          output: {
            outcome: "refused",
            error: { code: "change.not_cancelled" },
          },
        })
      } finally {
        logged.mockRestore()
      }
      expect(refusing.calls).toHaveLength(3)
      const again = await me.send(body(true), refusing)
      expect(again.response.status).toBe(200)
      expect(refusing.calls).toHaveLength(3)
      await s.state(reviewing, "cancelled")
    })

    it("answers a turn sent while a yes runs with chat.busy at once", async () => {
      const { me, id, body } = await carded("chat-interleave")
      const own = tenancy(url as string, { max: 2 })
      let typed: { response: Response; text: string; ms: number } | undefined
      const racing = stubOrchestrator(async (request) => {
        const started = Date.now()
        const sent = await me.send(
          typedTurn(id, "u_race"),
          stubOrchestrator(),
          own
        )
        typed = { ...sent, ms: Date.now() - started }
        return building().fetch(request)
      })
      try {
        const yes = await me.send(body(true), racing)
        expect(yes.response.status, yes.text).toBe(200)
        expect(typed?.response.status).toBe(409)
        expect(ErrorEnvelope.parse(JSON.parse(typed?.text ?? "")).code).toBe(
          "chat.busy"
        )
        expect(typed?.ms).toBeLessThan(1_000)
        // Once the yes is written the same message goes through.
        const after = await me.send(typedTurn(id, "u_race"))
        expect(after.response.status, after.text).toBe(200)
      } finally {
        await own.close()
      }
    })

    it("is not made busy by a rename in flight", async () => {
      const { who, me, id } = await carded("chat-rename")
      let renamed: () => void = () => undefined
      let release: () => void = () => undefined
      const isRenamed = new Promise<void>((resolve) => {
        renamed = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      // A rename holds the conversation's row until it commits.
      const renaming = kit.withOrg({ orgId: who.orgId }, async (db) => {
        await db
          .update(conversations)
          .set({ title: "Renamed" })
          .where(eq(conversations.id, id))
        renamed()
        await released
      })
      await isRenamed
      const turn = me.send(typedTurn(id, "u_renamed"))
      setTimeout(release, 300)
      await renaming
      const { response, text } = await turn
      expect(response.status, text).toBe(200)
    })

    it("answers 503 on a bridge that never answers, and lets go of the conversation", async () => {
      const { me, id, body } = await carded("chat-hung")
      // The real 10 s, run as 1 s: long enough for the change's reads under
      // load, so the deadline lands on the hung call.
      const timeout = AbortSignal.timeout.bind(AbortSignal)
      const spy = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation(() => timeout(1_000))
      const hung = stubOrchestrator(() => new Promise<never>(() => undefined))
      const before = await me.rows(id)
      try {
        const first = await me.send(body(true), hung)
        expect(first.response.status).toBe(503)
        expect(ErrorEnvelope.parse(JSON.parse(first.text))).toMatchObject({
          class: "transient",
          code: "orchestrator.timeout",
        })
      } finally {
        spy.mockRestore()
      }
      expect(await me.rows(id)).toEqual(before)
      // The lock went with the turn, and the retry runs under the same key.
      const stub = building()
      const retried = await me.send(body(true), stub)
      expect(retried.response.status).toBe(200)
      expect(stub.calls[0]?.request.headers.get("idempotency-key")).toBe(
        hung.calls[0]?.request.headers.get("idempotency-key")
      )
    })

    it("replays when the row moved to this same yes while the change ran", async () => {
      const { who, me, id, body } = await carded("chat-same")
      const at = await me.tail(id)
      const call = pendingCall(at)
      const output = {
        outcome: "started",
        build: {
          assignment_id: FIXED_BUILD,
          kind: "site.build",
          state: "queued",
          goal: "Add Saturdays",
          revision: null,
          created_at: AT,
          updated_at: AT,
        },
      }
      const done = {
        ...call,
        state: "output-available",
        approval: { id: call.approval?.id, approved: true },
        output,
      }
      const moved = {
        role: "assistant",
        parts: [
          ...at.parts.map((p) => (p === (call as unknown) ? done : p)),
          { type: "step-start" },
        ],
      }
      const racing = stubOrchestrator(async (request) => {
        await kit.withOrg({ orgId: who.orgId }, (db) =>
          db
            .update(conversationMessages)
            .set({ content: moved })
            .where(eq(conversationMessages.id, at.id))
        )
        return building().fetch(request)
      })
      const { response, text } = await me.send(body(true), racing)
      expect(response.status, text).toBe(200)
      expect(chunksOf(text)).toContainEqual({
        type: "tool-output-available",
        toolCallId: call.toolCallId,
        output,
      })
      expect((await me.rows(id)).at(-1)?.content).toEqual(moved)
    })

    // Which refusals are kept as the card's answer, and which are a failed
    // request the owner can retry under the same key.
    it.each([
      [
        "a validation refusal",
        409,
        { class: "validation", code: "change.build_busy" },
        true,
      ],
      [
        "the daily cap",
        429,
        { class: "budgetary", code: "builds.daily_cap" },
        true,
      ],
      [
        "a permission refusal",
        403,
        { class: "permission", code: "owner.forbidden" },
        true,
      ],
      [
        "a transient failure",
        503,
        { class: "transient", code: "request.failed" },
        false,
      ],
      [
        "a provider failure",
        502,
        { class: "provider", code: "sandbox.down" },
        false,
      ],
      ["a body off the contract", 500, null, false],
    ] as const)(
      "handles %s (status %s)",
      async (_name, status, envelope, kept) => {
        const { me, id, body } = await carded(`chat-refusal-${status}`)
        const refusing = stubOrchestrator(() =>
          envelope
            ? Response.json(
                {
                  ...envelope,
                  message: "Refused.",
                  detail: {},
                  occurred_at: AT,
                },
                { status }
              )
            : new Response("not json", { status })
        )
        const before = await me.rows(id)
        const first = await me.send(body(true), refusing)
        if (kept) {
          expect(first.response.status).toBe(200)
          expect((await me.tail(id)).parts.at(-2)).toMatchObject({
            output: { outcome: "refused", error: { code: envelope?.code } },
          })
          return
        }
        expect(first.response.status).toBeGreaterThanOrEqual(500)
        expect(await me.rows(id)).toEqual(before)
        // A retry runs the change again, under the same key.
        const stub = building()
        const retried = await me.send(body(true), stub)
        expect(retried.response.status).toBe(200)
        expect(stub.calls[0]?.request.headers.get("idempotency-key")).toBe(
          refusing.calls[0]?.request.headers.get("idempotency-key")
        )
      }
    )

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
