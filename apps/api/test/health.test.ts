import { sql, tenancy } from "@workspace/db"
import { brightclean } from "@workspace/db/fixtures"
import { afterAll, describe, expect, it } from "vitest"
import { checkTenantPath, PROBE_ORG } from "../src/health.ts"

/**
 * The tenant-path half of `/health`. It needs a database and runs in the
 * `database` job beside the tenancy gate, which is the only place a claim
 * about RLS means anything. The routing half lives in `org.test.ts` with the
 * rest of the router.
 */

const url = process.env.DATABASE_URL

describe.skipIf(!url)("the tenant path, on a live connection", () => {
  const kit = tenancy(url as string, { max: 2 })
  afterAll(() => kit.close())

  it("reports the four things withOrg promises", async () => {
    const report = await checkTenantPath(kit)
    expect(report).toEqual({
      status: "ok",
      role: "reme_app",
      bypasses_rls: false,
      org_context: PROBE_ORG,
      rows_for_absent_org: 0,
    })
  })

  it("is not reporting zero because the database is empty", async () => {
    // The check above passes on a database with no rows at all, which would
    // make it worthless. This is the other side of the same read: a real org
    // sees itself through the same client, so the zero above is the policies
    // and not an absence.
    const seen = await kit.withOrg(
      { orgId: brightclean.org.id as string },
      async (db) => {
        const rows = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from orgs`
        )
        return rows[0]?.n ?? 0
      }
    )
    expect(
      seen,
      "no golden orgs in this database, so the probe above proves nothing. " +
        "Run: pnpm seed"
    ).toBe(1)
  })
})
