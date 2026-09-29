import { appendEvent, supersedeFact, waitedOn } from "@workspace/db"
import { afterAll, describe, expect, it } from "vitest"
import { advance } from "../src/state.ts"
import { freshOrg, kit, newAssignment } from "./fixture.ts"

// `waitedOn` against a database: which question a build waits on, as the
// Workflow's looks, the orchestrator's `/answer` and `/workspace` read it.

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)
afterAll(() => kit.close())

async function build(orgId: string, kind = "site.build") {
  const ids = await newAssignment(kit, orgId, kind)
  for (const to of ["briefing", "planning", "implementing"] as const) {
    await advance(kit, ids, to)
  }
  const event = (type: string, payload: Record<string, unknown>) =>
    kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: ids.assignmentId,
        staffId: null,
        type,
        payload,
      })
    )
  const request = async (field: string) => {
    const requestId = crypto.randomUUID()
    await event("information.requested", { request_id: requestId, field })
    return requestId
  }
  const block = (requestId: string) =>
    advance(kit, ids, "blocked_on_information", {
      payload: { request_id: requestId },
    })
  /** A new version of the parking fact, as any writer makes one. */
  const state = (value: unknown) =>
    kit.withOrg({ orgId }, (db) =>
      supersedeFact(db, {
        orgId,
        key: "business.parking",
        factType: "business",
        value,
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
  const answer = async (requestId: string, value: unknown) => {
    const fact = await state(value)
    await event("information.answered", {
      request_id: requestId,
      fact_id: fact.factId,
    })
    return fact.factId
  }
  const read = () =>
    kit.withOrg({ orgId }, (db) => waitedOn(db, ids.assignmentId))
  const readAll = () => kit.withOrg({ orgId }, (db) => waitedOn(db))
  return { ids, request, block, state, answer, read, readAll }
}

live("the question a build waits on", () => {
  it("is the one its latest block named, with the answer and its value", async () => {
    const b = await build(await freshOrg(kit))
    const first = await b.request("business.parking")
    await b.block(first)
    await advance(kit, b.ids, "implementing")
    const second = await b.request("business.parking")
    await b.block(second)
    expect(await b.read()).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ request_id: second }),
        answer: null,
        value: null,
        fact_id: null,
      }),
    ])
    await b.answer(second, "Street parking")
    const [waited] = await b.read()
    expect(waited?.answer).toMatchObject({ request_id: second })
    expect(waited?.value).toBe("Street parking")
  })

  it("takes the latest answer, and the fact's current version to resume on", async () => {
    const b = await build(await freshOrg(kit))
    const asked = await b.request("business.parking")
    await b.block(asked)
    // Two answers to one question, as a log from before the row lock can
    // hold: the later one counts.
    await b.answer(asked, "Street parking")
    const later = await b.answer(asked, "Round the back")
    let [waited] = await b.read()
    expect(waited?.answer).toMatchObject({ fact_id: later })
    expect(waited?.value).toBe("Round the back")
    expect(waited?.fact_id).toBe(later)
    // The owner edits the fact before the Workflow looks: it resumes on the
    // edit, while the answer and its value stay what was answered.
    const edited = await b.state("Behind the shop")
    ;[waited] = await b.read()
    expect(waited?.answer).toMatchObject({ fact_id: later })
    expect(waited?.value).toBe("Round the back")
    expect(waited?.fact_id).toBe(edited.factId)
  })

  it("passes over a block that names no question and one never blocked on", async () => {
    const b = await build(await freshOrg(kit))
    const asked = await b.request("business.parking")
    await b.block(asked)
    await b.request("business.parking_notes")
    await advance(kit, b.ids, "paused")
    await advance(kit, b.ids, "blocked_on_information")
    const [waited] = await b.read()
    expect(waited?.request.request_id).toBe(asked)
  })

  it("reads every blocked build of the org at once, and no other", async () => {
    const orgId = await freshOrg(kit)
    const one = await build(orgId)
    await one.block(await one.request("business.parking"))
    // A site holds one build at a time, so the second blocked one is not a
    // site build.
    const two = await build(orgId, "probe.task")
    await two.block(await two.request("business.parking"))
    // Blocked once and moved on: no longer waiting.
    const three = await build(orgId, "probe.task")
    await three.block(await three.request("business.parking"))
    await advance(kit, three.ids, "implementing")
    const all = await one.readAll()
    expect(all.map((w) => w.assignment_id).sort()).toEqual(
      [one.ids.assignmentId, two.ids.assignmentId].sort()
    )
  })
})
