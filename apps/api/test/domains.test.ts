import { ErrorEnvelope } from "@workspace/contracts"
import { memberships, sql, type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

/**
 * `DELETE /domains/{name}` on a live connection: the owner's removal goes to
 * the orchestrator and its answer comes back; anyone else is refused before
 * the binding is called.
 */

const url = process.env.DATABASE_URL
const NAME = "sparklecleanbristol.co.uk"

const removal = (key: string | null = crypto.randomUUID()) => ({
  method: "DELETE",
  headers: (key ? { "idempotency-key": key } : {}) as Record<string, string>,
})

describe.skipIf(!url)("removing a domain, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let realFetch: typeof fetch
  let who: Owner

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    who = await owner(kit, url as string, "domains")
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  it("sends the owner's removal to the orchestrator and answers its 204", async () => {
    const stub = stubOrchestrator(() => new Response(null, { status: 204 }))
    const response = await who.call(stub, `/domains/${NAME}`, removal())
    expect(response.status).toBe(204)
    expect(stub.calls.map((c) => [c.request.method, c.request.url])).toEqual([
      ["DELETE", `https://orchestrator/assignments/domains/${NAME}`],
    ])
  })

  it("relays the orchestrator's refusal, and wants a key", async () => {
    const stub = stubOrchestrator(() =>
      Response.json(
        {
          class: "resource",
          code: "domain.not_found",
          message: `${NAME} isn't connected to this site.`,
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status: 404 }
      )
    )
    const response = await who.call(stub, `/domains/${NAME}`, removal())
    expect(response.status).toBe(404)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "domain.not_found"
    )
    const keyless = await who.call(stub, `/domains/${NAME}`, removal(null))
    expect(keyless.status).toBe(400)
    expect(stub.calls).toHaveLength(1)
  })

  it("refuses a member who is not the owner before calling the orchestrator", async () => {
    const member = await owner(kit, url as string, "domains-member")
    await kit.withOrg({ orgId: member.orgId }, (db) =>
      db
        .update(memberships)
        .set({ role: "member" })
        .where(sql`${memberships.orgId} = ${member.orgId}`)
    )
    const stub = stubOrchestrator(() => new Response(null, { status: 204 }))
    const response = await member.call(stub, `/domains/${NAME}`, removal())
    expect(response.status).toBe(403)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "domain.not_owner"
    )
    expect(stub.calls).toEqual([])
  })
})
