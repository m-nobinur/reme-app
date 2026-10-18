import { afterAll, describe, expect, it } from "vitest"
import { connect } from "../src/client.ts"

/**
 * `recent_designs` (migrations 0014, 0019) reads across tenants, so without
 * these two indexes every planner call scans every org's revisions. The
 * predicates must match the function body's, or the planner cannot use them.
 */
const { sql } = connect()

afterAll(() => sql.end())

describe("the indexes recent_designs is driven by", () => {
  it("holds the industry facts and each org's numbered revisions", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where indexname in ('facts_current_industry_idx', 'site_revisions_org_numbered_idx')
      order by indexname`
    expect(rows.map((r) => r.indexname)).toEqual([
      "facts_current_industry_idx",
      "site_revisions_org_numbered_idx",
    ])
    expect(rows[0]?.indexdef).toContain(
      "(((value ->> 'category'::text)), org_id) WHERE ((key = 'business.industry'::text) AND (valid_to IS NULL))"
    )
    expect(rows[1]?.indexdef).toContain(
      "(org_id, created_at) WHERE (version IS NOT NULL)"
    )
  })
})
