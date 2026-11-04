import { Conversation } from "@workspace/contracts"
import {
  appendSessionEvent,
  openTask,
  postAssistantMessage,
  serverMessageId,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  applyRewind,
  hostRefusal,
  planRewind,
  // @ts-expect-error plain ESM, deliberately runnable without a build
} from "../scripts/rewind.mjs"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

describe("the rewind script's host check", () => {
  it("runs on a local host or the one named, and never on production", () => {
    expect(hostRefusal("postgres://localhost:5433/reme")).toBeNull()
    expect(
      hostRefusal("postgres://ep-calm-1.eu-west-2.aws.neon.tech/neondb")
    ).toMatch(/not local/)
    expect(
      hostRefusal(
        "postgres://ep-calm-1.eu-west-2.aws.neon.tech/neondb",
        "ep-calm-1.eu-west-2.aws.neon.tech"
      )
    ).toBeNull()
    expect(
      hostRefusal(
        "postgres://ep-live-2.aws.neon.tech/neondb",
        "ep-live-2.aws.neon.tech",
        "ep-live-2.aws.neon.tech"
      )
    ).toMatch(/is production/)
    expect(
      hostRefusal("postgres://db.prod.internal/x", "db.prod.internal")
    ).toMatch(/production/)
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)("rewinding a conversation, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  const admin = postgres(url as string, { max: 1 })
  let me: Owner
  let realFetch: typeof fetch

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    me = await owner(kit, url as string, "rewind")
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await admin.end()
    await kit.close()
  })

  it("lists what follows the boundary on a dry run, then deletes only that", async () => {
    const made = await me.call(stubOrchestrator(), "/conversations", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    })
    const { id } = Conversation.parse(await made.json())
    const post = (key: string) =>
      postAssistantMessage(kit, {
        orgId: me.orgId,
        key,
        conversationId: id,
        message: { text: [key] },
      })
    await post("before")
    // A beat, so the rows after it are later by the database's clock.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await post("after")
    await kit.withOrg({ orgId: me.orgId }, async (db) => {
      await openTask(db, me.orgId, "address")
      await appendSessionEvent(db, {
        orgId: me.orgId,
        staffId: me.chiefId,
        assignmentId: null,
        sessionId: id,
        type: "cos.context",
        payload: { turn_id: "01J00000000000000000000000" },
      })
    })
    const plan = await planRewind(admin, id, serverMessageId("before"))
    expect(plan.messages.map((m: { id: string }) => m.id)).toEqual([
      serverMessageId("after"),
    ])
    expect(plan.events.map((e: { type: string }) => e.type)).toEqual([
      "cos.event",
      "cos.context",
    ])
    expect(plan.tasks.map((t: { kind: string }) => t.kind)).toEqual(["address"])
    await applyRewind(admin, plan)
    const left = await planRewind(admin, id, serverMessageId("before"))
    expect([left.messages, left.events, left.tasks]).toEqual([[], [], []])
    const [kept] =
      await admin`select count(*)::int as n from conversation_messages where conversation_id = ${id}`
    expect(kept?.n).toBe(1)
  })
})
