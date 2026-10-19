import { asc, eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import { addPushSubscription, PUSH_SUBSCRIPTION_CAP } from "../src/push.ts"
import { orgs, pushSubscriptions, staff } from "../src/schema.ts"
import { withOrg } from "../src/tenancy.ts"

/** `addPushSubscription` against Postgres: the per-staff cap and the replay of one endpoint. */
const ORG = crypto.randomUUID()
const STAFF = crypto.randomUUID()
const OTHER = crypto.randomUUID()

const endpoint = (n: number) => `https://push.example.test/${n}`
const add = (n: number, staffId = STAFF) =>
  withOrg({ orgId: ORG }, (db) =>
    addPushSubscription(db, {
      orgId: ORG,
      staffId,
      endpoint: endpoint(n),
      p256dh: `p${n}`,
      auth: `a${n}`,
    })
  )
const endpoints = (staffId: string) =>
  withOrg({ orgId: ORG }, async (db) =>
    (
      await db
        .select({ endpoint: pushSubscriptions.endpoint })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.staffId, staffId))
        .orderBy(asc(pushSubscriptions.createdAt))
    ).map((row) => row.endpoint)
  )

afterAll(async () => {
  const { sql: client, db } = connect()
  try {
    await db.transaction((tx) => clearOrgs(tx, [ORG], []))
  } finally {
    await client.end()
  }
})

describe("push subscriptions", () => {
  it("drops the oldest when a staff member passes the cap, and leaves another's alone", async () => {
    await withOrg({ orgId: ORG }, async (db) => {
      await db.insert(orgs).values({
        id: ORG,
        slug: `push-probe-${ORG.slice(0, 8)}`,
        name: "Push probe (fixture)",
      })
      // One root per org, so the second reports to the first.
      for (const [i, id] of [STAFF, OTHER].entries()) {
        await db.insert(staff).values({
          id,
          orgId: ORG,
          staffCode: `COS-00${i + 1}`,
          displayName: "Push probe",
          kind: "agent",
          status: "active",
          managerId: i === 0 ? null : STAFF,
        })
      }
    })
    await add(1000, OTHER)
    for (let n = 1; n <= PUSH_SUBSCRIPTION_CAP; n++) await add(n)
    expect(await endpoints(STAFF)).toHaveLength(PUSH_SUBSCRIPTION_CAP)
    await add(PUSH_SUBSCRIPTION_CAP + 1)
    const kept = await endpoints(STAFF)
    expect(kept).toHaveLength(PUSH_SUBSCRIPTION_CAP)
    expect(kept).not.toContain(endpoint(1))
    expect(kept.at(-1)).toBe(endpoint(PUSH_SUBSCRIPTION_CAP + 1))
    expect(await endpoints(OTHER)).toEqual([endpoint(1000)])
  })

  it("keeps one row when the same endpoint subscribes again, with the new keys", async () => {
    const first = await add(2000)
    const second = await add(2000)
    expect(second).toBe(first)
    const [row] = await withOrg({ orgId: ORG }, (db) =>
      db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint(2000)))
    )
    expect(row?.p256dh).toBe("p2000")
  })
})
