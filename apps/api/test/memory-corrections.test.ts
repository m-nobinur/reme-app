import {
  ErrorEnvelope,
  MemoryView,
  STAFF_CORRECTIONS_KEY,
} from "@workspace/contracts"
import {
  eq,
  memberships,
  orgs,
  readCorrections,
  supersedePrivateFact,
  type Tenancy,
  tenancy,
  users,
} from "@workspace/db"
import { skillsFor } from "@workspace/skills"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { cookieHeader, env, stubJwksFetch } from "./sealed-session.ts"

/**
 * The owner's corrections for the Developer on the Memory page: listed for
 * the org, removed by its owner only, gone from the next build's brief.
 */

const url = process.env.DATABASE_URL

describe.skipIf(!url)("the Developer's corrections on the Memory page", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let realFetch: typeof fetch
  let me: Owner
  const id = crypto.randomUUID()
  const sentence = "Never use stock photos on my site."

  /** What the Developer's next brief carries, read as the Workflow reads it. */
  const nextBrief = () =>
    kit.withOrg({ orgId: me.orgId }, async (db) =>
      skillsFor("developer", await readCorrections(db))
        .filter((s) => s.kind === "correction")
        .map((s) => s.body)
    )

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    me = await owner(kit, url as string, "memory-corrections")
    await kit.withOrg({ orgId: me.orgId }, (db) =>
      supersedePrivateFact(db, {
        orgId: me.orgId,
        key: STAFF_CORRECTIONS_KEY,
        factType: "owner",
        value: {
          lines: [
            {
              id,
              staff: "developer",
              text: sentence,
              at: new Date().toISOString(),
            },
          ],
        },
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
  }, 60_000)
  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  /** A signed-in member of the org who is not its owner. */
  async function asMember() {
    const run = crypto.randomUUID().slice(0, 8)
    const workosUserId = `user_probe_member_${run}`
    const [org] = await kit.withOrg({ orgId: me.orgId }, (db) =>
      db
        .select({ workos: orgs.workosOrganizationId })
        .from(orgs)
        .where(eq(orgs.id, me.orgId))
    )
    await kit.withOrg({ orgId: me.orgId, workosUserId }, async (db) => {
      await db
        .insert(users)
        .values({ workosUserId, email: `member-${run}@owner-probe.invalid` })
      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, workosUserId))
      await db.insert(memberships).values({
        orgId: me.orgId,
        userId: person?.id as string,
        workosMembershipId: `om_member_${run}`,
        role: "member",
        status: "active",
      })
    })
    return async (path: string, init: RequestInit = {}) =>
      worker.fetch(
        new Request(`http://api.invalid${path}`, {
          ...init,
          headers: await cookieHeader({
            sub: workosUserId,
            org_id: org?.workos as string,
            role: "member",
          }),
        }),
        {
          ...env(url as string),
          ORCHESTRATOR: stubOrchestrator(),
        } as unknown as Env,
        { waitUntil: () => undefined } as unknown as ExecutionContext
      )
  }

  it("lists the saved sentence, refuses a member's remove, and the owner's remove drops it from the next brief", async () => {
    const page = await me.call(stubOrchestrator(), "/memory", {
      method: "GET",
    })
    expect(MemoryView.parse(await page.json()).corrections).toEqual([
      expect.objectContaining({ id, staff: "developer", text: sentence }),
    ])
    expect(await nextBrief()).toEqual([sentence])

    const member = await asMember()
    const refused = await member(`/memory/corrections/${id}`, {
      method: "DELETE",
    })
    expect(refused.status).toBe(403)
    expect(ErrorEnvelope.parse(await refused.json()).code).toBe(
      "memory.not_owner"
    )
    expect(await nextBrief()).toEqual([sentence])

    const removed = await me.call(
      stubOrchestrator(),
      `/memory/corrections/${id}`,
      { method: "DELETE" }
    )
    expect(removed.status).toBe(200)
    expect(MemoryView.parse(await removed.json()).corrections).toEqual([])
    expect(await nextBrief()).toEqual([])

    const again = await me.call(
      stubOrchestrator(),
      `/memory/corrections/${id}`,
      { method: "DELETE" }
    )
    expect(again.status).toBe(404)
    expect(ErrorEnvelope.parse(await again.json()).code).toBe(
      "memory.correction_not_found"
    )
  })
})
