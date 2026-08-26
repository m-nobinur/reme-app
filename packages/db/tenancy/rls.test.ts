import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connect } from "../src/client.ts"
import {
  APP_ROLE,
  ENTER_APP_ROLE,
  ORG_SETTING,
  type OrgScopedDb,
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
 * Tables the schema calls append-only: `staff_events` (§5.2) and `events`
 * (§10.1 store 6, R7, the log context derivation replays). Neither carries an
 * `updated_at` and nothing is meant to rewrite or erase a row in either, so the
 * app role holds SELECT and INSERT on them and nothing else.
 */
const APPEND_ONLY = new Set(["events", "staff_events"])

/**
 * Objects this file creates to prove the gate fails when it should. Dropped
 * before discovery reads the catalog as well as after each fixture, so a run
 * killed mid-test does not leave one behind for the next run to mistake for a
 * relation someone added.
 */
const PROBE_LEAKY = "tenancy_probe_leaky_view"
const PROBE_SCOPED = "tenancy_probe_scoped_view"
const PROBE_SEQ = "tenancy_probe_seq"

/**
 * Tables that are deliberately not tenant-scoped. Empty, and adding a name
 * here is the decision to put data outside the tenant boundary: it needs a
 * reviewer who agrees, not a passing build.
 */
const PLATFORM_TABLES = new Set<string>()

/**
 * Postgres `insufficient_privilege`. Both refusals asserted below raise it: a
 * row the policies hide, and a privilege the role was never granted.
 */
const DENIED = "42501"

/**
 * The relation kinds a tenant can read through. `ALTER DEFAULT PRIVILEGES ...
 * ON TABLES` uses `defaclobjtype 'r'`, and in Postgres that means relations
 * rather than tables: a view, a materialised view, a partitioned parent and a
 * foreign table are all granted to `reme_app` on creation with no `GRANT`
 * written anywhere. Discovering only `'r'` covered a fraction of what the
 * grants covered.
 */
const READABLE_KINDS = ["r", "p", "v", "m", "f"] as const
type Kind = (typeof READABLE_KINDS)[number]

/** Kinds that hold rows of their own, and so can carry RLS in their own right. */
const STORED_KINDS = new Set<Kind>(["r", "p"])

type Discovered = {
  name: string
  kind: Kind
  rlsEnabled: boolean
  orgColumn: string | null
  orgNullable: boolean
  /** Whether `reme_app` can read it at all. Ungranted is the other safe answer. */
  appCanRead: boolean
  /** `reloptions`, joined. `security_invoker=on` is the one that matters. */
  options: string
}

type Raw = ReturnType<typeof connect>["sql"]

/**
 * A view runs as its owner unless it says otherwise, and the owner here is the
 * role that holds BYPASSRLS. `security_invoker = on` makes it run as the
 * caller, at which point the base tables' policies apply and it is as scoped as
 * they are. Materialised views and foreign tables have no such option, so for
 * those the only safe answer is not being granted at all.
 */
const runsAsInvoker = (r: Discovered) =>
  r.kind === "v" && /(^|,)security_invoker=(on|true)(,|$)/i.test(r.options)

/** Left behind only by a killed run. Dropping first keeps that from cascading. */
async function dropProbes(raw: Raw) {
  await raw.unsafe(`drop view if exists public.${PROBE_LEAKY}`)
  await raw.unsafe(`drop view if exists public.${PROBE_SCOPED}`)
  await raw.unsafe(`drop table if exists public.${PROBE_SEQ}`)
}

async function readRelations(raw: Raw): Promise<Discovered[]> {
  const rows = await raw<
    {
      name: string
      kind: Kind
      rls_enabled: boolean
      has_org_id: boolean
      org_nullable: boolean
      app_can_read: boolean
      options: string
    }[]
  >`
    select c.relname as name,
           c.relkind::text as kind,
           c.relrowsecurity as rls_enabled,
           a.attname is not null as has_org_id,
           coalesce(not a.attnotnull, false) as org_nullable,
           has_table_privilege(${APP_ROLE}::name, c.oid, 'select') as app_can_read,
           coalesce(array_to_string(c.reloptions, ','), '') as options
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute a
      on a.attrelid = c.oid
     and a.attname = 'org_id'
     and a.attnum > 0
     and not a.attisdropped
    where n.nspname = 'public'
      and c.relkind = any(${[...READABLE_KINDS]}::"char"[])
    order by c.relname`
  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    rlsEnabled: row.rls_enabled,
    orgColumn:
      row.name === TENANT_ROOT ? "id" : row.has_org_id ? "org_id" : null,
    orgNullable: row.org_nullable,
    appCanRead: row.app_can_read,
    options: row.options,
  }))
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
  await dropProbes(raw)
  const relations = await readRelations(raw)
  const policies = await raw<Policy[]>`
    select tablename, policyname, cmd, qual, with_check
    from pg_policies where schemaname = 'public'`
  await raw.end()
  const tables = relations.filter((r) => STORED_KINDS.has(r.kind))
  return {
    tables,
    tenantTables: tables.filter((t) => t.orgColumn !== null),
    // Views, materialised views and foreign tables hold no rows of their own,
    // so RLS is not the question for them. What they are granted is.
    derived: relations.filter((r) => !STORED_KINDS.has(r.kind)),
    policies,
  }
}

const { tables, tenantTables, derived, policies } = await discover()

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

// The same 60 s the seed gets. A clear that runs past vitest's ten-second
// default is torn down mid-way, and the next run starts on a half-cleared
// database.
afterAll(async () => {
  await clearTwoOrgs()
}, 60_000)

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

  it("has no derived relation that reads around the policies", () => {
    // The grants reach further than the tables. A view created with no GRANT
    // written anywhere is granted to `reme_app` by the default privileges from
    // migration 0001, and a view runs as its owner unless it says otherwise:
    // the first reporting view anyone writes is a full-tenant read behind a
    // green gate. A partitioned parent leaks the same way, and is covered
    // above instead, because it needs RLS of its own like any other table.
    const leaky = derived
      .filter((r) => r.appCanRead && !runsAsInvoker(r))
      .map((r) => `${r.name} (relkind ${r.kind})`)
    expect(
      leaky,
      "granted to " +
        APP_ROLE +
        " and running as its owner, which holds BYPASSRLS. Either create the " +
        "view `with (security_invoker = on)` so the base tables' policies " +
        "apply, or revoke it: `REVOKE ALL ON <name> FROM " +
        APP_ROLE +
        "`. A materialised view or a foreign table has no invoker option, so " +
        "revoking is the only answer for those"
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

      if (APPEND_ONLY.has(name)) {
        // Append-only, so the write probes below are not the question: there is
        // no legitimate UPDATE or DELETE to scope. RLS would confine one to the
        // caller's own org, which is a tenant erasing its own audit trail
        // rather than a cross-tenant hole, and the grant said it could.
        const updated = await denied(() =>
          withOrg({ orgId: ORG_A }, (db) =>
            db.execute(
              sql`update ${relation} set ${column} = ${column} where ${column} = ${ORG_A}`
            )
          )
        )
        expect(
          updated,
          `${name} is append-only and still grants UPDATE to ${APP_ROLE}`
        ).toBe(DENIED)
        const deleted = await denied(() =>
          withOrg({ orgId: ORG_A }, (db) =>
            db.execute(sql`delete from ${relation} where ${column} = ${ORG_A}`)
          )
        )
        expect(
          deleted,
          `${name} is append-only and still grants DELETE to ${APP_ROLE}`
        ).toBe(DENIED)
        return
      }

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
      expect(code, `${name} let a row be moved into another org`).toBe(DENIED)

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
          DENIED
        )
      }
    },
    60_000
  )
})

describe("the gate fails when it should", () => {
  /**
   * A gate nobody has watched fail is not known to work. Each fixture here is a
   * pair: the shape that must be caught, and the neighbouring shape that must
   * not be, built and dropped inside the test.
   */

  it("catches a view that reads around the policies and passes one that does not", async () => {
    const { sql: raw } = connect()
    try {
      // No GRANT written here, deliberately. If the default privileges from
      // migration 0001 reach a new view, the first assertion below sees it.
      await raw.unsafe(
        `create view public.${PROBE_LEAKY} as select id, slug from public.orgs`
      )
      await raw.unsafe(
        `create view public.${PROBE_SCOPED} with (security_invoker = on) ` +
          "as select id, slug from public.orgs"
      )
      const found = await readRelations(raw)
      const leaky = found.find((r) => r.name === PROBE_LEAKY) as Discovered
      const scoped = found.find((r) => r.name === PROBE_SCOPED) as Discovered

      expect(
        leaky.appCanRead,
        "the default privileges no longer reach a new view, so this fixture " +
          "proves nothing and the assertion it guards is untested"
      ).toBe(true)
      expect(runsAsInvoker(leaky), "the negative fixture was not caught").toBe(
        false
      )
      expect(runsAsInvoker(scoped), "the positive fixture was caught").toBe(
        true
      )

      // And the catalog shape is not a proxy for the leak: read both.
      const [wide, narrow] = await withOrg({ orgId: ORG_A }, async (db) => [
        await db.execute<{ slug: string }>(
          sql`select slug from ${sql.identifier(PROBE_LEAKY)}`
        ),
        await db.execute<{ slug: string }>(
          sql`select slug from ${sql.identifier(PROBE_SCOPED)}`
        ),
      ])
      expect(
        wide?.length,
        "an owner-rights view no longer reads past the policies, which is the " +
          "premise this assertion rests on"
      ).toBeGreaterThan(1)
      expect(
        narrow?.length,
        "an invoker-rights view read past the policies"
      ).toBe(1)
    } finally {
      await dropProbes(raw)
      await raw.end()
    }
  }, 60_000)

  it("lets the app role use a sequence on a table added later", async () => {
    // The catalog assertions above only SELECT and UPDATE, and the fixtures
    // INSERT as the migrator, so a missing sequence grant showed up nowhere:
    // migration 0001 granted tables and every table added later, and no
    // sequences at all. The first `serial` column would have failed in
    // production with `42501 permission denied for sequence`. This is that
    // insert, run as the role that will run it.
    const { sql: raw } = connect()
    try {
      await raw.unsafe(
        `create table public.${PROBE_SEQ} (id serial primary key, note text)`
      )
      const inserted = await raw.begin(async (tx) => {
        await tx.unsafe(`set local role ${APP_ROLE}`)
        return tx.unsafe(
          `insert into public.${PROBE_SEQ} (note) values ('probe') returning id`
        )
      })
      expect(
        (inserted as unknown as unknown[]).length,
        `${APP_ROLE} could not use the sequence behind a serial column`
      ).toBe(1)
    } finally {
      await dropProbes(raw)
      await raw.end()
    }
  }, 60_000)
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

describe("a handle does not outlive its transaction", () => {
  /**
   * `withOrg` returns whatever the callback returns, and the callback's
   * parameter is the handle, so returning it is one line with no cast. Once the
   * transaction ends the connection goes back to the pool with no
   * `SET LOCAL ROLE` and no `app.org_id`, which makes the escaped handle the
   * connecting role. On Neon that is `neondb_owner`, which holds BYPASSRLS: the
   * escape is not a degraded handle, it is a promoted one.
   */
  // `async` so the guard's synchronous throw arrives as a rejection: the
  // handle refuses on the property read, before there is a statement to send.
  const use = async (db: OrgScopedDb) =>
    db.execute<{ who: string; org: string }>(sql`
      select current_user as who,
             coalesce(current_setting('${sql.raw(ORG_SETTING)}', true), '')
               as org`)

  it("refuses a handle the callback returned", async () => {
    // Returning the handle bare does not even get as far as a caller holding
    // it: an async function resolves its own promise with the returned value
    // after `finally` has run, and resolving a promise with an object reads
    // `.then` off it, which the revoked handle refuses. So `withOrg` rejects
    // and the transaction rolls back rather than committing and handing back a
    // live connection.
    await expect(
      withOrg({ orgId: ORG_A }, async (db): Promise<OrgScopedDb> => db)
    ).rejects.toThrow(/withOrg/)
  })

  it("refuses a handle returned inside another object", async () => {
    const { db: escaped } = await withOrg({ orgId: ORG_A }, async (db) => ({
      db,
      rows: 0,
    }))
    await expect(use(escaped)).rejects.toThrow(/withOrg/)
  })

  it("refuses a handle captured before the callback threw", async () => {
    let escaped: OrgScopedDb | undefined
    await expect(
      withOrg({ orgId: ORG_A }, async (db) => {
        escaped = db
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    await expect(use(escaped as OrgScopedDb)).rejects.toThrow(/withOrg/)
  })
})
