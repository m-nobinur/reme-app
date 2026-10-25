import {
  AskDesignInput,
  Conversation,
  ConversationHistory,
  ConversationList,
  ErrorEnvelope,
  FactList,
  type FactRecord,
  type FactValue,
  ONBOARDING_STATUS,
  StaffDirectory,
} from "@workspace/contracts"
import {
  appendSessionEvent,
  chiefStaffId,
  conversationMessages,
  conversations,
  eq,
  events,
  facts,
  newUlid,
  orgs,
  scheduledJobs,
  sql,
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
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  ASK_REPLY,
  CANCELLED,
  type ChatDeps,
  chat,
  firstMessage,
  nextStep,
  ONBOARDING_GOAL,
  type Part,
  readScript,
  type Script,
  type ToolPart,
} from "../src/chat.ts"
import { DAILY_CAP_USD } from "../src/cos/turns.ts"
import {
  DEFAULT_QUOTE_FIELDS,
  type Onboarding,
  onboardingStep,
  opening,
  stepOf,
} from "../src/onboarding.ts"
import { PLANNER, PLANNER_VERSION } from "../src/onboarding-agent.ts"
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

  it("makes the first row from the same script: the opener alone, text only", () => {
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
      id: "id1",
      parentId: null,
      format: "ai-sdk/v6",
      content: {
        role: "assistant",
        parts: [{ type: "step-start" }, ...opening(state())],
      },
    })
    expect(row.content.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: expect.stringMatching(/\?$/), state: "done" },
    ])
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
  "business.proof": {
    key: "business.proof",
    value: { text: "Ten years trading and fully insured." },
  },
  "service_area.text": {
    key: "service_area.text",
    value: { text: "Fictional Town and the villages around it" },
  },
}
const PHONE: FactValue = {
  key: "business.phone",
  value: { e164: "+441632960001" },
}
/** Each details card's facts, as the owner fills it in. */
const DETAILS: Record<string, FactValue[]> = {
  contact: [
    PHONE,
    { key: "business.email", value: { address: "hello@brightclean.invalid" } },
  ],
  assistant: [
    { key: "assistant.name", value: { name: "Robin" } },
    { key: "assistant.pronouns", value: { id: "she_her" } },
    { key: "assistant.tone", value: { id: "friendly" } },
  ],
}
const CHOSEN: Record<string, string[]> = {
  industry: ["cleaning"],
  build_for_me: ["yes"],
  template: ["classic"],
  palette: ["ocean"],
  font: ["clean_sans"],
  pages: ["services", "about"],
}
/** A card's answer as the web sends it; the photos are skipped. */
const answerFor = (card: ToolPart): unknown => {
  const step = stepOf(card) as string
  if (card.type === "tool-review_quote_form") {
    return { answer: "confirmed", fields: DEFAULT_QUOTE_FIELDS }
  }
  if (card.type === "tool-ask_design") {
    const { questions } = AskDesignInput.parse(card.input)
    // The logo kept on its page (LOGO_HELD); the photos left to the assistant.
    return {
      answers: Object.fromEntries(
        questions.map((q) => [
          q.id,
          q.visual === "logo"
            ? { logo: LOGO }
            : q.visual === "photos"
              ? { photos: [], create: true }
              : q.card.multiple
                ? { choices: [q.card.options[0]?.id] }
                : { choice: q.card.options[0]?.id },
        ])
      ),
      skip_all: false,
    }
  }
  if (card.type === "tool-ask_choice") {
    return { answer: "chosen", ids: CHOSEN[step], other: null }
  }
  if (card.type === "tool-ask_details") {
    return { answer: "stated", facts: DETAILS[step] }
  }
  const fact = FACTS[step]
  return fact ? { answer: "stated", fact } : { answer: "skipped" }
}

/** What the owner types for the steps asked in words: what the business does, then what a quote needs. */
const IN_WORDS = ["Regular cleaning, Deep cleans", "The address and how often"]

/** Every fact before the quote question, as `/facts` takes them. */
const UP_TO_PHOTOS: FactValue[] = [
  { key: "business.name", value: { name: "Held (fixture)" } },
  {
    key: "business.industry",
    value: { name: "Cleaning and home services", category: "cleaning" },
  },
  ...Object.values(FACTS),
  ...(DETAILS.contact as FactValue[]),
  ...(DETAILS.assistant as FactValue[]),
  { key: "site.build_mode", value: { mode: "assistant" } },
  { key: "site.template", value: { id: "classic" } },
  { key: "site.palette", value: { id: "ocean" } },
  { key: "site.font", value: { id: "clean_sans" } },
  { key: "site.pages", value: { ids: ["home", "quote"] } },
]

/** The script's quote form, confirmed: asked right after what sets the business apart. */
const QUOTE_FORM: FactValue = {
  key: "quote.form",
  value: { fields: [...DEFAULT_QUOTE_FIELDS] },
}

/** Every fact before the design, which comes last: the quote form confirmed too. */
const AT_DESIGN: FactValue[] = [...UP_TO_PHOTOS.slice(0, -4), QUOTE_FORM]

/** The logo the tray's logo page kept, which a finished tray needs. */
const LOGO = {
  id: "0d9e0f10-2131-4a2b-9c3d-4e5f60718293",
  name: "logo.png",
  content_type: "image/png",
  bytes: 4821,
  use: "logo",
} as const
const LOGO_HELD = {
  key: "media.uploads",
  value: { items: [LOGO] },
} as FactValue

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
    newId: () => string = () => crypto.randomUUID(),
    deps: Omit<ChatDeps, "newId"> = {}
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
        { newId, ...deps }
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
      // A typed message or a reply is the client's last message, so the
      // stream opens a new one rather than continuing the tail.
      const before =
        body.turn.kind === "message" || body.turn.reply
          ? undefined
          : await tail(conversationId)
      const sent = await send(
        { conversation_id: conversationId, mode: "act", ...body },
        stub
      )
      expect(sent.response.status, sent.text).toBe(200)
      const chunks = chunksOf(sent.text)
      const row = (await rows(conversationId)).at(-1)
      if (!row) throw new Error("the conversation holds no rows")
      const after = asMessage(row)
      const { metadata, ...replayed } = (await replay(
        before,
        chunks
      )) as UIMessage
      expect(plain(replayed)).toStrictEqual(plain(after))
      // A new message carries the time its row was written, as a reload
      // reads it; a continued one keeps the time it already shows.
      if (before) expect(metadata).toBeUndefined()
      else {
        const { createdAt } = (metadata as { custom: { createdAt: string } })
          .custom
        expect(
          Math.abs(Date.parse(createdAt) - row.createdAt.getTime())
        ).toBeLessThan(2000)
      }
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
    /** One typed message. */
    const say = (conversationId: string, message_id: string, text: string) =>
      turn(conversationId, { turn: { kind: "message", message_id, text } })
    /**
     * The onboarding conversation at the industry card: where the business
     * works and for whom already held, the quote form too, and the opener
     * answered in words.
     */
    const atIndustry = async () => {
      const set = await who.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          facts: [
            FACTS["service_area.text"],
            FACTS["business.audience"],
            FACTS["business.proof"],
            QUOTE_FORM,
          ],
        }),
      })
      expect(set.status).toBe(200)
      const id = await onboarding()
      const asked = await say(
        id,
        `u_offer_${crypto.randomUUID()}`,
        IN_WORDS[0] as string
      )
      expect(waitingIn(asked.after)).toMatchObject({
        input: { step: "industry" },
      })
      return id
    }
    /**
     * An org that was on the four design cards when the tray shipped: its
     * conversation already asked one, so it finishes on them.
     */
    /** A card answered earlier in the conversation, as its own row. */
    const answeredEarlier = async (conversationId: string, card: object) => {
      const last = (await rows(conversationId)).at(-1)
      await kit.withOrg({ orgId: who.orgId }, (db) =>
        db.insert(conversationMessages).values({
          conversationId,
          orgId: who.orgId,
          format: "ai-sdk/v6",
          id: crypto.randomUUID(),
          parentId: last?.id ?? null,
          content: {
            role: "assistant",
            parts: [{ type: "step-start" }, card],
          },
        })
      )
    }
    const onOldCards = (conversationId: string) =>
      answeredEarlier(conversationId, {
        type: "tool-ask_choice",
        toolCallId: "earlier_template",
        state: "output-available",
        input: { step: "template" },
        output: { answer: "chosen", ids: ["classic"], other: null },
      })
    /** The photos skipped, so the design, which comes last, is next. */
    const pastPhotos = (conversationId: string) =>
      answeredEarlier(conversationId, {
        type: "tool-ask_upload",
        toolCallId: "earlier_photos",
        state: "output-available",
        input: {},
        output: { answer: "skipped" },
      })
    return {
      send,
      rows,
      tail,
      history,
      turn,
      onboarding,
      say,
      atIndustry,
      onOldCards,
      pastPhotos,
    }
  }

  /** The call a message waits on, if any. */
  function waitingIn(message: UIMessage) {
    return message.parts.find(
      (p) =>
        "toolCallId" in p &&
        (p.state === "input-available" || p.state === "approval-requested")
    ) as unknown as ToolPart | undefined
  }

  /** The call the message waits on, if any. */
  const waiting = (message: UIMessage) =>
    message.parts.find(
      (p) =>
        "toolCallId" in p &&
        (p.state === "input-available" || p.state === "approval-requested")
    ) as unknown as ToolPart | undefined
  const pendingCall = (message: UIMessage) => waiting(message) as ToolPart

  /**
   * Wording varies by org, so a run's bytes are compared with the words
   * taken out, and a wording's sentences, which stream one chunk each, as one.
   */
  const wordless = (text: string) =>
    text
      .replace(/"delta":"(?:[^"\\]|\\.)*"/g, '"delta":""')
      .replace(
        /(data: \{"delta":"","id":"text","type":"text-delta"\}\n\n)+/g,
        "$1"
      )
      // The tray's options are seeded by the org, and its answer picks one.
      .replace(/^data: (\{.*\})$/gm, (_frame, json: string) => {
        const chunk = JSON.parse(json) as {
          input?: { questions?: unknown }
          output?: { answers?: unknown }
        }
        if (chunk.input?.questions) chunk.input = {}
        if (chunk.output?.answers) chunk.output = {}
        return `data: ${JSON.stringify(chunk)}`
      })

  /**
   * The whole script through its cards, with no model: what the business
   * does and what a quote needs are typed, every card is answered, and the
   * build starts on the photo skip. With `replies`, every answer carries the
   * owner's reply, as the web sends it.
   */
  async function onboard(ids: () => string, replies = false) {
    const who = await owner(kit, url as string, "chat-script", ids)
    const me = talker(who, ids)
    const id = await me.onboarding()
    const bodies: string[] = []
    const said: string[] = []
    const words = [...IN_WORDS]
    const stub = building()
    for (let i = 0; i < 30; i++) {
      const at = await me.tail(id)
      const call = waiting(at)
      // An open question is answered in words, as the composer sends them.
      if (!call || call.type === "tool-ask_open") {
        const text = words.shift()
        if (!text) break
        const typed = await me.turn(
          id,
          { turn: { kind: "message", message_id: ids(), text } },
          stub
        )
        said.push(text)
        bodies.push(wordless(typed.text))
        continue
      }
      // The tray's logo page keeps the logo before the tray is answered.
      if (call.type === "tool-ask_design") {
        await who.call(stubOrchestrator(), "/facts", {
          method: "POST",
          headers: { "idempotency-key": ids() },
          body: JSON.stringify({ facts: [LOGO_HELD] }),
        })
      }
      if (replies) said.push(`Answer ${i + 1}`)
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
            ...(replies
              ? { reply: { message_id: ids(), text: `Answer ${i + 1}` } }
              : {}),
          },
        },
        stub
      )
      bodies.push(wordless(done.text))
    }
    const history = await me.history(id)
    const hash = await sha256(
      // The colour card's first four are seeded by the org's id, which each
      // run creates afresh, and each new message carries the time it was
      // written; everything else is the same bytes.
      (
        bodies.join("") +
        JSON.stringify(
          history.messages.map(
            ({ content: { metadata: _, ...content }, ...m }) => ({
              ...m,
              content: {
                ...content,
                parts: content.parts.map((p) =>
                  p.type === "text"
                    ? { ...p, text: "" }
                    : p.type === "tool-ask_design"
                      ? { ...p, input: {}, output: {} }
                      : p
                ),
              },
            })
          )
        )
      )
        .replace(/"initial":\[[^\]]*\]/g, '"initial":[]')
        .replace(/"createdAt":"[^"]*"/g, '"createdAt":""')
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
      messages: history.messages,
      facts: listed.facts,
      chief: team.staff.find((m) => m.staff_code === "COS-001")?.display_name,
      stub,
      said,
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
        "business.phone",
        "business.proof",
        "media.uploads",
        "owner.preferred_name",
        "quote.form",
        "service_area.text",
        "site.build_mode",
        "site.direction",
        "site.font",
        "site.pages",
        "site.palette",
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

  it("with the owner's replies, gives every step and every reply a row of its own", async () => {
    const legacy = await onboard(uuids())
    const replied = await onboard(uuids(), true)
    // The tray's options are seeded by each run's own org, so its picks differ.
    const sameFacts = (list: typeof legacy.facts) =>
      list
        .map((f) => [f.key, f.key.startsWith("site.") ? null : f.value])
        .sort()
    expect(sameFacts(replied.facts)).toEqual(sameFacts(legacy.facts))
    expect(replied.stub.calls).toHaveLength(1)
    // The opening row, then a reply and a step for every answer.
    const { messages } = replied
    const roles = messages.map((m) => m.content.role)
    const asked = legacy.messages
      .flatMap((m) => m.content.parts)
      // An open question is answered in words, which IN_WORDS counts.
      .filter(
        (p) =>
          (p.type.startsWith("tool-ask_") && p.type !== "tool-ask_open") ||
          p.type === "tool-review_quote_form"
      ).length
    expect(asked).toBeGreaterThanOrEqual(9)
    // Every card answer and every typed answer is a message of the owner's.
    expect(roles.filter((role) => role === "user")).toHaveLength(
      asked + IN_WORDS.length
    )
    expect(roles).toEqual([
      "assistant",
      ...Array.from({ length: (roles.length - 1) / 2 }, () => [
        "user",
        "assistant",
      ]).flat(),
    ])
    expect(
      messages
        .filter((m) => m.content.role === "user")
        .map((m) => m.content.parts)
    ).toEqual(replied.said.map((text) => [{ type: "text", text }]))
    for (const [i, m] of messages.entries()) {
      if (m.content.role === "user") {
        expect(m.parent_id).toBe(messages[i - 1]?.id)
        continue
      }
      // Each step asks one card at most, and ends on it, answered, bar the
      // last; the opener and the quote question are asked in words, which
      // close the quote question's card as typed over.
      const cards = m.content.parts.filter(
        (p) =>
          (p.type.startsWith("tool-ask_") && p.type !== "tool-ask_open") ||
          p.type === "tool-review_quote_form" ||
          p.type === "tool-request_change"
      )
      expect(cards.length).toBeLessThanOrEqual(1)
      if (cards.length === 1 && i < messages.length - 1) {
        expect(m.content.parts.at(-1)).toMatchObject({
          state: "output-available",
        })
      }
    }
    expect(replied.final?.content.parts.slice(-3)).toMatchObject([
      {
        type: "tool-request_change",
        state: "output-available",
        output: { outcome: "started" },
      },
      { type: "step-start" },
      { type: "text", state: "done" },
    ])
  }, 180_000)

  describe("an answer", () => {
    let who: Owner
    let me: ReturnType<typeof talker>
    let id: string
    beforeAll(async () => {
      who = await owner(kit, url as string, "chat-answer")
      me = talker(who)
      id = await me.atIndustry()
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
        { answer: "stated", fact: PHONE },
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
      const conversation = await them.atIndustry()
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
        ["business.audience", expect.any(Object), "owner_stated"],
        [
          "business.industry",
          { name: "Cleaning and home services", category: "cleaning" },
          "owner_stated",
        ],
        ["business.name", expect.any(Object), "owner_stated"],
        [
          "business.offerings",
          { items: ["Regular cleaning", "Deep cleans"] },
          "owner_stated",
        ],
        ["business.proof", expect.any(Object), "owner_stated"],
        ["owner.preferred_name", { name: "Probe" }, "owner_stated"],
        ["quote.form", expect.any(Object), "owner_stated"],
        ["service_area.text", expect.any(Object), "owner_stated"],
      ])
      // The next step is the next question, in the same row: the contact
      // card, the sign-in email filled in.
      expect(pendingCall(await me.tail(id))).toMatchObject({
        type: "tool-ask_details",
        input: {
          step: "contact",
          prefill: [
            {
              key: "business.email",
              value: { address: "owner@chat-probe.invalid" },
            },
          ],
          skippable: false,
        },
      })
    })

    it("with the owner's reply, stores it and the next step as rows of their own, once", async () => {
      const at = await me.tail(id)
      const call = pendingCall(at)
      const turn = {
        kind: "results",
        message_id: at.id,
        results: [
          {
            kind: "answer",
            tool_call_id: call.toolCallId,
            output: answerFor(call),
          },
        ],
        reply: { message_id: "reply_offerings", text: "+44 1632 960001" },
      }
      const done = await me.turn(id, { turn })
      // The stream opens the step's row as a new message.
      expect(done.chunks[0]).toEqual({
        type: "start",
        messageId: done.after.id,
      })
      const stored = await me.rows(id)
      const [card, reply, step] = stored.slice(-3)
      expect(card?.id).toBe(at.id)
      // The card's row ends on its answer: no step opens after it.
      const { parts } = (card as unknown as { content: { parts: Part[] } })
        .content
      expect(parts).toHaveLength(at.parts.length)
      expect(parts.at(-1)).toEqual({
        ...call,
        state: "output-available",
        output: answerFor(call),
      })
      expect(reply).toMatchObject({
        id: "reply_offerings",
        parentId: at.id,
        content: {
          role: "user",
          parts: [{ type: "text", text: "+44 1632 960001" }],
        },
      })
      expect(step?.parentId).toBe("reply_offerings")
      expect(pendingCall(done.after)).toMatchObject({
        type: "tool-ask_details",
        input: { step: "assistant" },
      })

      const again = await me.send({ conversation_id: id, mode: "act", turn })
      expect(again.response.status, again.text).toBe(409)
      expect(ErrorEnvelope.parse(JSON.parse(again.text)).code).toBe(
        "chat.message_exists"
      )
      expect(await me.rows(id)).toEqual(stored)
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
      const id = await me.atIndustry()
      const before = await me.rows(id)
      const carded = before.at(-1)
      const typed = await me.say(id, "u_typed_1", "Dog grooming")
      const rows = await me.rows(id)
      expect(rows.slice(-3).map((r) => [r.id, r.parentId])).toEqual([
        [carded?.id, before.at(-2)?.id],
        ["u_typed_1", carded?.id],
        [typed.after.id, "u_typed_1"],
      ])
      const asked = (carded?.content as { parts: ToolPart[] } | undefined)
        ?.parts[2]
      expect(
        (rows.at(-3)?.content as { parts: Part[] } | undefined)?.parts[2]
      ).toEqual({
        type: "tool-ask_choice",
        toolCallId: asked?.toolCallId,
        state: "output-error",
        input: asked?.input,
        errorText: CANCELLED,
      })
      expect(rows.at(-2)?.content).toEqual({
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
        { type: "tool-ask_details", input: { step: "contact" } },
      ])
    })

    it("reads a typed answer to the opener as what the business does, with no model", async () => {
      const fresh = await owner(kit, url as string, "chat-opener")
      const talk = talker(fresh)
      const id = await talk.onboarding()
      const [first] = await talk.rows(id)
      expect(
        (first?.content as { parts: Part[] } | undefined)?.parts
      ).toHaveLength(2)
      const typed = await talk.say(
        id,
        "u_open",
        "Weddings, proms; airport runs"
      )
      expect(
        FactList.parse(
          await (await fresh.call(stubOrchestrator(), "/facts")).json()
        ).facts.find((f) => f.key === "business.offerings")?.value
      ).toEqual({ items: ["Weddings", "proms", "airport runs"] })
      expect(pendingCall(typed.after)).toMatchObject({
        type: "tool-ask_fact",
        input: { key: "service_area.text" },
      })
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
            FACTS["business.proof"],
            FACTS["service_area.text"],
            QUOTE_FORM,
          ],
        }),
      })
      expect(set.status).toBe(200)
      const id = await talk.onboarding()
      // The opener's question is answered already, so the industry card follows.
      const opened = await talk.say(id, "u_0", "Hello")
      expect(pendingCall(opened.after)).toMatchObject({
        input: { step: "industry" },
      })
      const industry = await talk.say(id, "u_1", "cleaning")
      expect(pendingCall(industry.after)).toMatchObject({
        input: { step: "contact" },
      })
      const again = await talk.say(id, "u_2", "01632 960001")
      expect(again.after.parts.slice(1)).toMatchObject([
        { type: "text", text: expect.stringContaining("country code") },
        {
          type: "tool-ask_details",
          state: "input-available",
          input: pendingCall(industry.after).input,
        },
      ])
      const fixed = await talk.say(id, "u_3", "+44 1632 960001")
      // The number is held; the card asks again for the email, filled in.
      expect(pendingCall(fixed.after)).toMatchObject({
        input: {
          step: "contact",
          prefill: [
            PHONE,
            {
              key: "business.email",
              value: { address: "owner@chat-probe.invalid" },
            },
          ],
        },
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

    it("offers its own quote form for a typed answer no model read, and builds once it is confirmed", async () => {
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
      const asked = await talk.say(id, "u_quote", "The address and how often")
      const form = pendingCall(asked.after)
      expect(form).toMatchObject({
        type: "tool-review_quote_form",
        input: { fields: DEFAULT_QUOTE_FIELDS },
      })
      const stub = building()
      const confirmed = await talk.turn(
        id,
        {
          turn: {
            kind: "results",
            message_id: asked.after.id,
            results: [
              {
                kind: "answer",
                tool_call_id: form.toolCallId,
                output: { answer: "confirmed", fields: DEFAULT_QUOTE_FIELDS },
              },
            ],
          },
        },
        stub
      )
      // The look is held from the old cards and the photos are a tray
      // question, so the confirmed form starts the build.
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.request.headers.get("idempotency-key")).toBe(
        `onboarding:${id}`
      )
      expect(confirmed.after.parts.slice(-3)).toMatchObject([
        {
          type: "tool-request_change",
          state: "output-available",
          output: { outcome: "started" },
        },
        { type: "step-start" },
        { type: "text", text: expect.stringContaining("Held (fixture)") },
      ])
      expect(await progress()).toEqual({
        passed: [],
        closed: ["quote_form"],
        offered: true,
        builder: null,
      })
    })

    it("ends on the Skip branch with a closing line", async () => {
      const fresh = await owner(kit, url as string, "chat-manual")
      const talk = talker(fresh)
      await fresh.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          facts: [...UP_TO_PHOTOS.slice(0, -5), QUOTE_FORM],
        }),
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
      // The builder question is no longer asked: the row ends on the closing line.
      expect(skipped.after.parts.slice(-2)).toEqual([
        { type: "step-start" },
        { type: "text", text: expect.any(String), state: "done" },
      ])
      expect(
        await kit.withOrg({ orgId: fresh.orgId }, (db) => readScript(db, id))
      ).toEqual({
        passed: [],
        closed: ["build_for_me"],
        offered: false,
        builder: null,
        siteSkipped: true,
      })
    })

    it("stores the browser's zone on a turn, and moves the org's recurring jobs only when it changes", async () => {
      const fresh = await owner(kit, url as string, "chat-zone")
      const talk = talker(fresh)
      const id = await talk.onboarding()
      const zoneOf = () =>
        kit.withOrg({ orgId: fresh.orgId }, async (db) => ({
          zone: (await db.select({ z: orgs.timeZone }).from(orgs))[0]?.z,
          next: (
            await db.select({ at: scheduledJobs.nextRunAt }).from(scheduledJobs)
          )[0]?.at.toISOString(),
        }))
      // Signup made the heartbeat; daily at 09:00 in the org's zone.
      await kit.withOrg({ orgId: fresh.orgId }, (db) =>
        db
          .update(scheduledJobs)
          .set({
            rule: "0 9 * * *",
            nextRunAt: new Date(Date.now() + 30 * 86_400_000),
          })
          .where(eq(scheduledJobs.kind, "heartbeat"))
      )
      const turn = (n: number, time_zone?: string) =>
        talk.send({
          conversation_id: id,
          mode: "act",
          turn: {
            kind: "message",
            message_id: `u_zone_${n}`,
            text: "Weddings",
          },
          ...(time_zone && { time_zone }),
        })

      expect((await turn(1, "Asia/Tokyo")).response.status).toBe(200)
      const tokyo = await zoneOf()
      expect(tokyo.zone).toBe("Asia/Tokyo")
      // 09:00 in Tokyo is 00:00 UTC.
      expect(tokyo.next).toMatch(/T00:00:00\.000Z$/)

      // A turn with no zone keeps the stored one and moves nothing.
      expect((await turn(2)).response.status).toBe(200)
      expect(await zoneOf()).toEqual(tokyo)

      expect((await turn(3, "America/New_York")).response.status).toBe(200)
      const york = await zoneOf()
      expect(york.zone).toBe("America/New_York")
      expect(york.next).toMatch(/T1[34]:00:00\.000Z$/)
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
      // A live site with an open review, so the yes replaces it; before the
      // first publish a change revises the draft instead.
      const s = seed(kit, who)
      const live = await s.assignment("published")
      const served = await s.revision(live, 1)
      await s.deployment(served, await s.approval(live, served, 1, true))
      const reviewing = await s.assignment("awaiting_review")
      await s.approval(reviewing, await s.revision(reviewing, 2), 72)
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

  describe("the onboarding planner", () => {
    /**
     * A planner model that streams each call's plan, keys in the order the
     * instructions ask for, five characters a chunk, or throws. With `drop`,
     * the stream fails once the plan is written, as a provider that drops
     * the connection does.
     */
    const planner = (answers: (object | Error)[], drop = false) => {
      const calls: string[] = []
      const model = new MockLanguageModelV4({
        // The background copy call is not streamed: its answer as given.
        doGenerate: async (options) => {
          const answer = answers[calls.length] ?? answers.at(-1)
          calls.push(JSON.stringify(options.prompt))
          if (answer instanceof Error) throw answer
          return {
            content: [{ type: "text" as const, text: JSON.stringify(answer) }],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: {
                total: 5000,
                noCache: 5000,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 400, text: 400, reasoning: undefined },
            },
            warnings: [],
          }
        },
        doStream: async (options) => {
          const answer = answers[calls.length] ?? answers.at(-1)
          calls.push(JSON.stringify(options.prompt))
          if (answer instanceof Error) throw answer
          const p = answer as Record<string, unknown>
          const text = JSON.stringify({
            pending_card: p.pending_card,
            facts: p.facts,
            chosen_for_owner: p.chosen_for_owner,
            next: p.next,
            say: p.say,
          })
          const deltas = text.match(/[\s\S]{1,5}/g) ?? []
          const parts: Record<string, unknown>[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            ...deltas.map((delta) => ({ type: "text-delta", id: "t", delta })),
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: {
                  total: 5000,
                  noCache: 5000,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 400, text: 400, reasoning: undefined },
              },
            },
          ]
          if (drop) {
            parts.splice(-2, 2, { type: "error", error: new Error("dropped") })
          }
          return { stream: convertArrayToReadableStream(parts) as never }
        },
      })
      return { model, calls }
    }
    const plan = (over: object) => ({
      facts: {},
      chosen_for_owner: [],
      pending_card: null,
      say: "Thank you.",
      next: { kind: "answer_only" },
      ...over,
    })
    const logged = (who: Owner, id: string) =>
      kit.withOrg({ orgId: who.orgId }, (db) =>
        db
          .select({
            type: events.type,
            payload: events.payload,
            taint: events.taint,
          })
          .from(events)
          .where(eq(events.sessionId, id))
          .orderBy(events.seq)
      )
    const factsOf = async (who: Owner) =>
      FactList.parse(
        await (await who.call(stubOrchestrator(), "/facts")).json()
      ).facts
    const answer = (at: UIMessage, output: unknown) => ({
      turn: {
        kind: "results",
        message_id: at.id,
        results: [
          {
            kind: "answer",
            tool_call_id: pendingCall(at).toolCallId,
            output,
          },
        ],
      },
    })

    it("reads a long first reply to the opener, states its facts, infers the industry and logs the call as a turn", async () => {
      const who = await owner(kit, url as string, "chat-planner")
      const { model, calls } = planner([
        plan({
          facts: {
            "business.industry": {
              name: "Limousine hire",
              category: "chauffeur",
            },
            "business.offerings": { items: ["Weddings", "Proms"] },
            "business.phone": { e164: "+447700900412" },
          },
          say: "Weddings and proms, lovely. Who books you most?",
          next: { kind: "ask_open", about: "business.audience" },
        }),
      ])
      const me = talker(who, undefined, { planner: model })
      const id = await me.onboarding()
      const [first] = await me.rows(id)
      const text =
        "We're a limo firm in Manchester, weddings and proms. Call 07700 900 412."
      const done = await me.turn(id, {
        turn: { kind: "message", message_id: "u_plan_1", text },
      })
      expect(calls).toHaveLength(1)
      // Streamed: the response opens at once under the stored row's id,
      // reserved before the model runs, and the message arrives as the model
      // writes it, a sentence at a time. The id never changes mid-stream: a
      // second one made the client draw the reply twice.
      expect(done.chunks[0]).toEqual({
        type: "start",
        messageId: done.after.id,
      })
      expect(done.chunks.filter((c) => c.type === "start")).toHaveLength(1)
      expect(
        done.chunks
          .filter((c) => c.type === "text-delta")
          .map((c) => (c as { delta: string }).delta)
      ).toEqual(["Weddings and proms, lovely.", " Who books you most?"])
      expect(done.chunks.slice(-2)).toEqual([
        { type: "finish-step" },
        { type: "finish" },
      ])
      // The owner's words reach the model only inside the data block.
      expect(calls[0]).toContain('data source=\\"onboarding\\"')
      expect(calls[0]).not.toContain(who.orgId)
      // The opener held no card; ask_open docks its question in the tray.
      const rows = await me.rows(id)
      expect(rows.map((r) => r.id)).toEqual([
        first?.id,
        "u_plan_1",
        done.after.id,
      ])
      expect(rows[0]?.content).toEqual(first?.content)
      expect(done.after.parts).toMatchObject([
        { type: "step-start" },
        {
          type: "text",
          text: "Weddings and proms, lovely. Who books you most?",
          state: "done",
        },
        {
          type: "tool-ask_open",
          state: "input-available",
          input: { about: "business.audience" },
        },
      ])
      // Sign-up wrote the business name and the owner's first name.
      const stated = await factsOf(who)
      expect(
        stated
          .filter(
            (f) => f.key !== "business.name" && f.key !== "owner.preferred_name"
          )
          .map((f) => [f.key, f.provenance.source])
          .sort()
      ).toEqual([
        ["business.industry", "inferred"],
        ["business.offerings", "owner_stated"],
        ["business.phone", "owner_stated"],
      ])
      // Logged as a CoS turn: its instructions, its data, the call, the answer, the close.
      const log = await logged(who, id)
      expect(log.map((e) => e.type)).toEqual([
        "cos.prefix",
        "cos.context",
        "cos.call",
        "cos.step",
        "cos.turn",
      ])
      expect(log[1]?.payload).toMatchObject({
        context_policy_version: PLANNER_VERSION,
        active_tools: [],
        text: expect.stringContaining("limo firm"),
      })
      expect(log[1]?.taint).toEqual(["untrusted_input"])
      expect(log[4]?.payload).toMatchObject({
        outcome: "answered",
        steps: 1,
        cost_usd: expect.any(Number),
      })
      expect(
        (log[4]?.payload as { cost_usd: number } | undefined)?.cost_usd
      ).toBeGreaterThan(0)
      // Typed instead of answered in the tray, it is the waiting card.
      const next = planner([
        plan({
          pending_card: "answered",
          facts: { "business.audience": { text: "Couples" } },
          say: "Couples, got it. Where do you cover?",
          next: { kind: "ask_open", about: "service_area.text" },
        }),
      ])
      await talker(who, undefined, { planner: next.model }).turn(id, {
        turn: { kind: "message", message_id: "u_plan_2", text: "Couples" },
      })
      expect(next.calls).toHaveLength(1)
      expect(next.calls[0]).toContain(
        '\\"waiting_card\\":{\\"card\\":\\"ask_open\\",\\"about\\":\\"business.audience\\"}'
      )
    }, 60_000)

    it("keeps the owner's message at the time it was sent, though its row is written after the planner", async () => {
      const who = await owner(kit, url as string, "chat-sent-at")
      const { model } = planner([
        plan({
          facts: {},
          say: "Lovely. Who books you most?",
          next: { kind: "ask_open", about: "business.audience" },
        }),
      ])
      const me = talker(who, undefined, { planner: model })
      const id = await me.onboarding()
      // The api's clock, ten minutes behind the database's: a row written
      // with the database's `now()` cannot pass for the time it arrived.
      const sent = new Date(Date.now() - 10 * 60_000)
      vi.useFakeTimers({ toFake: ["Date"], now: sent })
      try {
        const done = await me.send({
          conversation_id: id,
          mode: "act",
          turn: { kind: "message", message_id: "u_sent_at", text: "Hello" },
        })
        expect(done.response.status, done.text).toBe(200)
      } finally {
        vi.useRealTimers()
      }
      const row = (await me.rows(id)).find((r) => r.id === "u_sent_at")
      expect(row?.createdAt.toISOString()).toBe(sent.toISOString())
      const reloaded = (await me.history(id)).messages.find(
        (m) => m.id === "u_sent_at"
      )
      expect(reloaded?.content.metadata).toEqual({
        custom: { createdAt: sent.toISOString() },
      })
    }, 60_000)

    it("shows the waiting card again after a side question, and answers a card with no model", async () => {
      const who = await owner(kit, url as string, "chat-side")
      await who.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ facts: AT_DESIGN }),
      })
      const opened = talker(who)
      const id = await opened.onboarding()
      await opened.pastPhotos(id)
      await opened.onOldCards(id)
      // The script's card for the layout, from a typed industry.
      const asked = await opened.turn(id, {
        turn: { kind: "message", message_id: "u_side_0", text: "cleaning" },
      })
      const card = pendingCall(asked.after)
      expect(card.input).toMatchObject({ step: "template" })
      const side = planner([
        plan({
          pending_card: "unanswered",
          say: "Yes, you can change it later. Which layout suits you?",
        }),
      ])
      const aside = await talker(who, undefined, { planner: side.model }).turn(
        id,
        {
          turn: {
            kind: "message",
            message_id: "u_side_1",
            text: "can I change this later?",
          },
        }
      )
      const again = pendingCall(aside.after)
      expect(again.toolCallId).not.toBe(card.toolCallId)
      expect(again.input).toEqual(card.input)
      // The card's answer and what follows are the script's: no model call.
      const next = planner([plan({ say: "never sent" })])
      const picked = await talker(who, undefined, { planner: next.model }).turn(
        id,
        answer(aside.after, { answer: "chosen", ids: ["bold"], other: null })
      )
      expect(next.calls).toHaveLength(0)
      expect(picked.after.parts.slice(-4)).toMatchObject([
        { type: "tool-ask_choice", state: "output-available" },
        { type: "step-start" },
        { type: "text", state: "done" },
        {
          type: "tool-ask_choice",
          state: "input-available",
          input: { step: "palette" },
        },
      ])
      expect(
        (await factsOf(who)).find((f) => f.key === "site.template")?.value
      ).toEqual({ id: "bold" })
    }, 60_000)

    it("answers a typed reply to a card by code when Jev is sure, and leaves the rest to the planner", async () => {
      const who = await owner(kit, url as string, "chat-jev")
      await who.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ facts: AT_DESIGN }),
      })
      const id = await talker(who).onboarding()
      await talker(who).pastPhotos(id)
      await talker(who).onOldCards(id)
      const asked = await talker(who).say(id, "u_jev_0", "ok")
      const card = pendingCall(asked.after)
      expect(card.input).toMatchObject({ step: "template" })
      const seen: { card: ToolPart; asked: string; reply: string }[] = []
      const gate =
        (decision: Awaited<ReturnType<NonNullable<ChatDeps["jev"]>>>) =>
        async (c: ToolPart, q: string, reply: string) => {
          seen.push({ card: c, asked: q, reply })
          return decision
        }
      const unused = planner([plan({ say: "never sent" })])
      // Sure of an option: the script picks it, and no planner is called.
      const bold = await talker(who, undefined, {
        planner: unused.model,
        jev: gate({ kind: "answer", option: "bold" }),
      }).say(id, "u_jev_1", "The bold one, please")
      expect(seen.at(-1)).toMatchObject({
        card: { toolCallId: card.toolCallId },
        asked: expect.stringContaining("?"),
        reply: "The bold one, please",
      })
      expect(unused.calls).toHaveLength(0)
      expect(
        (await factsOf(who)).find((f) => f.key === "site.template")
      ).toMatchObject({
        value: { id: "bold" },
        provenance: { source: "owner_stated" },
      })
      expect(pendingCall(bold.after).input).toMatchObject({ step: "palette" })
      // Left to the assistant: it picks, says so, and records it as its own.
      const picked = await talker(who, undefined, {
        planner: unused.model,
        jev: gate({ kind: "defer" }),
      }).say(id, "u_jev_2", "You pick")
      expect(unused.calls).toHaveLength(0)
      const palette = (await factsOf(who)).find((f) => f.key === "site.palette")
      expect(palette?.provenance.source).toBe("inferred")
      expect(picked.after.parts[1]).toMatchObject({
        type: "text",
        text: expect.stringContaining("colours"),
      })
      expect(pendingCall(picked.after).input).toMatchObject({ step: "font" })
      // Unsure: the planner reads the words.
      const read = planner([
        plan({
          pending_card: "unanswered",
          say: "Good question. Which lettering do you like?",
        }),
      ])
      await talker(who, undefined, {
        planner: read.model,
        jev: gate(null),
      }).say(id, "u_jev_3", "what's the difference between them?")
      expect(read.calls).toHaveLength(1)
    }, 60_000)

    /** Spends the org's daily cap in its session log, so no planner call fits. */
    const spendCap = async (who: Owner, id: string) => {
      await kit.withOrg({ orgId: who.orgId }, async (db) => {
        const chief = await chiefStaffId(db)
        const turnId = newUlid()
        for (const [type, payload] of [
          [
            "cos.context",
            {
              turn_id: turnId,
              prefix_sha256: "a".repeat(64),
              context_policy_version: "4",
              mode: "ask",
              active_tools: [],
              text: "x",
              reserved_usd: 0,
            },
          ],
          [
            "cos.turn",
            {
              outcome: "answered",
              turn_id: turnId,
              model: "m",
              usage: {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
              },
              cost_usd: DAILY_CAP_USD,
              tools: [],
              steps: 1,
              first_chunk_ms: 1,
            },
          ],
        ] as const) {
          await appendSessionEvent(db, {
            orgId: who.orgId,
            staffId: chief as string,
            assignmentId: null,
            sessionId: id,
            type,
            payload,
            taint: [],
          })
        }
      })
    }

    describe("the design tray", () => {
      /** An org on the tray, asked after its industry and the website question. */
      const atTray = async (name: string) => {
        const who = await owner(kit, url as string, name)
        await who.call(stubOrchestrator(), "/facts", {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ facts: [...AT_DESIGN, LOGO_HELD] }),
        })
        const id = await talker(who).onboarding()
        await talker(who).pastPhotos(id)
        const asked = await talker(who).say(id, `u_${name}_0`, "ok")
        const card = pendingCall(asked.after)
        expect(card.type).toBe("tool-ask_design")
        return {
          who,
          id,
          card,
          at: asked.after,
          tray: AskDesignInput.parse(card.input),
        }
      }

      it("states an answer as the owner leaves its question, and stays open for the rest", async () => {
        const { who, id, card, at, tray } = await atTray("chat-tray-partial")
        const option = tray.questions[1]?.card.options[0]?.id as string
        const sent = await talker(who).send({
          conversation_id: id,
          mode: "act",
          ...answer(at, {
            answers: { palette: { choice: option } },
            skip_all: false,
          }),
        })
        expect(sent.response.status, sent.text).toBe(204)
        expect(
          (await factsOf(who)).find((f) => f.key === "site.palette")
        ).toMatchObject({
          value: { id: option },
          provenance: { source: "owner_stated" },
        })
        // The card still waits, and opens ticked, so the tray resumes after a reload.
        const waitingCall = pendingCall(await talker(who).tail(id))
        expect(waitingCall.toolCallId).toBe(card.toolCallId)
        expect(
          AskDesignInput.parse(waitingCall.input).questions[1]?.card.preselected
        ).toEqual([option])
        // An answer the question never offered is refused.
        const bad = await talker(who).send({
          conversation_id: id,
          mode: "act",
          ...answer(at, {
            answers: { palette: { choice: "not_a_palette" } },
            skip_all: false,
          }),
        })
        expect(bad.response.status).toBe(400)
      }, 60_000)

      it("answers a reply that is one option's label by code, and shows the tray again ticked", async () => {
        const { who, id, tray } = await atTray("chat-tray-typed")
        const pair = tray.questions[2]?.card.options[0]
        const unused = planner([plan({ say: "never sent" })])
        const typed = await talker(who, undefined, {
          planner: unused.model,
        }).say(id, "u_tray_typed", pair?.label as string)
        expect(unused.calls).toHaveLength(0)
        expect(
          (await factsOf(who)).find((f) => f.key === "site.font")?.value
        ).toEqual({ id: pair?.id })
        const again = pendingCall(typed.after)
        expect(again.type).toBe("tool-ask_design")
        expect(
          AskDesignInput.parse(again.input).questions[2]?.card.preselected
        ).toEqual([pair?.id])
      }, 60_000)

      it("finishes on Build my site, and Skip all leaves the look to the builder", async () => {
        const done = await atTray("chat-tray-done")
        const picks = Object.fromEntries(
          done.tray.questions.map((q) => [
            q.id,
            q.visual === "logo"
              ? { logo: LOGO }
              : q.visual === "photos"
                ? { photos: [], create: true }
                : q.card.multiple
                  ? { choices: [q.card.options[0]?.id] }
                  : { choice: q.card.options[0]?.id },
          ])
        )
        // The orchestrator snapshots the facts over its own connection, so
        // the tray's answer must be committed before the build starts.
        const seen: string[] = []
        const build = building()
        const orchestrator = stubOrchestrator(async (request) => {
          const held = await kit.withOrg({ orgId: done.who.orgId }, (db) =>
            db
              .select({ key: facts.key })
              .from(facts)
              .where(sql`${facts.validTo} is null`)
          )
          seen.push(...held.map((f) => f.key))
          return build.fetch(request)
        })
        const built = await talker(done.who).turn(
          done.id,
          answer(done.at, { answers: picks, skip_all: false }),
          orchestrator
        )
        expect(orchestrator.calls).toHaveLength(1)
        expect(
          built.after.parts.find((p) => p.type === "tool-ask_design")
        ).toMatchObject({ state: "output-available" })
        expect(built.after.parts.slice(-3)).toMatchObject([
          {
            type: "tool-request_change",
            state: "output-available",
            output: { outcome: "started" },
          },
          { type: "step-start" },
          { type: "text", state: "done" },
        ])
        for (const key of [
          "site.palette",
          "site.font",
          "site.direction",
          "site.pages",
        ]) {
          expect(seen).toContain(key)
        }
        const skip = await atTray("chat-tray-skip")
        const skipped = await talker(skip.who).turn(
          skip.id,
          answer(skip.at, { answers: {}, skip_all: true })
        )
        expect(
          skipped.after.parts.find((p) => p.type === "tool-ask_design")
        ).toMatchObject({ state: "output-available" })
        const held = await factsOf(skip.who)
        expect(held.find((f) => f.key === "site.direction")?.value).toEqual({
          id: "builder",
        })
        expect(held.find((f) => f.key === "site.palette")).toBeUndefined()
      }, 60_000)
    })

    describe("racing Jev with the planner", () => {
      /** An org at the layout card, with a typed reply's turn ready to send. */
      const atTemplate = async (name: string) => {
        const who = await owner(kit, url as string, name)
        await who.call(stubOrchestrator(), "/facts", {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ facts: AT_DESIGN }),
        })
        const id = await talker(who).onboarding()
        await talker(who).pastPhotos(id)
        await talker(who).onOldCards(id)
        const asked = await talker(who).say(id, `u_${name}_0`, "ok")
        expect(pendingCall(asked.after).input).toMatchObject({
          step: "template",
        })
        return { who, id, card: pendingCall(asked.after) }
      }
      /**
       * A planner that streams `wrote` and holds its finish until `held`
       * settles, or with no answer, waits until it is stopped. `started`
       * settles once it is called.
       */
      const racer = (wrote: object | null, held?: Promise<unknown>) => {
        const base = planner([wrote ?? {}])
        let called = (): void => undefined
        const started = new Promise<void>((resolve) => {
          called = resolve
        })
        const model = new MockLanguageModelV4({
          doStream: async (options) => {
            called()
            if (!wrote) {
              base.calls.push(JSON.stringify(options.prompt))
              await new Promise((_, reject) =>
                options.abortSignal?.addEventListener("abort", () =>
                  reject(options.abortSignal?.reason)
                )
              )
            }
            const { stream, ...rest } = await base.model.doStream(options)
            return {
              ...rest,
              stream: stream.pipeThrough(
                new TransformStream({
                  async transform(part, out) {
                    if (part.type === "finish") await held
                    out.enqueue(part)
                  },
                })
              ),
            }
          },
        })
        return { model, calls: base.calls, started }
      }
      const lastTurn = async (who: Owner, id: string) =>
        (await logged(who, id)).filter((e) => e.type === "cos.turn").at(-1)
          ?.payload as { outcome: string; cost_usd: number } | undefined

      it("answers an exact option or a plain deferral in code, with no Jev and no planner", async () => {
        const { who, id } = await atTemplate("chat-exact")
        const asked: string[] = []
        const unused = planner([plan({ say: "never sent" })])
        const deps = {
          planner: unused.model,
          jev: async (_c: ToolPart, _q: string, reply: string) => {
            asked.push(reply)
            return null
          },
        }
        const bold = await talker(who, undefined, deps).say(
          id,
          "u_ex_1",
          "Bold."
        )
        expect(pendingCall(bold.after).input).toMatchObject({ step: "palette" })
        expect(
          (await factsOf(who)).find((f) => f.key === "site.template")?.value
        ).toEqual({ id: "bold" })
        const picked = await talker(who, undefined, deps).say(
          id,
          "u_ex_2",
          "Up to you"
        )
        expect(pendingCall(picked.after).input).toMatchObject({ step: "font" })
        expect(asked).toEqual([])
        expect(unused.calls).toHaveLength(0)
      }, 60_000)

      it("stops the planner when Jev is sure before a word shows, and the script answers", async () => {
        const { who, id, card } = await atTemplate("chat-gated")
        const hung = racer(null)
        const sent = await talker(who, undefined, {
          planner: hung.model,
          jev: async () => {
            await hung.started
            return { kind: "answer", option: "modern" }
          },
        }).say(id, "u_gated_1", "The modern one, please")
        expect(hung.calls).toHaveLength(1)
        expect(pendingCall(sent.after).input).toMatchObject({ step: "palette" })
        expect(sent.chunks.filter((c) => c.type === "start-step")).toHaveLength(
          1
        )
        expect(
          (await factsOf(who)).find((f) => f.key === "site.template")
        ).toMatchObject({
          value: { id: "modern" },
          provenance: { source: "owner_stated" },
        })
        const ended = await lastTurn(who, id)
        expect(ended?.outcome).toBe("gated")
        // The stopped call is charged at its worst, so the reservation closes.
        expect(ended?.cost_usd).toBeGreaterThan(0)
        expect(card.toolCallId).not.toBe(pendingCall(sent.after).toolCallId)
      }, 60_000)

      it("keeps the planner's answer once its words have shown, and when Jev is unsure", async () => {
        const { who, id } = await atTemplate("chat-late")
        const say = "Good question. Which layout suits you?"
        let answered = (): void => undefined
        const decided = new Promise<void>((resolve) => {
          answered = resolve
        })
        const slow = racer(
          plan({ pending_card: "unanswered", say }),
          decided.then(() => new Promise((r) => setTimeout(r, 20)))
        )
        const late = await talker(who, undefined, {
          planner: slow.model,
          jev: async () => {
            await slow.started
            // Long enough for the first sentence to show.
            await new Promise((r) => setTimeout(r, 100))
            answered()
            return { kind: "answer", option: "bold" }
          },
        }).say(id, "u_late_1", "Is bold the loud one? Bold then")
        expect(slow.calls).toHaveLength(1)
        expect(late.after.parts).toContainEqual(
          expect.objectContaining({ type: "text", text: say })
        )
        expect(pendingCall(late.after).input).toMatchObject({
          step: "template",
        })
        expect((await lastTurn(who, id))?.outcome).toBe("answered")
        expect(
          (await factsOf(who)).find((f) => f.key === "site.template")
        ).toBeUndefined()
        // Unsure, after the planner has started: the planner answers.
        const read = racer(plan({ pending_card: "unanswered", say }))
        await talker(who, undefined, {
          planner: read.model,
          jev: async () => {
            await read.started
            return null
          },
        }).say(id, "u_late_2", "what's the difference between them?")
        expect(read.calls).toHaveLength(1)
        expect((await lastTurn(who, id))?.outcome).toBe("answered")
      }, 60_000)

      it("ignores Jev's decision for a card another turn answered first", async () => {
        const { who, id, card } = await atTemplate("chat-moved")
        // The layout card is answered by a click after this turn read it,
        // and before its transaction, so the palette card waits instead.
        let opened = 0
        const meddling: Tenancy = {
          ...kit,
          withOrg: async (scope, fn) => {
            if (++opened === 2) {
              await talker(who).turn(
                id,
                answer(await talker(who).tail(id), {
                  answer: "chosen",
                  ids: ["classic"],
                  other: null,
                })
              )
            }
            return kit.withOrg(scope, fn)
          },
        }
        const read = racer(
          plan({
            pending_card: "unanswered",
            say: "Happy to help. Which colours suit you?",
          })
        )
        const sent = await talker(who, undefined, {
          planner: read.model,
          jev: async (seen) => {
            expect(seen.toolCallId).toBe(card.toolCallId)
            await read.started
            return { kind: "defer" }
          },
        }).send(
          {
            conversation_id: id,
            mode: "act",
            turn: { kind: "message", message_id: "u_moved_1", text: "hmm" },
          },
          stubOrchestrator(),
          meddling
        )
        expect(sent.response.status).toBe(200)
        expect(read.calls).toHaveLength(1)
        expect((await lastTurn(who, id))?.outcome).toBe("answered")
        expect(
          (await factsOf(who)).find((f) => f.key === "site.palette")
        ).toBeUndefined()
        expect(pendingCall(await talker(who).tail(id)).input).toMatchObject({
          step: "palette",
        })
      }, 60_000)

      it("answers with Jev's reading when the planner fails on its own", async () => {
        const { who, id } = await atTemplate("chat-failed")
        const broken = planner([new Error("provider down")])
        await talker(who, undefined, {
          planner: broken.model,
          jev: async () => {
            // Only after the planner has failed on its own.
            while (broken.calls.length === 0) {
              await new Promise((r) => setTimeout(r, 5))
            }
            await new Promise((r) => setTimeout(r, 50))
            return { kind: "answer", option: "modern" }
          },
        }).say(id, "u_failed_1", "The modern one, please")
        expect(broken.calls.length).toBeGreaterThan(0)
        expect(
          (await factsOf(who)).find((f) => f.key === "site.template")?.value
        ).toEqual({ id: "modern" })
        expect((await lastTurn(who, id))?.outcome).toBe("gated")
      }, 60_000)

      it("answers with Jev's reading when no planner turn can open", async () => {
        const { who, id } = await atTemplate("chat-capped")
        await spendCap(who, id)
        const spent = planner([plan({ say: "never sent" })])
        const sent = await talker(who, undefined, {
          planner: spent.model,
          jev: async () => ({ kind: "answer", option: "bold" }),
        }).say(id, "u_capped_1", "Go with the bold look")
        expect(spent.calls).toHaveLength(0)
        expect(pendingCall(sent.after).input).toMatchObject({ step: "palette" })
        expect(
          (await factsOf(who)).find((f) => f.key === "site.template")?.value
        ).toEqual({ id: "bold" })
      }, 60_000)
    })

    it("prepares business-specific copy once in the background", async () => {
      const who = await owner(kit, url as string, "chat-prepare")
      await who.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ facts: UP_TO_PHOTOS }),
      })
      const id = await talker(who).onboarding()
      const prep = planner([{ services_phrase: "your regular cleans" }])
      const later: Promise<unknown>[] = []
      const t = () =>
        talker(who, undefined, {
          planner: null,
          prepare: prep.model,
          waitUntil: (promise) => later.push(promise),
        })
      const asked = await t().say(id, "u_prep_1", "The address and how often")
      await Promise.all(later)
      expect(prep.calls).toHaveLength(1)
      const rows = await kit.withOrg({ orgId: who.orgId }, (db) =>
        db
          .select({ type: events.type, payload: events.payload })
          .from(events)
          .where(
            sql`${events.type} in ('onboarding.prepare', 'onboarding.prepared')`
          )
      )
      expect(rows.map((r) => r.type).sort()).toEqual([
        "onboarding.prepare",
        "onboarding.prepared",
      ])
      expect(
        rows.find((r) => r.type === "onboarding.prepared")?.payload
      ).toMatchObject({
        conversation_id: id,
        copy: { services_phrase: "your regular cleans" },
        cost_usd: expect.any(Number),
      })
      // The quote form confirmed, which starts the build: no second call.
      const form = pendingCall(asked.after)
      await t().turn(
        id,
        answer(asked.after, {
          answer: "confirmed",
          fields: DEFAULT_QUOTE_FIELDS,
        }),
        building()
      )
      await Promise.all(later)
      expect(form.type).toBe("tool-review_quote_form")
      // Once per conversation.
      expect(prep.calls).toHaveLength(1)
    }, 60_000)

    it("sends the background copy call no secret-shaped string from the facts", async () => {
      const who = await owner(kit, url as string, "chat-prepare-scrub")
      await who.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          facts: [
            ...UP_TO_PHOTOS.filter((f) => f.key !== "business.name"),
            {
              key: "business.name",
              value: { name: "Bearer abcdefgh12345678" },
            },
          ],
        }),
      })
      const id = await talker(who).onboarding()
      const prep = planner([{ services_phrase: "your cleans" }])
      const later: Promise<unknown>[] = []
      await talker(who, undefined, {
        planner: null,
        prepare: prep.model,
        waitUntil: (promise) => later.push(promise),
      }).say(id, "u_scrub_1", "The address and how often")
      await Promise.all(later)
      expect(prep.calls).toHaveLength(1)
      expect(prep.calls[0]).not.toContain("abcdefgh12345678")
      expect(prep.calls[0]).toContain("[redacted]")
    }, 60_000)

    it("proposes the quote form, takes changes as words, states the confirmed form, then the build", async () => {
      const who = await owner(kit, url as string, "chat-quote")
      await who.call(stubOrchestrator(), "/facts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ facts: UP_TO_PHOTOS }),
      })
      const id = await talker(who).onboarding()
      const fields = [
        {
          key: "rooms",
          label: "Bedrooms",
          type: "number",
          required: true,
          hint: null,
          options: null,
        },
        {
          key: "often",
          label: "How often",
          type: "select",
          required: true,
          hint: null,
          options: ["Weekly", "Fortnightly"],
        },
      ]
      const dated = [
        ...fields,
        {
          key: "pets",
          label: "Any pets?",
          type: "text",
          required: false,
          hint: null,
          options: null,
        },
      ]
      const t = (model: ReturnType<typeof planner>["model"]) =>
        talker(who, undefined, { planner: model })
      const proposal = planner([
        plan({
          say: "Here is the form.",
          next: { kind: "review_quote_form", fields, note: null },
        }),
      ])
      const proposed = await t(proposal.model).turn(id, {
        turn: {
          kind: "message",
          message_id: "u_q_2",
          text: "rooms and how often",
        },
      })
      expect(pendingCall(proposed.after)).toMatchObject({
        type: "tool-review_quote_form",
        input: { fields, note: null },
      })
      const changes = planner([
        plan({
          say: "Added pets.",
          pending_card: "declined",
          next: { kind: "review_quote_form", fields: dated, note: null },
        }),
      ])
      const changed = await t(changes.model).turn(
        id,
        answer(proposed.after, {
          answer: "changes",
          text: "Ask about pets too",
        })
      )
      // The words read as a message typed over the waiting form.
      expect(changes.calls[0]).toMatch(/typed\\+":\\+"Ask about pets too/)
      expect(changes.calls[0]).toMatch(/waiting_card\\+":\{\\+"card/)
      expect((await factsOf(who)).some((f) => f.key === "quote.form")).toBe(
        false
      )
      // Confirmed: the form is stated by the script, with no model, and the
      // build starts on it, once the form is committed: the look is held
      // and the photos are a tray question.
      let seen: unknown[] = []
      const stub = stubOrchestrator(async (request) => {
        seen = await kit.withOrg({ orgId: who.orgId }, async (db) =>
          (
            await db.select().from(facts).where(eq(facts.key, "quote.form"))
          ).map((f) => f.value)
        )
        return building().fetch(request)
      })
      const unused = planner([plan({ say: "never sent" })])
      const confirmed = await talker(who, undefined, {
        planner: unused.model,
      }).turn(
        id,
        {
          ...answer(changed.after, { answer: "confirmed", fields: dated }),
          turn: {
            ...answer(changed.after, { answer: "confirmed", fields: dated })
              .turn,
            reply: { message_id: "u_q_ok", text: "Bedrooms, how often, pets" },
          },
        },
        stub
      )
      expect(unused.calls).toHaveLength(0)
      // The reply path: the card's row ends with the card, then the owner's
      // reply and the next step each have a row of their own.
      const rows = await talker(who).rows(id)
      expect(rows.slice(-3).map((r) => r.id)).toEqual([
        changed.after.id,
        "u_q_ok",
        confirmed.after.id,
      ])
      expect(
        (rows.at(-3)?.content as { parts: ToolPart[] } | undefined)?.parts.at(
          -1
        )
      ).toMatchObject({
        type: "tool-review_quote_form",
        state: "output-available",
      })
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.request.headers.get("idempotency-key")).toBe(
        `onboarding:${id}`
      )
      expect(seen).toEqual([{ fields: dated }])
      expect(confirmed.after.parts.slice(-3)).toMatchObject([
        {
          type: "tool-request_change",
          state: "output-available",
          output: { outcome: "started" },
        },
        { type: "step-start" },
        { type: "text", state: "done" },
      ])
      expect(
        await kit.withOrg({ orgId: who.orgId }, (db) => readScript(db, id))
      ).toMatchObject({ offered: true })
      // The same reply again is refused, and writes nothing.
      const again = await talker(who).send({
        conversation_id: id,
        mode: "act",
        turn: {
          ...answer(changed.after, { answer: "confirmed", fields: dated }).turn,
          reply: { message_id: "u_q_ok", text: "Bedrooms, how often, pets" },
        },
      })
      expect(again.response.status).toBe(409)
      expect(ErrorEnvelope.parse(JSON.parse(again.text)).code).toBe(
        "chat.message_exists"
      )
      const closes = (await logged(who, id)).filter(
        (e) => e.type === "cos.turn"
      )
      expect(
        closes.map((e) => (e.payload as { outcome: string }).outcome)
      ).toEqual(Array(2).fill("answered"))
    }, 90_000)

    it("asks who the customers are once before the website, counting a question asked in words", async () => {
      // Everything for the website but who the customers are, never asked.
      const before = [
        ...UP_TO_PHOTOS.filter(
          (f) => f.key !== "business.audience" && !f.key.startsWith("site.")
        ),
        QUOTE_FORM,
      ]
      const website = plan({
        say: "Shall I build your website?",
        next: {
          kind: "ask_choice",
          step: "build_for_me",
          preselected: [],
          initial: [],
        },
      })
      const setUp = async (tag: string) => {
        const who = await owner(kit, url as string, tag)
        await who.call(stubOrchestrator(), "/facts", {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ facts: before }),
        })
        const id = await talker(who).onboarding()
        return { who, id }
      }
      const typedTurn = (message_id: string, text: string) => ({
        turn: { kind: "message", message_id, text },
      })

      // Never asked: the website question is refused on every attempt, and
      // the script reads the reply as its own step asks it, who the customers are.
      const early = await setUp("chat-customers-early")
      const refused = planner([website, website])
      const fell = await talker(early.who, undefined, {
        planner: refused.model,
      }).turn(early.id, typedTurn("u_au_1", "Mostly busy families"))
      expect(refused.calls).toHaveLength(PLANNER.attempts)
      expect(
        (await factsOf(early.who)).find((f) => f.key === "business.audience")
          ?.value
      ).toEqual({ text: "Mostly busy families" })
      expect(pendingCall(fell.after).input).toMatchObject({
        step: "build_for_me",
      })

      // Asked in words once and not answered: the website follows.
      const asked = await setUp("chat-customers-asked")
      const customers = planner([
        plan({
          say: "Thanks. Who are your customers, mostly?",
          next: { kind: "ask_open", about: "business.audience" },
        }),
      ])
      await talker(asked.who, undefined, { planner: customers.model }).turn(
        asked.id,
        typedTurn("u_au_2", "Hello")
      )
      // The question waits in the tray; words typed past it decline it.
      const next = planner([{ ...website, pending_card: "declined" }])
      const site = await talker(asked.who, undefined, {
        planner: next.model,
      }).turn(asked.id, typedTurn("u_au_3", "Not sure, anyone really"))
      expect(next.calls).toHaveLength(1)
      expect(next.calls[0]).toContain(
        'business.audience\\":\\"optional, asked enough: leave it'
      )
      expect(pendingCall(site.after).input).toMatchObject({
        step: "build_for_me",
      })
    }, 60_000)

    it("gives the planner a tray answer to a question in words, as the owner's words", async () => {
      const who = await owner(kit, url as string, "chat-ask-open")
      const ask = planner([
        plan({
          facts: { "business.offerings": { items: ["Weddings"] } },
          say: "Weddings, noted. Who books you most?",
          next: { kind: "ask_open", about: "business.audience" },
        }),
      ])
      const id = await talker(who).onboarding()
      const asked = await talker(who, undefined, { planner: ask.model }).turn(
        id,
        { turn: { kind: "message", message_id: "u_open_1", text: "Weddings" } }
      )
      const read = planner([
        plan({
          facts: { "business.audience": { text: "Couples" } },
          say: "Couples, noted.",
        }),
      ])
      await talker(who, undefined, { planner: read.model }).turn(
        id,
        answer(asked.after, { answer: "stated", text: "Mostly couples" })
      )
      expect(read.calls[0]).toContain("answered in their words: Mostly couples")
      expect(
        (await factsOf(who)).find((f) => f.key === "business.audience")?.value
      ).toEqual({ text: "Couples" })
    }, 60_000)

    it("says what the plan is on before its first word, once its facts are written", async () => {
      const who = await owner(kit, url as string, "chat-status")
      // The stream drops after the plan, so only a write made before the
      // message streamed can hold the plan's facts.
      const dropped = planner(
        [
          plan({
            facts: {
              "business.offerings": { items: ["Dog grooming"] },
              "business.phone": { e164: "+447700900412" },
            },
            say: "Dog grooming, noted. Which areas do you cover?",
          }),
        ],
        true
      )
      const me = talker(who, undefined, { planner: dropped.model })
      const id = await me.onboarding()
      const done = await me.turn(id, {
        turn: {
          kind: "message",
          message_id: "u_status_1",
          text: "Dog grooming. Call 07700 900 412.",
        },
      })
      const firstWord = done.chunks.findIndex((c) => c.type === "text-delta")
      expect(firstWord).toBeGreaterThan(0)
      expect(
        done.chunks
          .slice(0, firstWord)
          .filter((c) => c.type === ONBOARDING_STATUS)
      ).toEqual([
        {
          type: ONBOARDING_STATUS,
          data: { on: { kind: "fact", key: "business.offerings" }, facts: [] },
          transient: true,
        },
        {
          type: ONBOARDING_STATUS,
          data: {
            on: { kind: "next", next: "answer_only" },
            facts: expect.arrayContaining([
              "business.offerings",
              "business.phone",
            ]),
          },
          transient: true,
        },
      ])
      expect((await logged(who, id)).at(-1)?.payload).toMatchObject({
        outcome: "fallback",
        reason: "provider",
      })
      expect(
        (await factsOf(who)).find((f) => f.key === "business.phone")?.value
      ).toEqual({ e164: "+447700900412" })
    }, 60_000)

    it("keeps what the owner read when the provider fails after it, and lets the script finish the turn", async () => {
      const who = await owner(kit, url as string, "chat-dropped")
      const dropped = planner(
        [
          plan({
            pending_card: "unanswered",
            say: "Lovely to meet you. Let me ask about your trade.",
          }),
        ],
        true
      )
      const me = talker(who, undefined, { planner: dropped.model })
      const id = await me.onboarding()
      const done = await me.turn(id, {
        turn: { kind: "message", message_id: "u_drop_1", text: "Dog grooming" },
      })
      // The first sentence streamed; the second never finished, so it never showed.
      expect(done.after.parts.slice(0, 2)).toEqual([
        { type: "step-start" },
        { type: "text", text: "Lovely to meet you.", state: "done" },
      ])
      // Then the script's own step, as it answers any turn the planner cannot.
      expect(done.after.parts.slice(2)).toMatchObject([
        { type: "text", state: "done" },
        { type: "tool-ask_fact", input: { key: "service_area.text" } },
      ])
      expect((await logged(who, id)).at(-1)?.payload).toMatchObject({
        outcome: "fallback",
        reason: "provider",
      })
    }, 60_000)

    it("ends the stream with the reason when the conversation moved while the model wrote", async () => {
      const who = await owner(kit, url as string, "chat-moved")
      const id = await talker(who).onboarding()
      const [first] = await talker(who).rows(id)
      const moved = { role: "assistant", parts: [{ type: "step-start" }] }
      const racing = planner([
        plan({
          pending_card: "unanswered",
          say: "Happy to help. Which trade?",
        }),
      ])
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          // Another tab's turn lands while this one's model call runs.
          await kit.withOrg({ orgId: who.orgId }, (db) =>
            db
              .update(conversationMessages)
              .set({ content: moved })
              .where(eq(conversationMessages.id, first?.id as string))
          )
          return racing.model.doStream(options)
        },
      })
      const { response, text } = await talker(who, undefined, {
        planner: model,
      }).send({
        conversation_id: id,
        mode: "act",
        turn: { kind: "message", message_id: "u_moved_1", text: "hello" },
      })
      expect(response.status).toBe(200)
      const chunks = text
        .split("\n\n")
        .filter((f) => f.startsWith("data: {"))
        .map((f) => JSON.parse(f.slice("data: ".length)) as UIMessageChunk)
      expect(chunks.at(-1)).toEqual({
        type: "error",
        errorText: "This conversation has moved on. Reload it.",
      })
      expect(chunks).not.toContainEqual({ type: "finish" })
      // Nothing of the turn was stored, and its log closed it as an error.
      const rows = await talker(who).rows(id)
      expect(rows.map((r) => r.id)).toEqual([first?.id])
      expect(rows[0]?.content).toEqual(moved)
      expect((await logged(who, id)).at(-1)?.payload).toMatchObject({
        outcome: "error",
      })
    }, 60_000)

    it("lets the script answer a turn the planner cannot: a failing model, and a spent budget", async () => {
      const who = await owner(kit, url as string, "chat-fallback")
      // Down twice: asked once more after the first, then the script.
      const broken = planner([
        new Error("provider down"),
        new Error("provider down"),
      ])
      const me = talker(who, undefined, { planner: broken.model })
      const id = await me.onboarding()
      const done = await me.turn(id, {
        turn: { kind: "message", message_id: "u_fb_1", text: "Dog grooming" },
      })
      expect(broken.calls).toHaveLength(2)
      // The script's own answer: what the business does, then its next card.
      expect(done.after.parts.slice(1)).toMatchObject([
        { type: "text", state: "done" },
        { type: "tool-ask_fact", input: { key: "service_area.text" } },
      ])
      const log = await logged(who, id)
      expect(log.at(-1)?.payload).toMatchObject({
        outcome: "fallback",
        reason: "provider",
      })

      // Over the day's cap: no model call at all.
      await spendCap(who, id)
      const spent = planner([plan({ say: "never sent" })])
      const capped = await talker(who, undefined, {
        planner: spent.model,
      }).turn(id, {
        turn: {
          kind: "message",
          message_id: "u_fb_2",
          text: "Full grooms and nail clips",
        },
      })
      expect(spent.calls).toHaveLength(0)
      expect(pendingCall(capped.after).input).toMatchObject({
        key: "business.audience",
      })
    }, 60_000)
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
