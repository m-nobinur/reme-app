import {
  appendEvent,
  conversationMessages,
  conversations,
  currentFact,
  eq,
  serverMessageId,
  staff,
  supersedeFact,
  waitedOn,
} from "@workspace/db"
import { afterAll, describe, expect, it } from "vitest"
import type { writeText } from "../src/heartbeat-write.ts"
import { askOwner, quoted, relayQuestion } from "../src/relay.ts"
import { advance } from "../src/state.ts"
import { freshOrg, kit, newAssignment } from "./fixture.ts"

describe("an answer the owner already gave", () => {
  const said = ["We're in Leeds. There's free street parking outside."]

  it("is their own words, never a paraphrase", () => {
    expect(quoted("free street parking", said, null)).toBe(true)
    expect(quoted("Free street parking.", said, null)).toBe(true)
    expect(quoted("parking is available", said, null)).toBe(false)
    // One word could be lifted from any message.
    expect(quoted("parking", said, null)).toBe(false)
  })

  it("is one option, and only one they named", () => {
    const options = ["Street parking", "A car park"]
    expect(quoted("street parking", said, options)).toBe(true)
    expect(quoted("A car park", said, options)).toBe(false)
    expect(quoted("free street parking", said, options)).toBe(false)
  })
})

const live = describe.skipIf(!process.env.DATABASE_URL)
afterAll(() => kit.close())

/** A build waiting on one question, in an org with a chat the owner wrote `said` in. */
async function waiting(field: string, said: string[] = []) {
  const orgId = await freshOrg(kit)
  const ids = await newAssignment(kit, orgId)
  for (const to of ["briefing", "planning", "implementing"] as const) {
    await advance(kit, ids, to)
  }
  const requestId = crypto.randomUUID()
  await kit.withOrg({ orgId }, async (db) => {
    const [chief] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.staffCode, "COS-001"))
    const [chat] = await db
      .insert(conversations)
      .values({
        orgId,
        kind: "assistant",
        createdByStaffId: chief?.id as string,
      })
      .returning({ id: conversations.id })
    for (const [i, text] of said.entries()) {
      await db.insert(conversationMessages).values({
        conversationId: chat?.id as string,
        id: `m${i}`,
        orgId,
        format: "ai-sdk/v6",
        content: { role: "user", parts: [{ type: "text", text }] },
      })
    }
    await appendEvent(db, {
      orgId,
      assignmentId: ids.assignmentId,
      staffId: null,
      type: "information.requested",
      payload: {
        request_id: requestId,
        field,
        why: "The contact page names parking.",
        question: "Is there parking near you for customers?",
        answer_schema: { type: "string" },
        options: null,
      },
    })
  })
  await advance(kit, ids, "blocked_on_information", {
    payload: { request_id: requestId },
  })
  const answered = async () => {
    const [w] = await kit.withOrg({ orgId }, (db) =>
      waitedOn(db, ids.assignmentId)
    )
    return w?.fact_id ?? null
  }
  return { ids, orgId, requestId, answered }
}

/** A model that reads the chat as `reading`. */
const reads =
  (reading: { answer: string | null; question: string }): typeof writeText =>
  async () => ({
    text: JSON.stringify(reading),
    spent: {
      model: "stub",
      cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      ms: 0,
    },
  })
const key = { OPENROUTER_API_KEY: "stub" }

live("the relay", () => {
  it("answers from a fact that holds now, with no new write", async () => {
    const b = await waiting("business.parking")
    const fact = await kit.withOrg({ orgId: b.orgId }, (db) =>
      supersedeFact(db, {
        orgId: b.orgId,
        key: "business.parking",
        factType: "business",
        value: "A car park behind the shop",
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
    expect(await relayQuestion({}, kit, b.ids, b.requestId)).toEqual({
      answered: true,
    })
    expect(await b.answered()).toBe(fact.factId)
  })

  it("stores what the owner said in the chat as their word", async () => {
    const b = await waiting("business.parking", [
      "Customers can use the free street parking outside.",
    ])
    const relayed = await relayQuestion(
      key,
      kit,
      b.ids,
      b.requestId,
      reads({ answer: "free street parking outside", question: "x?" })
    )
    expect(relayed).toEqual({ answered: true })
    const stored = await kit.withOrg({ orgId: b.orgId }, (db) =>
      currentFact(db, "business.parking")
    )
    expect(stored?.value).toBe("free street parking outside")
    expect(stored?.provenanceSource).toBe("owner_stated")
    // Their words, but they never confirmed them as this answer.
    expect(stored?.verifiedByStaffId).toBeNull()
    expect(await b.answered()).toBe(stored?.id)
  })

  it("asks in its own words when the owner never said it, and posts the card once", async () => {
    const b = await waiting("business.parking", ["Hello"])
    const relayed = await relayQuestion(
      key,
      kit,
      b.ids,
      b.requestId,
      reads({ answer: "a car park", question: "Can customers park near you?" })
    )
    expect(relayed).toEqual({ ask: "Can customers park near you?" })
    expect(await b.answered()).toBeNull()
    const ask = "Can customers park near you?"
    expect(await askOwner(kit, b.ids, b.requestId, ask)).toBe("posted")
    expect(await askOwner(kit, b.ids, b.requestId, ask)).toBe("exists")
    const [row] = await kit.withOrg({ orgId: b.orgId }, (db) =>
      db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
        .where(
          eq(
            conversationMessages.id,
            serverMessageId(`question:${b.requestId}`)
          )
        )
    )
    expect(row?.content).toMatchObject({
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: expect.stringMatching(/^I need one answer/) },
        {
          type: "data-build_questions",
          data: {
            kind: "build",
            assignment_id: b.ids.assignmentId,
            questions: [
              {
                id: b.requestId,
                text: ask,
                input: { kind: "text", maxLength: 500, email: false },
                skippable: false,
              },
            ],
          },
        },
      ],
    })
  })

  it("keeps the Developer's words when the model's would show a field", async () => {
    const b = await waiting("business.parking")
    expect(
      await relayQuestion(
        key,
        kit,
        b.ids,
        b.requestId,
        reads({ answer: null, question: "What is business.parking?" })
      )
    ).toEqual({ ask: "Is there parking near you for customers?" })
  })
})
