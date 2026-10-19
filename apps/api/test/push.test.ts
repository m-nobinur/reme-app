import { ErrorEnvelope, PushConfig, PushSubscribed } from "@workspace/contracts"
import { pushSubscriptions, type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

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
})
