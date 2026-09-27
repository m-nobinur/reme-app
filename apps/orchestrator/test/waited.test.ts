import { supersedeFact, type Tenancy, tenancy, waitedOn } from "@workspace/db"
import { afterAll, describe, expect, it } from "vitest"
import { advance, appendEvent } from "../src/state.ts"
import { freshOrg, newAssignment } from "./fixture.ts"

// `waitedOn` against a database: which question a build waits on, as the
// Workflow's looks, the orchestrator's `/answer` and `/workspace` read it.

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)
const kit: Tenancy = tenancy(url ?? "postgres://unused")
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
  const answer = async (requestId: string, value: unknown) => {
    const fact = await kit.withOrg({ orgId }, (db) =>
      supersedeFact(db, {
        orgId,
        key: "business.parking",
        factType: "business",
        value,
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
    await event("information.answered", {
      request_id: requestId,
      fact_id: fact.factId,
    })
  }
  const read = (id: string | null = ids.assignmentId) =>
    kit.withOrg({ orgId }, (db) => waitedOn(db, id))
  return { ids, request, block, answer, read }
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
      }),
    ])
    await b.answer(second, "Street parking")
    const [waited] = await b.read()
    expect(waited?.answer).toMatchObject({ request_id: second })
    expect(waited?.value).toBe("Street parking")
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
    const all = await one.read(null)
    expect(all.map((w) => w.assignment_id).sort()).toEqual(
      [one.ids.assignmentId, two.ids.assignmentId].sort()
    )
  })
})
