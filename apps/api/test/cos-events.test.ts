import {
  assignments,
  conversations,
  eq,
  newUlid,
  postAssistantMessage,
  serverMessageId,
  type Tenancy,
  tenancy,
  unloggedResults,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  CONTEXT_POLICY,
  deriveCosMessages,
  EVENT_HEADER,
  readSession,
} from "../src/cos/history.ts"
import { beginTurn, closeLapsedTurn } from "../src/cos/turns.ts"
import { type Owner, owner, seed } from "./owner-fixture.ts"

/**
 * What happens away from the chat reaches the CoS log as a `cos.event` when
 * it happens, and the next turn's model input carries it: a notice as the
 * assistant's own message, a staff result as labelled data.
 */

const url = process.env.DATABASE_URL

describe.skipIf(!url)("events in the CoS log, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let me: Owner

  beforeAll(async () => {
    me = await owner(kit, url as string, "cos-events")
  }, 60_000)

  afterAll(() => kit.close())

  it("logs a finished build's notice and result, and the next turn reads both", async () => {
    const { orgId } = me
    const sessionId = await kit.withOrg({ orgId }, async (db) => {
      const [made] = await db
        .insert(conversations)
        .values({ orgId, kind: "assistant", createdByStaffId: me.chiefId })
        .returning({ id: conversations.id })
      return made?.id as string
    })

    const notice = "Your website is live at probe.example."
    const key = `site.live:${sessionId}`
    expect(
      await postAssistantMessage(kit, {
        orgId,
        key,
        message: { text: [notice] },
      })
    ).toBe("posted")

    // A build that ended while a turn was open: its result waits in the row.
    const assignmentId = await seed(kit, me).assignment("published")
    const summary = "Done and live: Build the site from the canonical facts."
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(assignments)
        .set({
          result: {
            outcome: "done",
            summary,
            evidence: [
              { kind: "record", table: "assignments", id: assignmentId },
            ],
            metadata: { kind: "site.build", state: "published" },
          },
        })
        .where(eq(assignments.id, assignmentId))
    )

    const turn = { orgId, staffId: me.chiefId, sessionId, turnId: newUlid() }
    const asked = { id: "u_cos_events", role: "user" as const }
    await kit.withOrg({ orgId }, async (db) => {
      expect(await closeLapsedTurn(db, turn, 60_000)).toBe(false)
      await beginTurn(db, turn, {
        prefix: null,
        messages: [
          {
            message: { ...asked, parts: [{ type: "text", text: "Is it up?" }] },
            taint: ["untrusted_input"],
          },
        ],
        context: {
          turn_id: turn.turnId,
          prefix_sha256: "b".repeat(64),
          context_policy_version: CONTEXT_POLICY.version,
          mode: "ask",
          active_tools: ["get_workspace"],
          text: "Mode: ask.",
          reserved_usd: 0.01,
        },
        contextTaint: ["untrusted_input"],
      })
    })

    const log = await kit.withOrg({ orgId }, (db) => readSession(db, sessionId))
    expect(log.map((e) => e.type)).toEqual([
      "cos.event",
      "cos.event",
      "cos.message",
      "cos.context",
    ])
    expect(log[0]?.payload).toMatchObject({
      source: "notice",
      summary: notice,
      message_id: serverMessageId(key),
    })
    expect(log[1]?.payload).toMatchObject({ source: "staff", summary })
    expect(await kit.withOrg({ orgId }, unloggedResults)).toEqual([])

    const { messages } = deriveCosMessages(log, CONTEXT_POLICY)
    expect(messages.map((m) => [m.id, m.role])).toEqual([
      [serverMessageId(key), "assistant"],
      [`event:${log[1]?.seq}`, "user"],
      [`context-${turn.turnId}`, "user"],
      [asked.id, "user"],
    ])
    expect(messages[0]?.parts).toContainEqual({
      type: "text",
      text: notice,
      state: "done",
    })
    expect(messages[1]?.parts).toEqual([
      { type: "text", text: expect.stringContaining(summary) },
    ])
    expect(messages[1]?.parts[0]).toMatchObject({
      text: expect.stringMatching(new RegExp(`^${EVENT_HEADER}`)),
    })
  })
})
