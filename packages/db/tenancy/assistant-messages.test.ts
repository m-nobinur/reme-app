import { sql } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import {
  postAssistantMessage,
  serverMessageId,
} from "../src/assistant-messages.ts"
import { connect, connectionString } from "../src/client.ts"
import { appendSessionEvent } from "../src/events.ts"
import {
  conversationMessages,
  conversations,
  orgs,
  staff,
} from "../src/schema.ts"
import { tenancy, withOrg } from "../src/tenancy.ts"

/**
 * `postAssistantMessage` against Postgres: one row per key, a wait behind an
 * unanswered card or a running onboarding script, and `busy` while a turn
 * holds the conversation.
 */
const kit = tenancy(connectionString(), { max: 4 })
const made: string[] = []

const text = ["Your website is live at www.example.com."]

async function org(): Promise<{ orgId: string; staffId: string }> {
  const orgId = crypto.randomUUID()
  const staffId = crypto.randomUUID()
  made.push(orgId)
  await withOrg({ orgId }, async (db) => {
    await db.insert(orgs).values({
      id: orgId,
      slug: `post-probe-${orgId.slice(0, 8)}`,
      name: "Post probe (fixture)",
    })
    await db.insert(staff).values({
      id: staffId,
      orgId,
      staffCode: "COS-001",
      displayName: "Post probe chief",
      kind: "agent",
      status: "active",
    })
  })
  return { orgId, staffId }
}

async function conversation(
  { orgId, staffId }: { orgId: string; staffId: string },
  kind: "assistant" | "onboarding",
  updatedAt: Date,
  tail: Record<string, unknown>[] | null
): Promise<string> {
  const id = crypto.randomUUID()
  await withOrg({ orgId }, async (db) => {
    await db
      .insert(conversations)
      .values({ id, orgId, kind, createdByStaffId: staffId, updatedAt })
    if (tail) {
      await db.insert(conversationMessages).values({
        conversationId: id,
        id: "tail_1",
        orgId,
        format: "ai-sdk/v6",
        content: { role: "assistant", parts: tail },
      })
    }
  })
  return id
}

const rows = (orgId: string, id: string) =>
  withOrg({ orgId }, (db) =>
    db.execute<{ id: string; parent_id: string | null; content: unknown }>(
      sql`select id, parent_id, content from ${conversationMessages}
        where conversation_id = ${id} order by seq`
    )
  )

const said = [
  { type: "step-start" },
  { type: "text", text: "Hi", state: "done" },
]
const card = (state: string) => [
  { type: "step-start" },
  {
    type: "tool-ask_choice",
    toolCallId: "call_1",
    state,
    input: { key: "manual_builder" },
  },
]

afterAll(async () => {
  await kit.close()
  const { sql: client, db } = connect()
  try {
    await db.transaction((tx) => clearOrgs(tx, made, []))
  } finally {
    await client.end()
  }
})

describe("postAssistantMessage", () => {
  it("posts a key once, on the newest open conversation's tail", async () => {
    const o = await org()
    const older = await conversation(o, "assistant", new Date(2026, 0, 1), said)
    const newest = await conversation(
      o,
      "assistant",
      new Date(2026, 0, 3),
      said
    )
    const archived = await conversation(
      o,
      "assistant",
      new Date(2026, 0, 4),
      said
    )
    await withOrg({ orgId: o.orgId }, (db) =>
      db.execute(
        sql`update ${conversations} set archived_at = now() where id = ${archived}`
      )
    )
    const message = {
      text,
      button: {
        label: "Open your site",
        action: { kind: "open" as const, url: "https://www.example.com" },
      },
    }
    const post = () =>
      postAssistantMessage(kit, { orgId: o.orgId, key: "live:d1", message })
    expect(await post()).toBe("posted")
    expect(await post()).toBe("exists")
    const stored = await rows(o.orgId, newest)
    expect(stored.map((r) => [r.id, r.parent_id])).toEqual([
      ["tail_1", null],
      [serverMessageId("live:d1"), "tail_1"],
    ])
    expect(stored[1]?.content).toEqual({
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: text[0], state: "done" },
        { type: "data-button", data: message.button },
      ],
    })
    expect(await rows(o.orgId, older)).toHaveLength(1)
    expect(await rows(o.orgId, archived)).toHaveLength(1)
  })

  it("waits while the tail holds an unanswered card, then posts once it is answered", async () => {
    const o = await org()
    const id = await conversation(
      o,
      "assistant",
      new Date(),
      card("approval-requested")
    )
    const post = () =>
      postAssistantMessage(kit, {
        orgId: o.orgId,
        key: "live:d2",
        message: { text },
      })
    expect(await post()).toBe("waiting")
    expect(await rows(o.orgId, id)).toHaveLength(1)
    await withOrg({ orgId: o.orgId }, (db) =>
      db.execute(sql`update ${conversationMessages}
        set content = jsonb_set(content, '{parts,1,state}', '"output-available"')
        where conversation_id = ${id}`)
    )
    expect(await post()).toBe("posted")
  })

  it("is busy while a turn holds the conversation's lock, and posts after", async () => {
    const o = await org()
    const id = await conversation(o, "assistant", new Date(), said)
    const post = () =>
      postAssistantMessage(kit, {
        orgId: o.orgId,
        key: "live:d3",
        message: { text },
      })
    let release: () => void = () => undefined
    let locked: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      locked = resolve
    })
    const turn = withOrg({ orgId: o.orgId }, async (db) => {
      await db.execute(
        sql`select pg_advisory_xact_lock(2, hashtext(${id}::text))`
      )
      locked()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await held
    expect(await post()).toBe("busy")
    release()
    await turn
    expect(await post()).toBe("posted")
  })

  it("is busy while a CoS turn streams with the lock let go", async () => {
    const o = await org()
    const id = await conversation(o, "assistant", new Date(), said)
    const event = (type: string) => ({
      orgId: o.orgId,
      assignmentId: null,
      staffId: null,
      sessionId: id,
      type,
      payload: { turn_id: "turn_1" },
    })
    await withOrg({ orgId: o.orgId }, (db) =>
      appendSessionEvent(db, event("cos.context"))
    )
    const post = () =>
      postAssistantMessage(kit, {
        orgId: o.orgId,
        key: "live:d4",
        message: { text },
      })
    expect(await post()).toBe("busy")
    await withOrg({ orgId: o.orgId }, (db) =>
      appendSessionEvent(db, event("cos.turn"))
    )
    expect(await post()).toBe("posted")
  })

  it("waits in onboarding until the script has ended, and says none with no conversation", async () => {
    const o = await org()
    const post = () =>
      postAssistantMessage(kit, {
        orgId: o.orgId,
        key: "live:d5",
        message: { text },
      })
    expect(await post()).toBe("none")
    // An answered card that is not the builder question leaves the script running.
    const id = await conversation(o, "onboarding", new Date(), [
      { type: "step-start" },
      {
        type: "tool-ask_fact",
        toolCallId: "call_0",
        state: "output-available",
        input: { key: "business.name" },
      },
    ])
    expect(await post()).toBe("waiting")
    await withOrg({ orgId: o.orgId }, (db) =>
      db.execute(sql`update ${conversationMessages}
        set content = ${JSON.stringify({ role: "assistant", parts: card("output-available") })}::jsonb
        where conversation_id = ${id}`)
    )
    expect(await post()).toBe("posted")
  })

  it("posts to the named conversation, not the newest, and says none for a stranger's", async () => {
    const o = await org()
    const older = await conversation(o, "assistant", new Date(2026, 0, 1), said)
    const newest = await conversation(
      o,
      "assistant",
      new Date(2026, 0, 3),
      said
    )
    const other = await org()
    const theirs = await conversation(
      other,
      "assistant",
      new Date(2026, 0, 1),
      said
    )
    const post = (conversationId: string) =>
      postAssistantMessage(kit, {
        orgId: o.orgId,
        key: "reminder:r1",
        message: { text },
        conversationId,
      })
    expect(await post(theirs)).toBe("none")
    expect(await post(older)).toBe("posted")
    expect((await rows(o.orgId, older)).map((r) => r.id)).toHaveLength(2)
    expect(await rows(o.orgId, newest)).toHaveLength(1)
  })

  it("refuses a message the contract refuses, before any write", async () => {
    const o = await org()
    await expect(
      postAssistantMessage(kit, {
        orgId: o.orgId,
        key: "bad",
        message: {
          text,
          button: {
            label: "Open",
            action: { kind: "open", url: "http://plain.example.com" },
          },
        },
      })
    ).rejects.toThrow()
  })
})
