import {
  ChannelLink,
  ChannelLinkStarted,
  ChannelsState,
  ErrorEnvelope,
} from "@workspace/contracts"
import {
  channelLinkCodes,
  channelLinks,
  eq,
  memberships,
  orgs,
  type Tenancy,
  tenancy,
  users,
  whatsappAccounts,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { hashCode, sealToken } from "../src/channels/token.ts"
import worker from "../src/index.ts"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { cookieHeader, env, stubJwksFetch } from "./sealed-session.ts"

/**
 * The owner's channel routes on a live connection: the gate, who may call,
 * the caller's own links, one live code per person, and revoking.
 */

const url = process.env.DATABASE_URL
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const ON = { WHATSAPP_ENABLED: "1" }

const keyed = (method: string, body?: unknown) => ({
  method,
  headers: {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

describe.skipIf(!url)("channel routes, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let realFetch: typeof fetch
  let mine: Owner
  let theirs: Owner
  let number = Math.floor(Math.random() * 1e8) * 10 + 7e9

  const call = (
    as: Owner,
    path: string,
    init: Parameters<Owner["call"]>[2] = {},
    bindings: Record<string, unknown> = ON
  ) => as.call(stubOrchestrator(), path, { ...init, bindings })

  const userOf = (as: Owner) =>
    kit.withOrg(
      { orgId: as.orgId, workosUserId: as.workosUserId },
      async (db) => {
        const [row] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.workosUserId, as.workosUserId))
        return row?.id as string
      }
    )

  async function account(as: Owner, status: "active" | "pending" = "active") {
    const phone = `+44${number++}`
    await kit.withOrg({ orgId: as.orgId }, async (db) =>
      db.insert(whatsappAccounts).values({
        orgId: as.orgId,
        wabaId: `${number}1`,
        phoneNumberId: `${number}2`,
        displayNumber: phone,
        displayName: "Probe Cleaning",
        tokenCiphertext: await sealToken(
          { CHANNEL_TOKEN_KEY: KEY },
          as.orgId,
          "token"
        ),
        source: "dev",
        status,
      })
    )
    return phone
  }

  async function link(as: Owner, externalId: string) {
    const userId = await userOf(as)
    const [row] = await kit.withOrg(
      { orgId: as.orgId, workosUserId: as.workosUserId },
      async (db) => {
        const [acc] = await db.select().from(whatsappAccounts)
        return db
          .insert(channelLinks)
          .values({
            orgId: as.orgId,
            userId,
            accountId: (acc as { id: string }).id,
            externalId,
            label: `+44 7*** ***${externalId.slice(-3)}`,
          })
          .returning()
      }
    )
    return row as typeof channelLinks.$inferSelect
  }

  const codes = (as: Owner) =>
    kit.withOrg({ orgId: as.orgId }, (db) => db.select().from(channelLinkCodes))

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    mine = await owner(kit, url as string, "chan-a")
    theirs = await owner(kit, url as string, "chan-b")
  }, 60_000)
  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  it("answers 404 on every channel route while the gate is off", async () => {
    for (const [path, init] of [
      ["/channels", {}],
      ["/channels/whatsapp/link", keyed("POST")],
      [`/channels/links/${crypto.randomUUID()}`, keyed("DELETE")],
    ] as const) {
      const response = await call(mine, path, init, {})
      expect(response.status).toBe(404)
    }
    expect((await codes(mine)).length).toBe(0)
  })

  it("lists no account and no links before a number is connected, and refuses a code", async () => {
    const state = ChannelsState.parse(
      await (await call(mine, "/channels")).json()
    )
    expect(state).toEqual({
      whatsapp: { available: true, account: null, links: [] },
    })
    const started = await call(mine, "/channels/whatsapp/link", keyed("POST"))
    expect(started.status).toBe(409)
    expect(ErrorEnvelope.parse(await started.json()).code).toBe(
      "channels.no_account"
    )
  })

  it("refuses a member who is not the owner", async () => {
    const run = crypto.randomUUID().slice(0, 8)
    const workosUserId = `user_probe_chan_member_${run}`
    const [org] = await kit.withOrg({ orgId: mine.orgId }, (db) =>
      db
        .select({ workos: orgs.workosOrganizationId })
        .from(orgs)
        .where(eq(orgs.id, mine.orgId))
    )
    await kit.withOrg({ orgId: mine.orgId, workosUserId }, async (db) => {
      await db
        .insert(users)
        .values({ workosUserId, email: `member-${run}@owner-probe.invalid` })
      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, workosUserId))
      await db.insert(memberships).values({
        orgId: mine.orgId,
        userId: person?.id as string,
        workosMembershipId: `om_member_${run}`,
        role: "member",
        status: "active",
      })
    })
    const asMember = async (path: string, init: RequestInit = {}) =>
      worker.fetch(
        new Request(`http://api.invalid${path}`, {
          ...init,
          headers: {
            ...(await cookieHeader({
              sub: workosUserId,
              org_id: org?.workos as string,
              role: "member",
            })),
            ...(init.headers as Record<string, string>),
          },
        }),
        {
          ...env(url as string),
          ...ON,
          ORCHESTRATOR: stubOrchestrator(),
        } as unknown as Env,
        { waitUntil: () => undefined } as unknown as ExecutionContext
      )
    for (const [path, init] of [
      ["/channels", {}],
      ["/channels/whatsapp/link", keyed("POST")],
    ] as const) {
      const response = await asMember(path, init)
      expect(response.status).toBe(403)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "channels.not_owner"
      )
    }
    expect((await codes(mine)).length).toBe(0)
  })

  it("lists only the caller's live links, never a revoked or another org's", async () => {
    const phone = await account(mine)
    await account(theirs)
    const kept = await link(mine, "447700900001")
    const revoked = await link(mine, "447700900002")
    await link(theirs, "447700900003")
    await call(mine, `/channels/links/${revoked.id}`, keyed("DELETE"))

    const state = ChannelsState.parse(
      await (await call(mine, "/channels")).json()
    )
    expect(state.whatsapp.account?.display_number).toBe(phone)
    expect(state.whatsapp.links.map((l) => l.id)).toEqual([kept.id])
  })

  it("mints a wa.me link with a hashed code, and a new code ends the old one", async () => {
    const first = ChannelLinkStarted.parse(
      await (await call(mine, "/channels/whatsapp/link", keyed("POST"))).json()
    )
    const [, text] = first.url.split("?text=")
    const code = decodeURIComponent(text as string).replace("Connect Reme ", "")
    expect(first.url).toMatch(
      /^https:\/\/wa\.me\/447\d{9}\?text=Connect%20Reme%20/
    )
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const [row] = await codes(mine)
    expect(row?.hash).toBe(await hashCode(code))
    expect(row?.usedAt).toBeNull()
    expect(Date.parse(first.expires_at) - Date.now()).toBeLessThanOrEqual(
      10 * 60_000
    )

    await call(mine, "/channels/whatsapp/link", keyed("POST"))
    const after = await codes(mine)
    expect(after).toHaveLength(2)
    expect(after.filter((c) => c.usedAt === null)).toHaveLength(1)
    expect(after.find((c) => c.hash === row?.hash)?.usedAt).not.toBeNull()
  })

  it("refuses a code while the number is not active", async () => {
    const fresh = await owner(kit, url as string, "chan-c")
    await account(fresh, "pending")
    const response = await call(fresh, "/channels/whatsapp/link", keyed("POST"))
    expect(response.status).toBe(409)
  })

  it("changes the updates flag and revokes, and answers 404 for another org's or a gone link", async () => {
    const [own] = ChannelsState.parse(
      await (await call(mine, "/channels")).json()
    ).whatsapp.links
    const patched = await call(
      mine,
      `/channels/links/${own?.id}`,
      keyed("PATCH", { updates: false })
    )
    expect(ChannelLink.parse(await patched.json()).updates).toBe(false)

    const [other] = await kit.withOrg({ orgId: theirs.orgId }, (db) =>
      db.select().from(channelLinks)
    )
    for (const method of ["PATCH", "DELETE"]) {
      const response = await call(
        mine,
        `/channels/links/${other?.id}`,
        keyed(method, method === "PATCH" ? { updates: false } : undefined)
      )
      expect(response.status).toBe(404)
    }
    expect(
      (await call(mine, "/channels/links/not-a-uuid", keyed("DELETE"))).status
    ).toBe(404)

    const removed = await call(
      mine,
      `/channels/links/${own?.id}`,
      keyed("DELETE")
    )
    expect(removed.status).toBe(204)
    expect(
      (await call(mine, `/channels/links/${own?.id}`, keyed("DELETE"))).status
    ).toBe(404)
    const state = ChannelsState.parse(
      await (await call(mine, "/channels")).json()
    )
    expect(state.whatsapp.links).toEqual([])
  })
})
