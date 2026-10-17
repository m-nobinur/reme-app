import { domains, searchConnections } from "@workspace/db"
import { describe, expect, it, vi } from "vitest"
import { searchInstanceId } from "../src/search.ts"
import { startSearchForDomain } from "../src/search-start.ts"
import { freshOrg, kit } from "./fixture.ts"

/**
 * A domain going live starts the Search Console workflow for its new primary
 * host only for an org with a live Google connection, and never fails the
 * activation. Needs a database, like the domain suite.
 */

const url = process.env.DATABASE_URL

/** A live domain of the org on a name made for this run, answering on `www.` of it. */
async function domainOf(
  orgId: string,
  connection?: "active" | "needs_reauth" | "revoked"
) {
  const domainId = crypto.randomUUID()
  const name = `${domainId.slice(0, 8)}.example`
  await kit.withOrg({ orgId }, async (db) => {
    if (connection) {
      await db.insert(searchConnections).values({
        orgId,
        state: connection,
        refreshToken: connection === "revoked" ? null : "v1.aXY.Y3Q",
      })
    }
    await db.insert(domains).values({
      id: domainId,
      orgId,
      siteId: orgId,
      name,
      primaryHost: `www.${name}`,
      origin: "connected",
      method: "records",
      state: "active",
    })
  })
  return { domainId, host: `www.${name}` }
}

const fake = (create = vi.fn(async () => ({}))) =>
  ({ SEARCHES: { create } }) as unknown as Env

describe.skipIf(!url)("starting Search Console for a new domain", () => {
  it("starts one instance per org and host for an org connected to Google", async () => {
    const orgId = await freshOrg(kit)
    const { domainId, host } = await domainOf(orgId, "active")
    const create = vi.fn(async () => ({}))
    await startSearchForDomain(fake(create), kit, orgId, domainId)
    expect(create).toHaveBeenCalledExactlyOnceWith({
      id: searchInstanceId(orgId, host),
      params: { org_id: orgId, host },
    })
  })

  it("starts nothing for an org that never connected, or whose grant ended", async () => {
    const create = vi.fn(async () => ({}))
    for (const connection of [undefined, "needs_reauth", "revoked"] as const) {
      const orgId = await freshOrg(kit)
      const { domainId } = await domainOf(orgId, connection)
      await startSearchForDomain(fake(create), kit, orgId, domainId)
    }
    expect(create).not.toHaveBeenCalled()
  })

  it("leaves the domain live when the instance already exists or cannot start", async () => {
    const orgId = await freshOrg(kit)
    const { domainId } = await domainOf(orgId, "active")
    const create = vi.fn(async () => {
      throw new Error("instance.already_exists")
    })
    await expect(
      startSearchForDomain(fake(create), kit, orgId, domainId)
    ).resolves.toBeUndefined()
    expect(create).toHaveBeenCalledOnce()
  })
})

describe("the Search Console instance id", () => {
  it("is a valid Workflow id of at most 100 characters", () => {
    const id = searchInstanceId(crypto.randomUUID(), `${"a".repeat(80)}.co.uk`)
    expect(id).toMatch(/^search-[A-Za-z0-9_-]{1,93}$/)
    expect(id.length).toBeLessThanOrEqual(100)
  })
})
