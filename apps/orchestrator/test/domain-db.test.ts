import { siteHost } from "@workspace/contracts"
import { deployments, domains, eq, events, orgs, sql } from "@workspace/db"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
  activateDomain,
  claimHostnames,
  connect,
  expireDomain,
  remove,
  repoint,
  revokeDomains,
} from "../src/domain-flow.ts"
import { DOH } from "./fixtures/domains.ts"
import { kit, previewed, SUFFIX, type storage, workflowEnv } from "./site.ts"

// The site fixture reaches the sandbox module through brief.ts; stood in
// for as in the publish suite.
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
}))
vi.mock("../src/sandbox.ts", () => ({}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

/**
 * The connect path's step bodies against a real database: the claim, the
 * Workflow's activation and expiry, removal and the account takedown, with
 * DNS from the recorded answers and Cloudflare's API stood in for. Skipped
 * without DATABASE_URL, like the publish suite.
 */

const url = process.env.DATABASE_URL
const NAME = "sparklecleanbristol.co.uk"
const CF = "https://api.cloudflare.com/client/v4/zones/zone/custom_hostnames"

/** DNS from the recordings plus a SOA for any other name asked; Cloudflare's hostnames in a map. */
function stubNet() {
  const hostnames = new Map<string, string>()
  const deleted: string[] = []
  const fetched = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input))
      if (u.hostname === "cloudflare-dns.com") {
        const name = u.searchParams.get("name") ?? ""
        const type = u.searchParams.get("type")
        const recorded = DOH[`${name} ${type}`]
        if (recorded) return Response.json(recorded)
        if (type === "SOA" && name.endsWith(".co.uk")) {
          return Response.json({
            Status: 0,
            Answer: [{ name, type: 6, TTL: 60, data: "ns. host. 1 1 1 1 1" }],
          })
        }
        return Response.json({ Status: 0 })
      }
      if (u.href.startsWith(CF)) {
        const envelope = (result: unknown) =>
          Response.json({ success: true, errors: [], messages: [], result })
        if (init?.method === "POST") {
          const { hostname } = JSON.parse(String(init.body)) as {
            hostname: string
          }
          hostnames.set(`h-${hostname}`, hostname)
          return envelope({ id: `h-${hostname}`, hostname, status: "pending" })
        }
        if (init?.method === "DELETE") {
          deleted.push(u.pathname.split("/").at(-1) ?? "")
          return envelope({ id: "x" })
        }
        return envelope([])
      }
      // Domain Connect settings hosts and the edge probe: nothing there.
      return new Response(null, { status: 404 })
    }
  )
  vi.stubGlobal("fetch", fetched)
  return { hostnames, deleted }
}

/** An org with a published site: the preview fixture plus a deployment of its revision. */
async function published() {
  const site = await previewed()
  await kit.withOrg({ orgId: site.orgId }, (db) =>
    db.insert(deployments).values({
      orgId: site.orgId,
      siteId: site.orgId,
      revisionId: site.revisionId,
      configVersion: 1,
      // A rollback needs no approval row, and counts as live all the same.
      kind: "rollback",
    })
  )
  const [org] = await kit.withOrg({ orgId: site.orgId }, (db) =>
    db.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, site.orgId))
  )
  return { ...site, slug: siteHost(org?.slug ?? "", SUFFIX) }
}

function domainEnv(store: ReturnType<typeof storage>) {
  const created: { id: string; params: unknown }[] = []
  const env = {
    ...workflowEnv(store).env,
    CF_DOMAINS_TOKEN: "token",
    CF_DOMAINS_ZONE_ID: "zone",
    DOMAINS: {
      create: async (instance: { id: string; params: unknown }) => {
        created.push(instance)
        return instance
      },
      get: async () => ({ terminate: async () => undefined }),
    },
  } as unknown as Env
  return { env, created }
}

const rowOf = (orgId: string, name = NAME) =>
  kit.withOrg({ orgId }, async (db) => {
    const [row] = await db
      .select()
      .from(domains)
      .where(eq(domains.name, name))
      .orderBy(sql`${domains.createdAt} desc`)
      .limit(1)
    return row
  })

const typesOf = (orgId: string, prefix: string) =>
  kit.withOrg({ orgId }, async (db) =>
    (
      await db
        .select({ type: events.type, payload: events.payload })
        .from(events)
        .where(sql`${events.type} like ${`${prefix}%`}`)
    ).map((e) => e.type)
  )

/** Each case claims its own name, since a live name is unique across orgs. */
const unique = () => `dom-${crypto.randomUUID().slice(0, 8)}.co.uk`

afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(() => kit.close())

describe.skipIf(!url)("custom domains against a database", () => {
  it("claims a name once, replays it for the same org and refuses it to another", async () => {
    stubNet()
    const site = await published()
    const { env, created } = domainEnv(site.store)
    const name = unique()
    const body = { name: `WWW.${name}`, approval_id: "approval-1" }
    const first = await connect(env, kit, site.orgId, body)
    expect(first).toMatchObject({
      status: 201,
      output: {
        outcome: "connecting",
        method: "records",
        email_affected: false,
        apex: "forward",
        steps: [{ type: "CNAME", name: "www", value: "domains.remeai.co.uk" }],
      },
    })
    const row = await rowOf(site.orgId, name)
    expect(row).toMatchObject({
      state: "awaiting_dns",
      primaryHost: `www.${name}`,
      approvalId: null,
    })
    expect(created).toEqual([
      {
        id: `domain-${row?.id}`,
        params: { org_id: site.orgId, domain_id: row?.id },
      },
    ])
    const again = await connect(env, kit, site.orgId, body)
    expect(again).toEqual({
      status: 200,
      output: (first as { output: unknown }).output,
    })
    expect(created).toHaveLength(1)
    expect(await typesOf(site.orgId, "domain.connect")).toEqual([
      "domain.connect_requested",
    ])

    const other = await published()
    expect(await connect(env, kit, other.orgId, body)).toMatchObject({
      status: 409,
      code: "domain.in_use",
    })
  })

  it("refuses an unpublished site and a fourth pending claim", async () => {
    stubNet()
    const site = await previewed()
    const { env } = domainEnv(site.store)
    expect(
      await connect(env, kit, site.orgId, { name: unique(), approval_id: "a" })
    ).toMatchObject({ status: 409, code: "site.not_published" })

    const live = await published()
    for (let i = 0; i < 3; i++) {
      expect(
        await connect(env, kit, live.orgId, {
          name: unique(),
          approval_id: "a",
        })
      ).toMatchObject({ status: 201 })
    }
    expect(
      await connect(env, kit, live.orgId, { name: unique(), approval_id: "a" })
    ).toMatchObject({ status: 409, code: "domain.too_many_pending" })
  })

  it("activates, points every host from the row, and removal puts the slug host back", async () => {
    const net = stubNet()
    const site = await published()
    const { env, created } = domainEnv(site.store)
    const name = unique()
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const row = await rowOf(site.orgId, name)
    const domainId = row?.id ?? ""

    expect(await claimHostnames(env, kit, site.orgId, domainId)).toEqual({
      www: `h-www.${name}`,
      apex: `h-${name}`,
    })
    // A retried claim adopts what it stored and creates nothing more.
    await claimHostnames(env, kit, site.orgId, domainId)
    expect(net.hostnames.size).toBe(2)

    await kit.withOrg({ orgId: site.orgId }, (db) =>
      db
        .update(domains)
        .set({ state: "verifying" })
        .where(eq(domains.id, domainId))
    )
    expect(await activateDomain(env, kit, site.orgId, domainId)).toBe(true)
    const read = (host: string) =>
      JSON.parse(site.store.pointers.get(`host:${host}`) ?? "null")
    expect(read(`www.${name}`)).toMatchObject({
      org_id: site.orgId,
      canonical_host: `www.${name}`,
      origin_host: site.slug,
    })
    expect(read(name)).toEqual({ redirect_to: `www.${name}` })
    expect(read(site.slug)).toEqual({ redirect_to: `www.${name}` })
    expect(await rowOf(site.orgId, name)).toMatchObject({ state: "active" })
    expect(await typesOf(site.orgId, "domain.")).toEqual(
      expect.arrayContaining(["domain.activated", "domain.status"])
    )

    // A stale write-back from the router lands after activation; the settle
    // step's second write puts the redirect back.
    site.store.pointers.set(`host:${site.slug}`, "stale")
    await repoint(env, kit, site.orgId, domainId)
    expect(read(site.slug)).toEqual({ redirect_to: `www.${name}` })

    expect(await remove(env, kit, site.orgId, name)).toBeNull()
    expect(await rowOf(site.orgId, name)).toMatchObject({ state: "removed" })
    expect(site.store.pointers.has(`host:www.${name}`)).toBe(false)
    expect(site.store.pointers.has(`host:${name}`)).toBe(false)
    expect(read(site.slug)).toMatchObject({ org_id: site.orgId })
    expect(read(site.slug).canonical_host).toBeUndefined()
    expect([...net.deleted].sort((a, b) => a.localeCompare(b))).toEqual([
      `h-${name}`,
      `h-www.${name}`,
    ])
    expect(created.at(-1)).toEqual({
      id: `domain-${domainId}-removed`,
      params: { org_id: site.orgId, domain_id: domainId, settle: true },
    })
    // The removal's settle write repeats the removal, and a repeated DELETE is fine.
    site.store.pointers.set(`host:www.${name}`, "stale")
    await repoint(env, kit, site.orgId, domainId)
    expect(site.store.pointers.has(`host:www.${name}`)).toBe(false)
    expect(await remove(env, kit, site.orgId, name)).toBeNull()
  })

  it("expires a claim without touching the pointers, and frees the name", async () => {
    const net = stubNet()
    const site = await published()
    const { env } = domainEnv(site.store)
    const name = unique()
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const domainId = (await rowOf(site.orgId, name))?.id ?? ""
    await claimHostnames(env, kit, site.orgId, domainId)
    const before = new Map(site.store.pointers)

    await expireDomain(env, kit, site.orgId, domainId, "timeout")
    await expireDomain(env, kit, site.orgId, domainId, "timeout")
    expect(await rowOf(site.orgId, name)).toMatchObject({ state: "failed" })
    expect(site.store.pointers).toEqual(before)
    expect([...net.deleted].sort((a, b) => a.localeCompare(b))).toEqual([
      `h-${name}`,
      `h-${name}`,
      `h-www.${name}`,
      `h-www.${name}`,
    ])
    expect(
      (await typesOf(site.orgId, "domain.")).filter(
        (t) => t === "domain.failed"
      )
    ).toHaveLength(1)

    const other = await published()
    expect(
      await connect(env, kit, other.orgId, { name, approval_id: "b" })
    ).toMatchObject({ status: 201 })
  })

  it("revokes every claim at takedown, hostnames first", async () => {
    const net = stubNet()
    const site = await published()
    const { env } = domainEnv(site.store)
    const name = unique()
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const domainId = (await rowOf(site.orgId, name))?.id ?? ""
    await claimHostnames(env, kit, site.orgId, domainId)
    await revokeDomains(env, kit, site.orgId)
    expect(await rowOf(site.orgId, name)).toMatchObject({ state: "removed" })
    expect([...net.deleted].sort((a, b) => a.localeCompare(b))).toEqual([
      `h-${name}`,
      `h-www.${name}`,
    ])
  })
})
