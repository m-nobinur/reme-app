import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connect } from "../src/client.ts"
import {
  APP_ROLE,
  ENTER_APP_ROLE,
  ORG_SETTING,
  setOrgContext,
  withOrg,
} from "../src/tenancy.ts"
import {
  clearTwoOrgs,
  ORG_A,
  ORG_ABSENT,
  ORG_B,
  seedTwoOrgs,
} from "./fixtures.ts"

/**
 * The blocking tenancy gate (§9.2, eng guide §5).
 *
 * It discovers the tables from the catalog rather than listing them, which is
 * the only version that fails on a table someone adds tomorrow. Two orgs are
 * seeded through the migrator connection and every assertion below runs through
 * `withOrg`, which is the path the API will use.
 *
 * `ORG_A` reads and writes; `ORG_B` exists only to be denied.
 */

/** The tenant root scopes on its own key rather than on an `org_id` column. */
const TENANT_ROOT = "orgs"

/**
 * Tables that are deliberately not tenant-scoped. Empty, and adding a name
 * here is the decision to put data outside the tenant boundary: it needs a
 * reviewer who agrees, not a passing build.
 */
const PLATFORM_TABLES = new Set<string>()

/** Postgres `insufficient_privilege`, which is what an RLS refusal raises. */
const RLS_DENIED = "42501"

type Discovered = {
  name: string
  rlsEnabled: boolean
  orgColumn: string | null
  orgNullable: boolean
}

type Policy = {
  tablename: string
  policyname: string
  cmd: string
  qual: string | null
  with_check: string | null
}

/**
 * Discovery runs at collection time, not in `beforeAll`: the per-table cases
 * below are generated from it, and a `beforeAll` would still be empty when
 * vitest asks what tests exist.
 */
async function discover() {
  const { sql: raw } = connect()
  const rows = await raw<
    {
      name: string
      rls_enabled: boolean
      has_org_id: boolean
      org_nullable: boolean
    }[]
  >`
    select c.relname as name,
           c.relrowsecurity as rls_enabled,
           a.attname is not null as has_org_id,
           coalesce(not a.attnotnull, false) as org_nullable
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a
      on a.attrelid = c.oid
     and a.attname = 'org_id'
     and a.attnum > 0
     and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`
  const policies = await raw<Policy[]>`
    select tablename, policyname, cmd, qual, with_check
    from pg_policies where schemaname = 'public'`
  await raw.end()
  const tables: Discovered[] = rows.map((row) => ({
    name: row.name,
    rlsEnabled: row.rls_enabled,
    orgColumn:
      row.name === TENANT_ROOT ? "id" : row.has_org_id ? "org_id" : null,
    orgNullable: row.org_nullable,
  }))
  return {
    tables,
    tenantTables: tables.filter((t) => t.orgColumn !== null),
    policies,
  }
}

const { tables, tenantTables, policies } = await discover()

/** One case per discovered tenant table. */
const cases = tenantTables.map((t) => [t.name, t] as const)

/** Every error shape postgres.js can be wrapped in on the way out of drizzle. */
function errorCode(error: unknown): string | undefined {
  const seen = error as { code?: string; cause?: { code?: string } }
  return seen.code ?? seen.cause?.code
}

async function denied(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    return errorCode(error)
  }
  return undefined
}

beforeAll(async () => {
  await seedTwoOrgs()
}, 60_000)

afterAll(async () => {
  await clearTwoOrgs()
})

describe("the catalog", () => {
  it("found the tables to test", () => {
    expect(tenantTables.length).toBeGreaterThan(0)
  })

  it("has no table outside the tenant boundary", () => {
    const stray = tables
      .filter((t) => t.orgColumn === null && !PLATFORM_TABLES.has(t.name))
      .map((t) => t.name)
    expect(
      stray,
      "a public table with no org_id is either a tenant table missing its column " +
        "or a deliberate platform table, and PLATFORM_TABLES in this file is where " +
        "the second one is declared"
    ).toEqual([])
  })
})

describe("every tenant table carries a policy", () => {
  it("enumerates the same tables the schema does", () => {
    // Not a hardcoded expectation of which tables exist, a floor: the suite is
    // useless if discovery silently returns nothing.
    expect(tenantTables.map((t) => t.name)).toContain(TENANT_ROOT)
  })

  it.each(cases)("%s", (name, table) => {
    expect(table.rlsEnabled, `${name} has no ENABLE ROW LEVEL SECURITY`).toBe(
      true
    )
    const own = policies.filter((p) => p.tablename === name)
    expect(
      own.length,
      `${name} has RLS on and no policy, so it denies all`
    ).toBeGreaterThan(0)
    for (const policy of own) {
      expect(
        policy.qual,
        `${policy.policyname} does not read ${ORG_SETTING}`
      ).toContain(ORG_SETTING)
      // A policy that can write and has no WITH CHECK lets a row be written
      // into another org. FOR ALL falls back to USING, which is why this
      // reads as a shape check rather than a null check.
      if (["ALL", "INSERT", "UPDATE"].includes(policy.cmd)) {
        expect(
          policy.with_check,
          `${policy.policyname} writes with no WITH CHECK`
        ).toContain(ORG_SETTING)
      }
    }
  })
})

describe("the reading transaction runs as a role that cannot bypass", () => {
  it("switches to reme_app and back", async () => {
    const inside = await withOrg({ orgId: ORG_A }, async (db) => {
      const rows = await db.execute<{ who: string; bypass: boolean }>(sql`
        select current_user as who,
               (select rolbypassrls from pg_roles where rolname = current_user)
                 as bypass`)
      return rows[0]
    })
    expect(inside?.who).toBe(APP_ROLE)
    expect(inside?.bypass, "the app role must not hold BYPASSRLS").toBe(false)
  })

  it("sets the role and the org context transaction-locally", () => {
    // The trap this story exists to close, asserted where it is assertable.
    // On a direct connection a session-scoped setting and a transaction-scoped
    // one read back the same, so there is no behaviour to observe here; the
    // difference appears only through a transaction pooler, and `pooler.test.ts`
    // measures it against Neon. What runs everywhere, CI included, is that the
    // statements `withOrg` issues are the LOCAL forms.
    const dialect = new PgDialect()
    expect(dialect.sqlToQuery(ENTER_APP_ROLE).sql).toBe(
      `set local role ${APP_ROLE}`
    )
    const context = dialect.sqlToQuery(setOrgContext(ORG_A))
    expect(context.sql.replace(/\s+/g, " ")).toBe(
      "select set_config($1, $2, true)"
    )
    expect(context.params).toEqual([ORG_SETTING, ORG_A])
  })
})

describe("cross-org access is denied through raw SQL", () => {
  it.each(cases)(
    "%s",
    async (name, table) => {
      const column = sql.identifier(table.orgColumn as string)
      const relation = sql.identifier(name)

      const [mine, theirs] = await withOrg({ orgId: ORG_A }, async (db) => {
        const a = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${relation} where ${column} = ${ORG_A}`
        )
        const b = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${relation} where ${column} = ${ORG_B}`
        )
        return [a[0]?.n ?? 0, b[0]?.n ?? 0]
      })
      expect(
        mine,
        `${name} has no fixture row for org A, so denying org B proves nothing. ` +
          "Add rows for both orgs in tenancy/fixtures.ts."
      ).toBeGreaterThan(0)
      expect(theirs, `${name} leaked rows from another org`).toBe(0)

      // A write aimed at another org's rows finds nothing to write to.
      const touched = await withOrg({ orgId: ORG_A }, async (db) => {
        const result = await db.execute(
          sql`update ${relation} set ${column} = ${column} where ${column} = ${ORG_B}`
        )
        return (result as unknown as { count: number }).count
      })
      expect(touched, `${name} allowed a write into another org`).toBe(0)

      // And a write that would move one of our own rows across the boundary is
      // refused by WITH CHECK. `orgs` moves to an id that was never inserted,
      // so the refusal cannot be mistaken for a primary-key collision.
      const target = name === TENANT_ROOT ? ORG_ABSENT : ORG_B
      const code = await denied(() =>
        withOrg({ orgId: ORG_A }, (db) =>
          db.execute(
            sql`update ${relation} set ${column} = ${target} where ${column} = ${ORG_A}`
          )
        )
      )
      expect(code, `${name} let a row be moved into another org`).toBe(
        RLS_DENIED
      )

      if (table.orgNullable) {
        // A nullable org_id means a lenient read policy, and a lenient read
        // policy is one careless WITH CHECK away from letting a tenant mint
        // platform-level rows.
        const nulled = await denied(() =>
          withOrg({ orgId: ORG_A }, (db) =>
            db.execute(
              sql`update ${relation} set ${column} = null where ${column} = ${ORG_A}`
            )
          )
        )
        expect(nulled, `${name} let a tenant write a platform-level row`).toBe(
          RLS_DENIED
        )
      }
    },
    60_000
  )
})

describe("no org context reads nothing", () => {
  it("denies every tenant row when app.org_id was never set", async () => {
    const { sql: raw } = connect()
    const counts = await raw.begin(async (tx) => {
      await tx`set local role reme_app`
      const seen: Record<string, number> = {}
      for (const table of tenantTables) {
        const [row] = await tx.unsafe(
          `select count(*)::int as n from "${table.name}" ` +
            `where "${table.orgColumn}" is not null`
        )
        seen[table.name] = row?.n ?? 0
      }
      return seen
    })
    await raw.end()
    for (const [name, n] of Object.entries(counts)) {
      expect(n, `${name} is readable with no org context`).toBe(0)
    }
  })
})

describe("withOrg refuses a context it cannot trust", () => {
  it("rejects an org_id that is not a uuid", async () => {
    await expect(
      withOrg({ orgId: "'; drop table orgs; --" }, async () => 1)
    ).rejects.toThrow(/uuid/)
  })
})
