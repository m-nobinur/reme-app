import { eq, orgs, scheduledJobs, type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

/** `PUT /time-zone` on a live connection: the browser's zone as the app loads. */

const url = process.env.DATABASE_URL

const put = (body: unknown, key = true) => ({
  method: "PUT",
  headers: {
    "content-type": "application/json",
    ...(key ? { "idempotency-key": crypto.randomUUID() } : {}),
  },
  body: JSON.stringify(body),
})

describe.skipIf(!url)("the time zone route, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let realFetch: typeof fetch
  let mine: Owner

  const send = (body: unknown, key = true) =>
    mine.call(stubOrchestrator(), "/time-zone", put(body, key))
  const zoneOf = () =>
    kit.withOrg({ orgId: mine.orgId }, async (db) => ({
      zone: (await db.select({ z: orgs.timeZone }).from(orgs))[0]?.z,
      next: (
        await db.select({ at: scheduledJobs.nextRunAt }).from(scheduledJobs)
      )[0]?.at.toISOString(),
    }))

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    mine = await owner(kit, url as string, "time-zone")
    // Signup made the heartbeat; daily at 09:00 in the org's zone.
    await kit.withOrg({ orgId: mine.orgId }, (db) =>
      db
        .update(scheduledJobs)
        .set({
          rule: "0 9 * * *",
          nextRunAt: new Date(Date.now() + 30 * 86_400_000),
        })
        .where(eq(scheduledJobs.kind, "heartbeat"))
    )
  }, 60_000)
  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  it("stores the browser's zone and moves the org's recurring jobs into it", async () => {
    expect((await send({ time_zone: "Asia/Dhaka" })).status).toBe(204)
    const dhaka = await zoneOf()
    expect(dhaka.zone).toBe("Asia/Dhaka")
    // 09:00 in Dhaka is 03:00 UTC.
    expect(dhaka.next).toMatch(/T03:00:00\.000Z$/)

    // The same zone again changes nothing.
    expect((await send({ time_zone: "Asia/Dhaka" })).status).toBe(204)
    expect(await zoneOf()).toEqual(dhaka)
  })

  it("refuses a zone Intl does not know, and a write with no key", async () => {
    expect((await send({ time_zone: "Mars/Olympus_Mons" })).status).toBe(400)
    expect((await send({ time_zone: "Europe/London" }, false)).status).toBe(400)
    expect((await zoneOf()).zone).toBe("Asia/Dhaka")
  })
})
