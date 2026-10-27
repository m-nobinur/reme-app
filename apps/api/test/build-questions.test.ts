import {
  ADDRESS_ASK,
  type BuildQuestions,
  Conversation,
  type QuestionInput,
  type QuestionReply,
} from "@workspace/contracts"
import {
  currentFact,
  postAssistantMessage,
  readTasks,
  serverMessageId,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fits, storable } from "../src/build-questions.ts"
import {
  type Owner,
  owner,
  type Stub,
  stubOrchestrator,
} from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

describe("what a question card takes", () => {
  it("takes a fact in its own shape, a listed option, or text in its limits", () => {
    const phone = { kind: "fact", key: "business.phone" } as const
    expect(fits(phone, { e164: "+441614960000" })).toBe(true)
    expect(fits(phone, "0161 496 0000")).toBe(false)
    const choice: QuestionInput = { kind: "choice", options: ["Yes", "No"] }
    expect(fits(choice, "Yes")).toBe(true)
    expect(fits(choice, "Maybe")).toBe(false)
    const email = { kind: "text", maxLength: 254, email: true } as const
    expect(fits(email, "book@brightclean.invalid")).toBe(true)
    expect(fits(email, "not an address")).toBe(false)
    expect(fits({ kind: "text", maxLength: 5, email: false }, "Too long")).toBe(
      false
    )
  })

  it("stores an offer only as a business fact in its own shape", () => {
    const text = { kind: "text", maxLength: 500, email: false } as const
    expect(storable("business.insurance", text)).toBe(true)
    expect(storable("business.phone", text)).toBe(false)
    expect(
      storable("business.proof", { kind: "fact", key: "business.proof" })
    ).toBe(true)
    expect(storable("site.pages", text)).toBe(false)
    expect(storable("owner.profile", text)).toBe(false)
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)("answering a question card, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch
  let who: Owner

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    who = await owner(kit, url as string, "asked")
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  /** A fresh conversation holding one posted stack. */
  async function posted(questions: BuildQuestions) {
    const made = await who.call(stubOrchestrator(), "/conversations", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    })
    const { id } = Conversation.parse(await made.json())
    const key = `question:${crypto.randomUUID()}`
    expect(
      await postAssistantMessage(kit, {
        orgId: who.orgId,
        key,
        conversationId: id,
        message: { text: ["I need one answer from you."], questions },
      })
    ).toBe("posted")
    const reply = (stub: Stub, body: Omit<QuestionReply, "message_id">) =>
      who.call(stub, `/conversations/${id}/questions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ message_id: serverMessageId(key), ...body }),
      })
    return { reply }
  }

  const build = crypto.randomUUID()
  const asking = (id = crypto.randomUUID()): BuildQuestions => ({
    kind: "build",
    assignment_id: build,
    questions: [
      {
        id,
        text: "Can customers park near you?",
        input: { kind: "text", maxLength: 500, email: false },
        skippable: false,
      },
    ],
  })

  it("sends a build's answer to the build with no yes, and settles the card", async () => {
    const question = crypto.randomUUID()
    const { reply } = await posted(asking(question))
    const stub = stubOrchestrator(() =>
      Response.json({
        answer_id: crypto.randomUUID(),
        org_id: who.orgId,
        assignment_id: build,
        request_id: question,
        fact_id: crypto.randomUUID(),
        answered_at: new Date().toISOString(),
      })
    )
    const answer = { kind: "value", value: "Free street parking" } as const
    const first = await reply(stub, { question_id: question, answer })
    expect(first.status).toBe(200)
    expect(
      ((await first.json()) as BuildQuestions).questions[0]?.answer
    ).toEqual(answer)
    expect(stub.calls).toHaveLength(1)
    expect(new URL(stub.calls[0]?.request.url ?? "").pathname).toBe(
      `/assignments/${build}/answer`
    )
    expect(stub.calls[0]?.body).toEqual({
      request_id: question,
      value: "Free street parking",
    })
    // The same answer again is a retry; another is refused.
    expect((await reply(stub, { question_id: question, answer })).status).toBe(
      200
    )
    expect(stub.calls).toHaveLength(1)
    const other = await reply(stub, {
      question_id: question,
      answer: { kind: "value", value: "A car park" },
    })
    expect(other.status).toBe(409)
  })

  it("closes a build's question the build no longer waits on", async () => {
    const question = crypto.randomUUID()
    const { reply } = await posted(asking(question))
    const stub = stubOrchestrator(() =>
      Response.json(
        {
          class: "validation",
          code: "assignment.not_waiting",
          message: "This assignment is not waiting for information.",
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status: 409 }
      )
    )
    const sent = await reply(stub, {
      question_id: question,
      answer: { kind: "value", value: "Free street parking" },
    })
    expect(sent.status).toBe(200)
    expect(
      ((await sent.json()) as BuildQuestions).questions[0]?.answer
    ).toEqual({ kind: "closed" })
  })

  it("refuses a skip on a question the build cannot do without", async () => {
    const question = crypto.randomUUID()
    const { reply } = await posted(asking(question))
    const sent = await reply(stubOrchestrator(), {
      question_id: question,
      answer: { kind: "skipped" },
    })
    expect(sent.status).toBe(400)
  })

  it("stores an offer's answers as the owner's facts and starts one change once settled", async () => {
    const [proof, parking] = [crypto.randomUUID(), crypto.randomUUID()]
    const { reply } = await posted({
      kind: "offer",
      assignment_id: build,
      questions: [
        {
          id: proof,
          text: "What helps new customers trust you?",
          input: { kind: "fact", key: "business.proof" },
          skippable: true,
          field: "business.proof",
        },
        {
          id: parking,
          text: "Can customers park near you?",
          input: { kind: "text", maxLength: 500, email: false },
          skippable: true,
          field: "business.parking",
        },
      ],
    })
    const stub = stubOrchestrator()
    const given = await reply(stub, {
      question_id: proof,
      answer: { kind: "value", value: { text: "Family run since 2009" } },
    })
    expect(given.status).toBe(200)
    // One still open: no change yet.
    expect(stub.calls).toHaveLength(0)
    const stored = await kit.withOrg({ orgId: who.orgId }, (db) =>
      currentFact(db, "business.proof")
    )
    expect(stored?.value).toEqual({ text: "Family run since 2009" })
    expect(stored?.provenanceSource).toBe("owner_stated")
    const skipped = await reply(stub, {
      question_id: parking,
      answer: { kind: "skipped" },
    })
    expect(skipped.status).toBe(200)
    const goals = stub.calls.flatMap(({ body }) => {
      const goal = (body as { goal?: unknown } | undefined)?.goal
      return typeof goal === "string" ? [goal] : []
    })
    expect(goals).toEqual([
      "Add these details to the site: What helps new customers trust you? Family run since 2009",
    ])
  })

  const addressStack = () => {
    const [have, name] = [crypto.randomUUID(), crypto.randomUUID()]
    const stack: BuildQuestions = {
      kind: "address",
      questions: [
        {
          id: have,
          text: ADDRESS_ASK.have,
          input: {
            kind: "choice",
            options: [ADDRESS_ASK.yes, ADDRESS_ASK.no, ADDRESS_ASK.later],
          },
          skippable: false,
        },
        {
          id: name,
          text: ADDRESS_ASK.name,
          input: { kind: "text", maxLength: 253, email: false },
          skippable: true,
        },
      ],
    }
    return { have, name, stack }
  }
  const addressTask = async () =>
    (await kit.withOrg({ orgId: who.orgId }, (db) => readTasks(db))).find(
      (t) => t.kind === "address"
    )

  it("closes the name page and picks a name next when the owner has no address", async () => {
    const { have, name, stack } = addressStack()
    const { reply } = await posted(stack)
    const sent = await reply(stubOrchestrator(), {
      question_id: have,
      answer: { kind: "value", value: ADDRESS_ASK.no },
    })
    const stored = (await sent.json()) as BuildQuestions
    expect(stored.questions.map((q) => q.answer?.kind)).toEqual([
      "value",
      "closed",
    ])
    const task = await addressTask()
    const step = (s: string) => task?.steps.find((x) => x.step === s)
    expect(step("find_out")?.state).toBe("done")
    expect(step("choose")).toMatchObject({
      state: "blocked",
      blocked_on: "owner_action",
      note: "Picking a name",
    })
    // The name page was closed by the server, so a skip of it is refused.
    const late = await reply(stubOrchestrator(), {
      question_id: name,
      answer: { kind: "skipped" },
    })
    expect(late.status).toBe(409)
  })

  it("puts the address task off for a week on Not now, and leaves a Yes to the reply", async () => {
    const { have, stack } = addressStack()
    const { reply } = await posted(stack)
    await reply(stubOrchestrator(), {
      question_id: have,
      answer: { kind: "value", value: ADDRESS_ASK.later },
    })
    const task = await addressTask()
    expect(task?.state).toBe("later")
    const days =
      (Date.parse(task?.later_until ?? "") - Date.now()) / (24 * 3600 * 1000)
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)

    const yes = addressStack()
    const asked = await posted(yes.stack)
    const sent = await asked.reply(stubOrchestrator(), {
      question_id: yes.have,
      answer: { kind: "value", value: ADDRESS_ASK.yes },
    })
    expect(
      ((await sent.json()) as BuildQuestions).questions.map((q) => q.answer)
    ).toEqual([{ kind: "value", value: ADDRESS_ASK.yes }, undefined])
  })
})
