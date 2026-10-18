import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import { supersedeFact } from "../src/facts.ts"
import { facts, orgs } from "../src/schema.ts"
import { withOrg } from "../src/tenancy.ts"

/** Two writers superseding one fact at once, each in its own transaction. */
const ORG = crypto.randomUUID()
const ctx = { orgId: ORG }

const save = (value: string) => (db: Parameters<typeof supersedeFact>[0]) =>
  supersedeFact(db, {
    orgId: ORG,
    key: "business.phone",
    factType: "business",
    value,
    provenance: { source: "owner_stated", confidence: 1 },
  })

beforeAll(() =>
  withOrg(ctx, async (db) => {
    await db.insert(orgs).values({
      id: ORG,
      slug: `facts-probe-${ORG.slice(0, 8)}`,
      name: "Facts probe (fixture)",
    })
    await save("first")(db)
  })
)

afterAll(async () => {
  const { sql: client, db } = connect()
  try {
    await db.transaction((tx) => clearOrgs(tx, [ORG], []))
  } finally {
    await client.end()
  }
})

describe("two concurrent supersedes of one fact", () => {
  it("both land, one version after the other", async () => {
    // The first holds its transaction open long enough for the second to
    // reach the same current row before it commits.
    const first = withOrg(ctx, async (db) => {
      const saved = await save("second")(db)
      await new Promise((resolve) => setTimeout(resolve, 300))
      return saved
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = withOrg(ctx, save("third"))
    const versions = (await Promise.all([first, second])).map((s) => s.version)
    expect(versions).toEqual([2, 3])

    const rows = await withOrg(ctx, (db) =>
      db
        .select({ value: facts.value, validTo: facts.validTo })
        .from(facts)
        .where(eq(facts.key, "business.phone"))
        .orderBy(facts.version)
    )
    expect(rows.map((r) => [r.value, r.validTo === null])).toEqual([
      ["first", false],
      ["second", false],
      ["third", true],
    ])
  })
})
