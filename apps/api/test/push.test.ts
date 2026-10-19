import { ErrorEnvelope, PushConfig, PushSubscribed } from "@workspace/contracts"
import {
  eq,
  memberships,
  orgs,
  pushSubscriptions,
  type Tenancy,
  tenancy,
  users,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { cookieHeader, env, stubJwksFetch } from "./sealed-session.ts"

/**
 * The push routes on a live connection. Who may subscribe is the org's owner;
 * the sender is tested in `apps/orchestrator/test/push.test.ts`.
 */

const url = process.env.DATABASE_URL

const keyed = (method: string, body?: unknown) => ({
  method,
  headers: {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const subscription = (endpoint = "https://fcm.googleapis.com/fcm/send/a1") => ({
  endpoint,
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA",
    auth: "tBHItJI5svbpez7",
  },
})

describe.skipIf(!url)("push routes, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let realFetch: typeof fetch
  let mine: Owner
  let theirs: Owner

  const call = (
    as: Owner,
    path: string,
    init: Parameters<Owner["call"]>[2] = {}
  ) => as.call(stubOrchestrator(), path, init)
  const rows = (as: Owner) =>
    kit.withOrg({ orgId: as.orgId }, (db) =>
      db.select().from(pushSubscriptions)
    )

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    mine = await owner(kit, url as string, "push-a")
    theirs = await owner(kit, url as string, "push-b")
  }, 60_000)
  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  it("offers the public key, or none where push is not set up", async () => {
    const none = await call(mine, "/push/config")
    expect(PushConfig.parse(await none.json())).toEqual({ public_key: null })
    const set = await call(mine, "/push/config", {
      bindings: { VAPID_PUBLIC_KEY: "BPublicKey" },
    })
    expect(PushConfig.parse(await set.json())).toEqual({
      public_key: "BPublicKey",
    })
  })

  it("stores a subscription for the owner, once per endpoint", async () => {
    const first = await call(
      mine,
      "/push/subscriptions",
      keyed("POST", subscription())
    )
    expect(first.status).toBe(201)
    const { id } = PushSubscribed.parse(await first.json())
    const again = await call(
      mine,
      "/push/subscriptions",
      keyed("POST", subscription())
    )
    expect(PushSubscribed.parse(await again.json()).id).toBe(id)
    const held = await rows(mine)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      orgId: mine.orgId,
      endpoint: subscription().endpoint,
    })
  })

  it("refuses an address that is no push service, and a request with no key", async () => {
    const bad = await call(
      mine,
      "/push/subscriptions",
      keyed("POST", subscription("https://internal.example.test/hook"))
    )
    expect(bad.status).toBe(400)
    expect(ErrorEnvelope.parse(await bad.json()).code).toBe("request.invalid")
    const keyless = await call(mine, "/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription()),
    })
    expect(keyless.status).toBe(400)
    expect(ErrorEnvelope.parse(await keyless.json()).code).toBe(
      "idempotency_key.missing"
    )
  })

  it("removes a subscription, and answers 404 for another org's or a gone one", async () => {
    const made = await call(
      theirs,
      "/push/subscriptions",
      keyed("POST", subscription("https://fcm.googleapis.com/fcm/send/b1"))
    )
    const { id: theirId } = PushSubscribed.parse(await made.json())
    const crossed = await call(
      mine,
      `/push/subscriptions/${theirId}`,
      keyed("DELETE")
    )
    expect(crossed.status).toBe(404)
    expect(await rows(theirs)).toHaveLength(1)

    const [own] = await rows(mine)
    const removed = await call(
      mine,
      `/push/subscriptions/${own?.id}`,
      keyed("DELETE")
    )
    expect(removed.status).toBe(204)
    const again = await call(
      mine,
      `/push/subscriptions/${own?.id}`,
      keyed("DELETE")
    )
    expect(again.status).toBe(404)
    expect(
      (await call(mine, "/push/subscriptions/not-an-id", keyed("DELETE")))
        .status
    ).toBe(404)
  })

  /** A signed-in member of `as`'s org who is not its owner, calling the api. */
  async function asMember(as: Owner) {
    const run = crypto.randomUUID().slice(0, 8)
    const workosUserId = `user_probe_member_${run}`
    const [org] = await kit.withOrg({ orgId: as.orgId }, (db) =>
      db
        .select({ workos: orgs.workosOrganizationId })
        .from(orgs)
        .where(eq(orgs.id, as.orgId))
    )
    await kit.withOrg({ orgId: as.orgId, workosUserId }, async (db) => {
      await db
        .insert(users)
        .values({ workosUserId, email: `member-${run}@owner-probe.invalid` })
      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, workosUserId))
      await db.insert(memberships).values({
        orgId: as.orgId,
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
          ORCHESTRATOR: stubOrchestrator(),
        } as unknown as Env,
        { waitUntil: () => undefined } as unknown as ExecutionContext
      )
  }

  it("refuses a member who is not the owner: no subscribing, no removing, and the owner's list is untouched", async () => {
    const [own] = await rows(mine)
    const member = await asMember(mine)

    const added = await member(
      "/push/subscriptions",
      keyed("POST", subscription("https://fcm.googleapis.com/fcm/send/m1"))
    )
    expect(added.status).toBe(403)
    expect(ErrorEnvelope.parse(await added.json()).code).toBe("push.not_owner")

    const removed = await member(
      `/push/subscriptions/${own?.id}`,
      keyed("DELETE")
    )
    expect(removed.status).toBe(403)
    expect(ErrorEnvelope.parse(await removed.json()).code).toBe(
      "push.not_owner"
    )

    // Only the owner's subscription is there.
    const left = await rows(mine)
    expect(left.map((row) => row.id)).toEqual(own ? [own.id] : [])
    expect(left.some((row) => row.endpoint.endsWith("/m1"))).toBe(false)
  })

  it("answers a member's config request, since the public key is no secret", async () => {
    const member = await asMember(mine)
    const response = await member("/push/config")
    expect(response.status).toBe(200)
    expect(PushConfig.parse(await response.json())).toEqual({
      public_key: null,
    })
  })
})
