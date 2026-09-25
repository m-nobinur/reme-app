import { eq, sql } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import { supersedeFact } from "../src/facts.ts"
import { facts, orgs } from "../src/schema.ts"
import { withOrg } from "../src/tenancy.ts"

/**
 * A jsonb string through the real stack: `supersedeFact`, drizzle and
 * postgres.js against Postgres, under `withOrg`. `test/jsonb.test.ts` pins
 * the column's own mapping; this is the one that fails if a driver bump
 * changes whether postgres.js parses jsonb before drizzle sees it.
 */
const ORG = crypto.randomUUID()
const STRINGS = ["123", "true", "null", "[1,2]", '"quoted"', "Street parking"]

afterAll(async () => {
  const { sql: client, db } = connect()
  try {
    await db.transaction((tx) => clearOrgs(tx, [ORG], []))
  } finally {
    await client.end()
  }
})

describe("a jsonb fact value, stored and read back", () => {
  it("keeps a string that looks like JSON a string, and an object an object", async () => {
    const values: unknown[] = [...STRINGS, { open: "08:00", close: "18:00" }]
    const read = await withOrg({ orgId: ORG }, async (db) => {
      await db.insert(orgs).values({
        id: ORG,
        slug: `jsonb-probe-${ORG.slice(0, 8)}`,
        name: "Jsonb probe (fixture)",
      })
      for (const [i, value] of values.entries()) {
        await supersedeFact(db, {
          orgId: ORG,
          key: `probe.value_${i}`,
          factType: "probe",
          value,
          provenance: { source: "owner_stated", confidence: 1 },
        })
      }
      return db
        .select({
          key: facts.key,
          value: facts.value,
          type: sql<string>`jsonb_typeof(${facts.value})`,
        })
        .from(facts)
        .where(eq(facts.orgId, ORG))
        .orderBy(facts.key)
    })
    expect(read).toEqual(
      values.map((value, i) => ({
        key: `probe.value_${i}`,
        value,
        type: typeof value === "string" ? "string" : "object",
      }))
    )
  })
})
