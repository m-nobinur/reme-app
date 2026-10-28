import { SITE_HEADER, siteHost } from "@workspace/contracts"
import {
  deployments,
  domains,
  eq,
  events,
  orgs,
  searchProperties,
  sql,
  taskSteps,
} from "@workspace/db"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
  activateDomain,
  checkNow,
  claimHostnames,
  connect,
  DEADLINE_MS,
  expireDomain,
  served as loadsOf,
  look,
  nudge,
  postStatus,
  remove,
  repoint,
  revokeDomains,
  sweepDomains,
} from "../src/domain-flow.ts"
import { probe } from "../src/probe.ts"
import { clearPointers, writePointer } from "../src/publish.ts"
import { searchInstanceId } from "../src/search.ts"
import { chatTexts, openChat } from "./chat.ts"
import { DOH } from "./fixtures/domains.ts"
import { kit, previewed, SUFFIX, type storage, workflowEnv } from "./site.ts"
import { stepped } from "./step.ts"

// The site fixture reaches the sandbox module through brief.ts; stood in
// for as in the publish suite.
vi.mock("../src/container.ts", () => ({
  RemeSandbox: class {},
  SandboxEgress: class {},
  SandboxPool: class {},
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

/** The site the edge probe answers for: the last one `published` made. */
let served = ""

/** DNS from the recordings plus a SOA for any other name asked; Cloudflare's hostnames in a map. */
/**
 * `doh` answers ahead of the recorded ones; `active` makes a hostname read
 * by id come back active with its certificate issued.
 */
function stubNet(
  doh: Record<string, unknown> = {},
  {
    active = false,
    pending = false,
  }: { active?: boolean; pending?: boolean } = {}
) {
  const hostnames = new Map<string, string>()
  const deleted: string[] = []
  const patched: string[] = []
  const fetched = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input))
      if (u.hostname === "cloudflare-dns.com") {
        const name = u.searchParams.get("name") ?? ""
        const type = u.searchParams.get("type")
        const recorded = doh[`${name} ${type}`] ?? DOH[`${name} ${type}`]
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
          return envelope({
            id: `h-${hostname}`,
            hostname,
            status: "pending",
            ownership_verification: {
              type: "txt",
              name: `_cf-custom-hostname.${hostname}`,
              value: `v-${hostname}`,
            },
          })
        }
        if (init?.method === "DELETE") {
          deleted.push(u.pathname.split("/").at(-1) ?? "")
          return envelope({ id: "x" })
        }
        const id = u.pathname.split("/").at(-1) ?? ""
        if (init?.method === "PATCH") patched.push(id)
        if (pending && hostnames.has(id)) {
          return envelope({
            id,
            hostname: hostnames.get(id),
            status: "pending",
            ssl: { status: "pending_validation" },
          })
        }
        if (active && hostnames.has(id)) {
          return envelope({
            id,
            hostname: hostnames.get(id),
            status: "active",
            ssl: { status: "active" },
          })
        }
        return envelope([])
      }
      // The edge probe: the router serving the last published site.
      if (u.pathname === "/" && served) {
        return new Response("ok", { headers: { [SITE_HEADER]: served } })
      }
      // Domain Connect settings hosts: nothing there.
      return new Response(null, { status: 404 })
    }
  )
  vi.stubGlobal("fetch", fetched)
  return { hostnames, deleted, patched }
}

/** An org with a published site: the preview fixture plus a deployment of its revision. */
async function published() {
  const site = await previewed()
  served = site.orgId
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
  const terminated: string[] = []
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
    SEARCHES: {
      get: async (id: string) => ({
        terminate: async () => {
          terminated.push(id)
        },
      }),
    },
  } as unknown as Env
  return { env, created, terminated }
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

  it("asks a second org for the ownership TXT once another org held the name", async () => {
    stubNet()
    const first = await published()
    const { env } = domainEnv(first.store)
    const name = unique()
    const body = { name, approval_id: "approval-1" }
    expect(await connect(env, kit, first.orgId, body)).toMatchObject({
      status: 201,
      output: { steps: [{ type: "CNAME" }] },
    })
    expect(await rowOf(first.orgId, name)).toMatchObject({ needsTxt: false })
    expect(await remove(env, kit, first.orgId, name)).toBeNull()

    const second = await published()
    const { env: env2, created } = domainEnv(second.store)
    const answer = await connect(env2, kit, second.orgId, body)
    const steps = [
      { type: "CNAME", name: "www", value: "domains.remeai.co.uk" },
      {
        type: "TXT",
        name: "_cf-custom-hostname.www",
        value: `v-www.${name}`,
      },
      { type: "TXT", name: "_cf-custom-hostname", value: `v-${name}` },
    ]
    expect(answer).toMatchObject({ status: 201, output: { steps } })
    const row = await rowOf(second.orgId, name)
    expect(row).toMatchObject({
      needsTxt: true,
      cfIds: { www: `h-www.${name}`, apex: `h-${name}` },
      ownership: {
        [`www.${name}`]: {
          name: `_cf-custom-hostname.www.${name}`,
          value: `v-www.${name}`,
        },
      },
    })
    expect(created).toHaveLength(1)
    // Asking again replays the same records from the row.
    expect(await connect(env2, kit, second.orgId, body)).toEqual({
      status: 200,
      output: (answer as { output: unknown }).output,
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
    const { env, created, terminated } = domainEnv(site.store)
    const name = unique()
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const row = await rowOf(site.orgId, name)
    const domainId = row?.id ?? ""

    expect(await claimHostnames(env, kit, site.orgId, domainId)).toMatchObject({
      ids: { www: `h-www.${name}`, apex: `h-${name}` },
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
    // Live is said on the `loads` probe, once the host serves this site.
    const loads = await loadsOf(env, kit, site.orgId, domainId)
    expect(loads.result).toMatchObject({ gone: false, ready: true })
    expect(await loads.reading?.tell?.()).toEqual({
      text: `www.${name} is live. ${site.slug} now forwards to it, so links you've shared still work.`,
      button: {
        label: "Open your website",
        action: { kind: "open", url: `https://www.${name}/` },
      },
    })
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
    expect(await typesOf(site.orgId, "domain.")).toContain("domain.activated")

    // A stale write-back from the router lands after activation; the settle
    // step's second write puts the redirect back.
    site.store.pointers.set(`host:${site.slug}`, "stale")
    await repoint(env, kit, site.orgId, domainId)
    expect(read(site.slug)).toEqual({ redirect_to: `www.${name}` })

    // The live domain verified in this org's Google account.
    const file = "google5e.html"
    site.store.pointers.set(`gsv:www.${name}:${file}`, "1")
    await kit.withOrg({ orgId: site.orgId }, (db) =>
      db.insert(searchProperties).values({
        orgId: site.orgId,
        host: `www.${name}`,
        siteUrl: `https://www.${name}/`,
        kind: "url_prefix",
        method: "file",
        token: file,
        state: "verified",
      })
    )

    expect(await remove(env, kit, site.orgId, name)).toBeNull()
    expect(await rowOf(site.orgId, name)).toMatchObject({ state: "removed" })
    // Its file and property go, so it proves nothing for the next holder.
    expect(site.store.pointers.has(`gsv:www.${name}:${file}`)).toBe(false)
    expect(
      await kit.withOrg({ orgId: site.orgId }, (db) =>
        db.select().from(searchProperties)
      )
    ).toEqual([])
    expect(terminated).toEqual([
      searchInstanceId(site.orgId, `www.${name}`),
      searchInstanceId(site.orgId, name),
    ])
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

    // Once the name is free another org may take it live; a late repeat of
    // this removal leaves that org's pointers alone.
    const theirs = JSON.stringify({
      org_id: crypto.randomUUID(),
      site_id: crypto.randomUUID(),
      revision_id: crypto.randomUUID(),
      config_version: 1,
    })
    site.store.pointers.set(`host:www.${name}`, theirs)
    site.store.pointers.set(
      `host:${name}`,
      JSON.stringify({ redirect_to: `www.${name}` })
    )
    await repoint(env, kit, site.orgId, domainId)
    expect(site.store.pointers.get(`host:www.${name}`)).toBe(theirs)
    expect(site.store.pointers.has(`host:${name}`)).toBe(true)
  })

  it("retires the live domain when another goes live, and a retry finds what it replaced", async () => {
    const net = stubNet()
    const site = await published()
    const { env } = domainEnv(site.store)
    const live = async (name: string) => {
      await connect(env, kit, site.orgId, { name, approval_id: "a" })
      const id = (await rowOf(site.orgId, name))?.id ?? ""
      await claimHostnames(env, kit, site.orgId, id)
      expect(await activateDomain(env, kit, site.orgId, id)).toBe(true)
      return id
    }
    const [first, second] = [unique(), unique()]
    await live(first)
    const secondId = await live(second)
    expect(await rowOf(site.orgId, first)).toMatchObject({ state: "removed" })
    expect(await rowOf(site.orgId, second)).toMatchObject({ state: "active" })
    const read = (host: string) =>
      JSON.parse(site.store.pointers.get(`host:${host}`) ?? "null")
    expect(site.store.pointers.has(`host:www.${first}`)).toBe(false)
    expect(read(site.slug)).toEqual({ redirect_to: `www.${second}` })
    expect(net.deleted).toEqual(
      expect.arrayContaining([`h-${first}`, `h-www.${first}`])
    )
    // A retried step stops serving the replaced one again and keeps the new one.
    net.deleted.length = 0
    expect(await activateDomain(env, kit, site.orgId, secondId)).toBe(true)
    expect(net.deleted).toEqual(
      expect.arrayContaining([`h-${first}`, `h-www.${first}`])
    )
    expect(read(`www.${second}`)).toMatchObject({ org_id: site.orgId })
    const loads = await loadsOf(env, kit, site.orgId, secondId)
    expect((await loads.reading?.tell?.())?.text).toContain(
      `www.${first} is no longer used`
    )
  })

  it("keeps one audit row per status and lets go of an org with no conversation", async () => {
    const site = await published()
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const say = { key: `${crypto.randomUUID()}:active`, text: "live" }
    await postStatus(kit, site.orgId, say)
    await postStatus(kit, site.orgId, say)
    expect(await typesOf(site.orgId, "domain.status")).toEqual([
      "domain.status",
    ])
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ code: "domain.status_unposted", key: say.key })
    )
    log.mockRestore()
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

    // With no model key, the nudge and the failed line are today's templates.
    expect((await nudge(env, kit, site.orgId, domainId, 1))?.text).toBe(
      `I'm still waiting for the records for ${name}. There's no need to tell me when they're in; I'll see them.`
    )
    expect(
      (await expireDomain(env, kit, site.orgId, domainId, "timeout"))?.text
    ).toBe(
      `I didn't see the records for ${name} within 3 days, so I've stopped watching. Your site stays on ${site.slug}. Ask me again any time.`
    )
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

  it("stops serving a live domain's hosts at takedown", async () => {
    stubNet()
    const site = await published()
    const { env } = domainEnv(site.store)
    const name = unique()
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const domainId = (await rowOf(site.orgId, name))?.id ?? ""
    await kit.withOrg({ orgId: site.orgId }, (db) =>
      db
        .update(domains)
        .set({ state: "verifying" })
        .where(eq(domains.id, domainId))
    )
    await activateDomain(env, kit, site.orgId, domainId)
    const hosts = [`www.${name}`, name, site.slug]
    expect(hosts.every((h) => site.store.pointers.has(`host:${h}`))).toBe(true)
    await clearPointers(env, kit, site.orgId)
    await revokeDomains(env, kit, site.orgId)
    expect(hosts.some((h) => site.store.pointers.has(`host:${h}`))).toBe(false)
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

  it("raises one alert and one message per change in a live domain, and nothing for no change", async () => {
    const site = await previewed()
    const name = unique()
    const www = `www.${name}`
    await kit.withOrg({ orgId: site.orgId }, (db) =>
      db.insert(domains).values({
        orgId: site.orgId,
        siteId: site.orgId,
        name,
        primaryHost: www,
        origin: "connected",
        method: "records",
        state: "active",
        cfIds: { www: `h-${www}`, apex: `h-${name}` },
        provider: {
          name: "GoDaddy",
          settings_url: "https://dcc.godaddy.com/manage/dns",
        },
        lastCheck: { status: "valid" },
        activatedAt: new Date(),
      })
    )
    const now = { status: "active", ssl: "active" }
    const read = vi.fn(async (_url: string | URL | Request) =>
      Response.json({
        success: true,
        errors: [],
        result: {
          id: `h-${www}`,
          hostname: www,
          status: now.status,
          ssl: { status: now.ssl },
        },
      })
    )
    vi.stubGlobal("fetch", read)
    const env = {
      CF_DOMAINS_TOKEN: "token",
      CF_DOMAINS_ZONE_ID: "zone",
      SITE_HOST_SUFFIX: SUFFIX,
    } as unknown as Env
    const alerts = async () =>
      (
        await kit.withOrg({ orgId: site.orgId }, (db) =>
          db
            .select({ payload: events.payload })
            .from(events)
            .where(eq(events.type, "alert.raised"))
        )
      )
        .map((e) => (e.payload as { kind: string }).kind)
        .sort()

    // Unchanged: nothing.
    expect(await sweepDomains(env, kit, site.orgId, "2026101606")).toEqual([])
    expect(String(read.mock.calls[0]?.[0])).toBe(`${CF}/h-${www}`)

    now.status = "moved"
    expect(await sweepDomains(env, kit, site.orgId, "2026101606")).toEqual([
      {
        key: expect.stringMatching(/:sweep:2026101606$/),
        text: `${www} no longer points at your website, so visitors there won't reach it. Point its record back at domains.remeai.co.uk and it comes back on its own.`,
        button: {
          label: "Open GoDaddy DNS settings",
          action: { kind: "open", url: "https://dcc.godaddy.com/manage/dns" },
        },
      },
    ])
    // The next day, still moved: no second alert or message.
    expect(await sweepDomains(env, kit, site.orgId, "2026101706")).toEqual([])
    expect(await alerts()).toEqual(["domain.invalid_configuration"])

    now.status = "active"
    now.ssl = "pending_validation"
    expect(await sweepDomains(env, kit, site.orgId, "2026101806")).toEqual([
      expect.objectContaining({
        text: `The secure certificate for ${www} isn't active right now, so visitors may see a warning. I'm keeping an eye on it.`,
      }),
    ])
    // Back to valid is recorded quietly.
    now.ssl = "active"
    expect(await sweepDomains(env, kit, site.orgId, "2026101906")).toEqual([])
    expect(await alerts()).toEqual([
      "domain.invalid_configuration",
      "domain.pending_certificate",
    ])
    expect(await rowOf(site.orgId, name)).toMatchObject({
      state: "active",
      lastCheck: { status: "valid" },
    })
  })

  it("connects a first-level subdomain on its own host, and a connecting check is never live", async () => {
    const name = unique()
    const sub = `book.${name}`
    const doh: Record<string, unknown> = {
      // No record at the subdomain yet: NXDOMAIN under a zone in use.
      [`${sub} SOA`]: {
        Status: 3,
        Authority: [{ name, type: 6, TTL: 60, data: "ns. host. 1 1 1 1 1" }],
      },
      [`${name} A`]: {
        Status: 0,
        Answer: [{ name, type: 1, TTL: 60, data: "192.0.2.10" }],
      },
    }
    const { hostnames } = stubNet(doh, { active: true })
    const site = await published()
    const { env } = domainEnv(site.store)
    const made = await connect(env, kit, site.orgId, {
      name: sub,
      approval_id: "a",
    })
    expect(made).toMatchObject({
      status: 201,
      output: {
        steps: [{ type: "CNAME", name: "book", value: "domains.remeai.co.uk" }],
      },
    })
    expect((made as { output: object }).output).not.toHaveProperty("apex")
    const row = await rowOf(site.orgId, sub)
    expect(row).toMatchObject({ primaryHost: sub, state: "awaiting_dns" })
    await claimHostnames(env, kit, site.orgId, row?.id ?? "")
    // The owner adds the record from the card.
    doh[`${sub} A`] = {
      Status: 0,
      Answer: [{ name: sub, type: 5, TTL: 60, data: "domains.remeai.co.uk." }],
    }
    expect([...hostnames.values()]).toEqual([sub])
    expect(await checkNow(env, kit, site.orgId, sub)).toMatchObject({
      state: "awaiting_dns",
      status: { status: "pending_certificate" },
      next_step: expect.stringContaining(`records for ${sub}`),
    })
  })

  it("refreshes validation for the owner's check, and not for a certificate event's", async () => {
    const name = unique()
    const sub = `book.${name}`
    const { patched } = stubNet(
      {
        [`${sub} SOA`]: {
          Status: 3,
          Authority: [{ name, type: 6, TTL: 60, data: "ns. host. 1 1 1 1 1" }],
        },
        [`${name} A`]: {
          Status: 0,
          Answer: [{ name, type: 1, TTL: 60, data: "192.0.2.10" }],
        },
      },
      { pending: true }
    )
    const site = await published()
    const { env } = domainEnv(site.store)
    await connect(env, kit, site.orgId, { name: sub, approval_id: "a" })
    const row = await rowOf(site.orgId, sub)
    await claimHostnames(env, kit, site.orgId, row?.id ?? "")
    await checkNow(env, kit, site.orgId, sub, false)
    expect(patched).toEqual([])
    await checkNow(env, kit, site.orgId, sub)
    expect(patched).toEqual([`h-${sub}`])
  })

  it("holds one live claim per subdomain, and asks for the TXT when its record already reaches us", async () => {
    const name = unique()
    const sub = `book.${name}`
    stubNet({
      [`${sub} SOA`]: {
        Status: 0,
        Authority: [{ name, type: 6, TTL: 60, data: "ns. host. 1 1 1 1 1" }],
      },
      // Left from an earlier tenant elsewhere: it reaches us before any claim.
      [`${sub} A`]: {
        Status: 0,
        Answer: [
          { name: sub, type: 5, TTL: 60, data: "domains.remeai.co.uk." },
        ],
      },
    })
    const site = await published()
    const { env, created } = domainEnv(site.store)
    const body = { name: sub, approval_id: "a" }
    // Its CNAME is already there, so the card asks for the TXT alone.
    expect(await connect(env, kit, site.orgId, body)).toMatchObject({
      status: 201,
      output: {
        steps: [
          {
            type: "TXT",
            name: "_cf-custom-hostname.book",
            value: `v-${sub}`,
          },
        ],
      },
    })
    expect(await rowOf(site.orgId, sub)).toMatchObject({
      needsTxt: true,
      cfIds: { apex: `h-${sub}` },
    })
    expect(created).toHaveLength(1)

    const other = await published()
    expect(await connect(env, kit, other.orgId, body)).toMatchObject({
      status: 409,
      code: "domain.in_use",
    })
  })

  it("counts subdomains towards the pending claims an org may hold", async () => {
    const name = unique()
    const subs = ["a", "b", "c", "d"].map((s) => `${s}.${name}`)
    stubNet({
      // No record at any of them yet, under a zone in use.
      ...Object.fromEntries(
        subs.map((sub) => [
          `${sub} SOA`,
          {
            Status: 3,
            Authority: [{ name, type: 6, TTL: 60, data: "ns. h. 1 1 1 1 1" }],
          },
        ])
      ),
      [`${name} A`]: {
        Status: 0,
        Answer: [{ name, type: 1, TTL: 60, data: "192.0.2.10" }],
      },
    })
    const site = await published()
    const { env } = domainEnv(site.store)
    for (const sub of subs.slice(0, 3)) {
      expect(
        await connect(env, kit, site.orgId, { name: sub, approval_id: "a" })
      ).toMatchObject({ status: 201 })
    }
    expect(
      await connect(env, kit, site.orgId, { name: subs[3], approval_id: "a" })
    ).toMatchObject({ status: 409, code: "domain.too_many_pending" })
  })

  it("holds the pending bound when connects arrive at once", async () => {
    stubNet()
    const site = await published()
    const { env } = domainEnv(site.store)
    const answers = await Promise.all(
      Array.from({ length: 6 }, () =>
        connect(env, kit, site.orgId, { name: unique(), approval_id: "a" })
      )
    )
    const statuses = answers.map((a) => a.status).sort()
    expect(statuses).toEqual([201, 201, 201, 409, 409, 409])
  })

  it("tells the owner about a record in the way once, however many looks find it", async () => {
    const name = unique()
    const www = `www.${name}`
    stubNet(
      {
        [`${www} A`]: {
          Status: 0,
          Answer: [{ name: www, type: 1, TTL: 60, data: "192.0.2.10" }],
        },
      },
      { active: true }
    )
    const site = await published()
    const { env } = domainEnv(site.store)
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const domainId = (await rowOf(site.orgId, name))?.id ?? ""
    await claimHostnames(env, kit, site.orgId, domainId)
    await openChat(kit, site.orgId)
    const told = vi.fn()
    const lookAt = (n: number) =>
      probe(
        stepped(),
        `look ${n}`,
        env,
        { orgId: site.orgId, kind: "address" },
        async (k) => {
          const seen = await look(env, k, site.orgId, domainId)
          const tell = seen.reading?.tell
          if (seen.reading && tell)
            seen.reading.tell = () => {
              told()
              return tell()
            }
          return seen
        }
      )
    const records = async () => {
      const [row] = await kit.withOrg({ orgId: site.orgId }, (db) =>
        db.select().from(taskSteps).where(sql`${taskSteps.step} = 'records'`)
      )
      return row
    }
    const first = await lookAt(1)
    const before = await records()
    expect(first).toMatchObject({
      status: "conflicting_record",
      say: { text: expect.stringContaining("192.0.2.10") },
    })
    // A retried post lands once.
    for (let i = 0; i < 2; i++) {
      if (first.gone || !first.say) throw new Error("no message")
      await postStatus(kit, site.orgId, first.say)
    }
    // The same check again, which jsonb also hands back reordered: no wording, no message.
    const again = await lookAt(2)
    expect(again).toMatchObject({ status: "conflicting_record" })
    expect(again).not.toHaveProperty("say")
    expect(told).toHaveBeenCalledTimes(1)
    expect(await chatTexts(kit, site.orgId)).toHaveLength(1)
    // The step waits on the owner, with what to do; the second probe moved
    // only `probed_at`.
    const after = await records()
    expect(after).toMatchObject({
      state: "blocked",
      blockedOn: "owner_action",
      note: "Delete the old A record at your DNS provider",
      probeHash: before?.probeHash,
      changedAt: before?.changedAt,
    })
    expect(after?.probeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(after?.probedAt).not.toEqual(before?.probedAt)
  })

  it("lets a removal that commits during an activation win", async () => {
    stubNet()
    const site = await published()
    const { env } = domainEnv(site.store)
    const name = unique()
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const domainId = (await rowOf(site.orgId, name))?.id ?? ""
    await kit.withOrg({ orgId: site.orgId }, (db) =>
      db
        .update(domains)
        .set({ state: "verifying" })
        .where(eq(domains.id, domainId))
    )
    const slugBefore = site.store.pointers.get(`host:${site.slug}`)
    let activation: Promise<unknown> = Promise.resolve()
    await kit.withOrg({ orgId: site.orgId }, async (db) => {
      await db
        .update(domains)
        .set({ state: "removed", removedAt: new Date() })
        .where(eq(domains.id, domainId))
      activation = activateDomain(env, kit, site.orgId, domainId)
      // Commit only once the activation's write waits on this row's lock.
      for (let i = 0; i < 100; i++) {
        const [waiting] = await kit.withOrg({ orgId: site.orgId }, (other) =>
          other.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_locks where not granted and locktype = 'transactionid'`
          )
        )
        if ((waiting?.n ?? 0) > 0) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })
    expect(await activation).toBe(false)
    expect(await rowOf(site.orgId, name)).toMatchObject({ state: "removed" })
    expect(await typesOf(site.orgId, "domain.activated")).toEqual([])
    expect(site.store.pointers.get(`host:${site.slug}`)).toBe(slugBefore)
  })

  it("fails a claim still connecting past its deadline when its Workflow never did", async () => {
    const net = stubNet()
    const site = await published()
    const { env } = domainEnv(site.store)
    const name = unique()
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const domainId = (await rowOf(site.orgId, name))?.id ?? ""
    await claimHostnames(env, kit, site.orgId, domainId)
    const age = (ms: number) =>
      kit.withOrg({ orgId: site.orgId }, (db) =>
        db
          .update(domains)
          .set({ createdAt: new Date(Date.now() - ms) })
          .where(eq(domains.id, domainId))
      )
    const HOUR = 60 * 60 * 1000
    // Inside the deadline and its hour of grace: the Workflow's to end.
    await age(DEADLINE_MS + HOUR / 2)
    expect(await sweepDomains(env, kit, site.orgId, "2026101906")).toEqual([])
    expect(await rowOf(site.orgId, name)).toMatchObject({
      state: "awaiting_dns",
    })
    await age(DEADLINE_MS + 2 * HOUR)
    expect(await sweepDomains(env, kit, site.orgId, "2026101906")).toEqual([
      expect.objectContaining({
        key: `${domainId}:failed`,
        text: expect.stringContaining(`within 3 days`),
      }),
    ])
    expect(await rowOf(site.orgId, name)).toMatchObject({ state: "failed" })
    expect([...net.deleted].sort((a, b) => a.localeCompare(b))).toEqual([
      `h-${name}`,
      `h-www.${name}`,
    ])
  })

  it("keeps the domain's pointers through a later publish and a rollback", async () => {
    stubNet()
    const site = await published()
    const { env } = domainEnv(site.store)
    const name = unique()
    const www = `www.${name}`
    await connect(env, kit, site.orgId, { name, approval_id: "a" })
    const domainId = (await rowOf(site.orgId, name))?.id ?? ""
    await kit.withOrg({ orgId: site.orgId }, (db) =>
      db
        .update(domains)
        .set({ state: "verifying" })
        .where(eq(domains.id, domainId))
    )
    await activateDomain(env, kit, site.orgId, domainId)
    const read = (host: string) =>
      JSON.parse(site.store.pointers.get(`host:${host}`) ?? "null")
    // A publish and a rollback are each a new deployment row and then the
    // publisher's `pointer` step, `writePointer` for the slug host it was
    // given; the row's kind plays no part in the pointer.
    for (const configVersion of [2, 3]) {
      await kit.withOrg({ orgId: site.orgId }, (db) =>
        db.insert(deployments).values({
          orgId: site.orgId,
          siteId: site.orgId,
          revisionId: site.revisionId,
          configVersion,
          kind: "rollback",
        })
      )
      expect(
        await writePointer(env, kit, site.orgId, site.orgId, site.slug)
      ).toEqual({ host: www })
      expect(read(www)).toMatchObject({
        config_version: configVersion,
        canonical_host: www,
        origin_host: site.slug,
      })
      expect(read(name)).toEqual({ redirect_to: www })
      expect(read(site.slug)).toEqual({ redirect_to: www })
    }
  })
})
