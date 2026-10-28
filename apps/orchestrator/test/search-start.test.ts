import { domains, searchConnections, searchProperties } from "@workspace/db"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sealToken } from "../src/google.ts"
import { forgetStrays, searchInstanceId } from "../src/search.ts"
import { moveGoogle, startSearchForDomain } from "../src/search-start.ts"
import { freshOrg, kit } from "./fixture.ts"

afterEach(() => vi.unstubAllGlobals())

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

describe.skipIf(!url)("moving Google to a live domain", () => {
  const OLD = "old-slug.example"
  const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64"
  )
  const propertyOf = (
    orgId: string,
    state: "verified" | "pending" = "verified"
  ) =>
    kit.withOrg({ orgId }, (db) =>
      db.insert(searchProperties).values({
        orgId,
        host: OLD,
        siteUrl: `https://${OLD}/`,
        kind: "subdomain",
        method: "file",
        state,
        verifiedAt: state === "verified" ? new Date() : null,
      })
    )
  /**
   * The org's grant sealed for real, and Google: the token refresh succeeds,
   * Search Console answers `status`, its calls recorded.
   */
  const google = async (orgId: string, env: Env, status = 204) => {
    const refreshToken = await sealToken(env, orgId, "1//refresh")
    await kit.withOrg({ orgId }, (db) =>
      db.update(searchConnections).set({ refreshToken })
    )
    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const href = String(input)
        if (href.endsWith("/token")) {
          return Response.json({ access_token: "ya29.a", expires_in: 3600 })
        }
        calls.push(`${init?.method} ${href}`)
        return new Response(null, { status })
      })
    )
    return calls
  }
  const DELETE = `DELETE https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(`https://${OLD}/`)}`
  const held = (orgId: string) =>
    kit.withOrg({ orgId }, (db) =>
      db.select({ id: searchProperties.id }).from(searchProperties)
    )
  const stopping = () => {
    const terminate = vi.fn(async () => undefined)
    const get = vi.fn(async () => ({ terminate }))
    const env = {
      SEARCHES: { get },
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_TOKEN_KEY: KEY,
    } as unknown as Env
    return { terminate, env }
  }

  it("takes the old host's property out of Search Console and our records", async () => {
    const orgId = await freshOrg(kit)
    await domainOf(orgId, "active")
    await propertyOf(orgId)
    const { terminate, env } = stopping()
    const calls = await google(orgId, env)
    expect(await moveGoogle(env, kit, orgId, OLD)).toBe("moved")
    expect(terminate).toHaveBeenCalledOnce()
    expect(calls).toEqual([DELETE])
    expect(await held(orgId)).toEqual([])
    // A repeat finds nothing to let go of and says the new host went.
    expect(await moveGoogle(env, kit, orgId, OLD)).toBe("added")
    expect(calls).toHaveLength(1)
  })

  it("counts a 404 as gone, and leaves a property Reme never added alone at Google", async () => {
    const orgId = await freshOrg(kit)
    await domainOf(orgId, "active")
    await propertyOf(orgId)
    const { env } = stopping()
    const calls = await google(orgId, env, 404)
    expect(await moveGoogle(env, kit, orgId, OLD)).toBe("moved")
    expect(calls).toEqual([DELETE])
    expect(await held(orgId)).toEqual([])

    // Pending: Reme's `add` step never ran, so only our row goes.
    await propertyOf(orgId, "pending")
    expect(await moveGoogle(env, kit, orgId, OLD)).toBe("moved")
    expect(calls).toHaveLength(1)
    expect(await held(orgId)).toEqual([])
  })

  it("keeps the row when Google refuses the removal, and the hourly sweep lets it go", async () => {
    const orgId = await freshOrg(kit)
    await domainOf(orgId, "active")
    await propertyOf(orgId)
    const { env } = stopping()
    const calls = await google(orgId, env, 403)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(await moveGoogle(env, kit, orgId, OLD)).toBe("moved")
    expect(calls).toEqual([DELETE])
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ code: "search.unlist_failed", reason: "google.403" })
    )
    expect(await held(orgId)).toHaveLength(1)
    warn.mockRestore()

    const retried = await google(orgId, env)
    expect(await forgetStrays(env, kit, [orgId])).toBe(1)
    expect(retried).toEqual([DELETE])
    expect(await held(orgId)).toEqual([])
    // Nothing left: the next hour calls nobody.
    expect(await forgetStrays(env, kit, [orgId])).toBe(0)
    expect(retried).toHaveLength(1)
  })

  it("never sweeps the host the site is served on, or an org whose grant ended", async () => {
    const orgId = await freshOrg(kit)
    const { host } = await domainOf(orgId, "active")
    await kit.withOrg({ orgId }, (db) =>
      db.insert(searchProperties).values({
        orgId,
        host,
        siteUrl: `https://${host}/`,
        kind: "url_prefix",
        method: "file",
        state: "verified",
        verifiedAt: new Date(),
      })
    )
    const { env } = stopping()
    const calls = await google(orgId, env)
    expect(await forgetStrays(env, kit, [orgId])).toBe(0)
    expect(calls).toEqual([])

    const ended = await freshOrg(kit)
    await domainOf(ended, "needs_reauth")
    await propertyOf(ended)
    expect(await forgetStrays(env, kit, [ended])).toBe(0)
    expect(await held(ended)).toHaveLength(1)
  })

  it("says only that the host was added when Google never held the old one", async () => {
    const orgId = await freshOrg(kit)
    await domainOf(orgId, "active")
    expect(await moveGoogle(stopping().env, kit, orgId, OLD)).toBe("added")
  })

  it("leaves an org that is not connected to Google alone", async () => {
    const orgId = await freshOrg(kit)
    await domainOf(orgId)
    await propertyOf(orgId)
    expect(await moveGoogle(stopping().env, kit, orgId, OLD)).toBeNull()
    expect(await held(orgId)).toHaveLength(1)
  })
})

describe("the Search Console instance id", () => {
  it("is a valid Workflow id of at most 100 characters", () => {
    const id = searchInstanceId(crypto.randomUUID(), `${"a".repeat(80)}.co.uk`)
    expect(id).toMatch(/^search-[A-Za-z0-9_-]{1,93}$/)
    expect(id.length).toBeLessThanOrEqual(100)
  })
})
