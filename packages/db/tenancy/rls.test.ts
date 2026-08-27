import { type SQL, sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connect } from "../src/client.ts"
import {
  APP_ROLE,
  ENTER_APP_ROLE,
  ORG_SETTING,
  type OrgScopedDb,
  setContext,
  USER_SETTING,
  withOrg,
} from "../src/tenancy.ts"
import {
  clearTwoOrgs,
  ORG_A,
  ORG_ABSENT,
  ORG_B,
  seedTwoOrgs,
  USER_OF,
  WORKOS_ORG_OF,
  WORKOS_USER_OF,
  WORKOS_USER_PENDING,
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
const PROBE_LOOSE_FN = "tenancy_probe_loose_definer"
const PROBE_TIGHT_FN = "tenancy_probe_tight_definer"

/**
 * Tables that are deliberately not tenant-scoped, each with the read that
 * proves it is still confined. Adding a name here is the decision to put data
 * outside the tenant boundary and needs a reviewer who agrees, not a passing
 * build, so the name cannot be added on its own: the entry is the probe, and
 * the cases below drive it from org A and from org B.
 *
 * Being outside the boundary is not being outside RLS. A platform table still
 * has to have row-level security enabled, still has to carry at least one
 * policy whose USING names `app.org_id`, and still has to deny a neighbour
 * (ADR-028).
 *
 * `users` is the only entry. A person is one row here however many orgs they
 * work in, because that is the grain WorkOS keeps them at, and `memberships`
 * carries the org. What an org may read is the people it holds a membership
 * for.
 */
const PLATFORM_TABLES: Record<string, { rowOf: (org: "a" | "b") => SQL }> = {
  users: {
    rowOf: (org) =>
      sql`select count(*)::int as n from users where id = ${USER_OF[org]}`,
  },
}

/**
 * Functions that run as their owner rather than their caller, each with the
 * refusal that proves the body is doing the work the policies are not.
 *
 * A SECURITY DEFINER function in this database runs as `neondb_owner`, which
 * holds BYPASSRLS, so no policy is evaluated inside one and its body is the
 * entire security boundary. That makes it exactly as capable of leaking a
 * tenant as an owner-rights view, and the catalog cannot tell a safe body from
 * an unsafe one. So the rule is the same one `PLATFORM_TABLES` uses: the name
 * cannot be added on its own, because the entry is the probe, and the probe is
 * driven rather than asserted.
 *
 * `resolve_org` is the only entry (ADR-029). It answers which `org_id` a
 * request runs under, which is the one read that has to happen before an org
 * context exists and therefore the one read RLS cannot scope.
 */
type DefinerProbe = {
  /** What the caller is entitled to, so a refusal below is not a broken call. */
  granted: (string | null)[]
  /** Every way in, that must not be one. */
  refused: (string | null)[]
}

const SECURITY_DEFINER_FUNCTIONS: Record<
  string,
  { probe: (raw: Raw) => Promise<DefinerProbe> }
> = {
  resolve_org: {
    probe: async (raw) => {
      const call = async (user: string, org: string) => {
        const [row] = await raw<{ org_id: string | null }[]>`
          select public.resolve_org(${user}, ${org}) as org_id`
        return row?.org_id ?? null
      }
      return {
        granted: [
          await call(WORKOS_USER_OF.a, WORKOS_ORG_OF.a),
          await call(WORKOS_USER_OF.b, WORKOS_ORG_OF.b),
        ],
        refused: [
          // Each org's person against the other org's organization.
          await call(WORKOS_USER_OF.a, WORKOS_ORG_OF.b),
          await call(WORKOS_USER_OF.b, WORKOS_ORG_OF.a),
          // A membership that exists and is not active.
          await call(WORKOS_USER_PENDING, WORKOS_ORG_OF.a),
          // An organization nothing mirrors.
          await call(WORKOS_USER_OF.a, "org_never_mirrored"),
        ],
      }
    },
  },
}

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
  await raw.unsafe(`drop function if exists public.${PROBE_LOOSE_FN}()`)
  await raw.unsafe(`drop function if exists public.${PROBE_TIGHT_FN}()`)
}

/**
 * The pinning ADR-029 requires, exactly. A `search_path` set to anything but
 * the empty string still leaves a schema for a caller to put a table in.
 */
const PINNED_SEARCH_PATH = 'search_path=""'

type DiscoveredFunction = {
  name: string
  args: string
  securityDefiner: boolean
  /** `proconfig`, joined. `search_path=""` is the one that matters. */
  config: string
  /** Null means the default, and the default for a function is world-executable. */
  acl: string | null
  /** Whether PUBLIC holds EXECUTE, however the ACL happens to spell it. */
  publicCanExecute: boolean
}

async function readFunctions(raw: Raw): Promise<DiscoveredFunction[]> {
  const rows = await raw<
    {
      name: string
      args: string
      security_definer: boolean
      config: string
      acl: string | null
      public_can_execute: boolean
    }[]
  >`
    select p.proname as name,
           pg_get_function_identity_arguments(p.oid) as args,
           p.prosecdef as security_definer,
           coalesce(array_to_string(p.proconfig, ','), '') as config,
           array_to_string(p.proacl, ',') as acl,
           has_function_privilege('public', p.oid, 'execute')
             as public_can_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by p.proname`
  return rows.map((row) => ({
    name: row.name,
    args: row.args,
    securityDefiner: row.security_definer,
    config: row.config,
    acl: row.acl,
    publicCanExecute: row.public_can_execute,
  }))
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
  const functions = await readFunctions(raw)
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
    definers: functions.filter((f) => f.securityDefiner),
    policies,
  }
}

const { tables, tenantTables, derived, definers, policies } = await discover()

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
      .filter((t) => t.orgColumn === null && !(t.name in PLATFORM_TABLES))
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

describe("a platform table is outside the tenant boundary, not outside RLS", () => {
  /**
   * The other half of `PLATFORM_TABLES`. Naming a table there takes it out of
   * every case above, so these are what it is taken into: the same three
   * properties, proven per name, and a denial driven through `withOrg` rather
   * than inferred from the catalog.
   */
  const platformCases = Object.entries(PLATFORM_TABLES)

  it("names only tables that exist", () => {
    const known = new Set(tables.map((t) => t.name))
    const absent = Object.keys(PLATFORM_TABLES).filter((n) => !known.has(n))
    expect(
      absent,
      "PLATFORM_TABLES names a table the database does not have, so its " +
        "cases prove nothing. Drop the entry with the table"
    ).toEqual([])
  })

  it.each(platformCases)(
    "%s carries RLS and a policy that reads the org",
    (name) => {
      const table = tables.find((t) => t.name === name) as Discovered
      expect(table.rlsEnabled, `${name} has no ENABLE ROW LEVEL SECURITY`).toBe(
        true
      )
      const own = policies.filter((p) => p.tablename === name)
      expect(
        own.length,
        `${name} has RLS on and no policy, so it denies all`
      ).toBeGreaterThan(0)
      expect(
        own
          .filter((p) => p.qual?.includes(ORG_SETTING))
          .map((p) => p.policyname),
        `no policy on ${name} reads ${ORG_SETTING}, so nothing about it is ` +
          "scoped to an org at all"
      ).not.toEqual([])
      for (const policy of own) {
        // A write policy with no WITH CHECK writes anything. The tenant tables
        // above want that check to name the org; here it may key on the person
        // instead, which is why this asserts the clause exists rather than what
        // is in it.
        if (["ALL", "INSERT", "UPDATE"].includes(policy.cmd)) {
          expect(
            policy.with_check,
            `${policy.policyname} writes with no WITH CHECK`
          ).not.toBeNull()
        }
      }
    }
  )

  it.each(platformCases)(
    "%s shows an org its own and not a neighbour's",
    async (name, probe) => {
      // No `workosUserId` here, and it has to stay that way: `users_self_read`
      // shows a person their own row whatever org the context names, so a probe
      // given the person whose row the denial asserts would find it and the
      // case would fail for the right reason at the wrong assertion. If this
      // ever needs a person, it must not be that one.
      const seen = async (org: "a" | "b") =>
        withOrg({ orgId: org === "a" ? ORG_A : ORG_B }, async (db) => ({
          mine: (await db.execute<{ n: number }>(probe.rowOf(org)))[0]?.n ?? 0,
          theirs:
            (
              await db.execute<{ n: number }>(
                probe.rowOf(org === "a" ? "b" : "a")
              )
            )[0]?.n ?? 0,
        }))

      for (const org of ["a", "b"] as const) {
        const { mine, theirs } = await seen(org)
        expect(
          mine,
          `${name} has no fixture row for org ${org.toUpperCase()}, so denying ` +
            "the other proves nothing"
        ).toBe(1)
        expect(
          theirs,
          `${name} showed org ${org.toUpperCase()} a row belonging to the other`
        ).toBe(0)
      }
    },
    60_000
  )

  it("users adds the reader's own row and nothing else", async () => {
    /**
     * `users_self_read` (ADR-028, amended). A person may read their own row
     * membership or not, which is what lets the org writer find the id of
     * someone who already signed up before writing their membership.
     *
     * Read twice in org B, once with nobody named and once naming org A's
     * owner, who holds no membership in B. Unfiltered both times, on purpose:
     * `select ... where workos_user_id = $1` reads the same one row whether the
     * policy shows that row or the whole table, so it would prove nothing. The
     * difference between the two reads is this policy's own contribution,
     * separated from what `users_member_read` already shows.
     */
    const visible = (ctx: { orgId: string; workosUserId?: string }) =>
      withOrg(ctx, async (db) => {
        const rows = await db.execute<{ id: string }>(sql`select id from users`)
        return rows.map((row) => row.id)
      })

    const anonymous = await visible({ orgId: ORG_B })
    expect(
      anonymous,
      "org B saw org A's owner with no person named, so the difference below " +
        "measures nothing. Either app.workos_user_id is leaking across " +
        "transactions or users_member_read is wider than it reads"
    ).not.toContain(USER_OF.a)

    const asSelf = await visible({
      orgId: ORG_B,
      workosUserId: WORKOS_USER_OF.a,
    })
    expect(
      asSelf.filter((id) => !anonymous.includes(id)),
      "naming a person should add exactly their own row to what org B can see"
    ).toEqual([USER_OF.a])
  }, 60_000)
})

describe("a function that runs as its owner cannot hide either", () => {
  /**
   * The catalog half. A SECURITY DEFINER function bypasses RLS by construction,
   * so the three things asked of one here are: that somebody declared it, that
   * its search path is pinned, and that it is not executable by everyone.
   */
  const declared = Object.keys(SECURITY_DEFINER_FUNCTIONS)

  it("has no undeclared function running as its owner", () => {
    const stray = definers
      .filter((f) => !(f.name in SECURITY_DEFINER_FUNCTIONS))
      .map((f) => `${f.name}(${f.args})`)
    expect(
      stray,
      "a SECURITY DEFINER function runs as a role that holds BYPASSRLS, so its " +
        "body is the only thing standing between a caller and every tenant. " +
        "SECURITY_DEFINER_FUNCTIONS in this file is where one is declared, and " +
        "the entry has to carry the probe that drives its refusal"
    ).toEqual([])
  })

  it("names only functions the database has", () => {
    const present = new Set(definers.map((f) => f.name))
    const absent = declared.filter((name) => !present.has(name))
    expect(
      absent,
      "SECURITY_DEFINER_FUNCTIONS names a function the database does not " +
        "have, so its probe proves nothing. Drop the entry with the function"
    ).toEqual([])
  })

  it.each(definers.map((f) => [f.name, f] as const))(
    "%s pins its search path to nothing",
    (name, fn) => {
      expect(
        fn.config.split(",").includes(PINNED_SEARCH_PATH),
        `${name} runs as its owner without SET search_path = '', which is the ` +
          "classic privilege escalation: anything the body names can be " +
          "shadowed by an object the caller creates in a schema on the path. " +
          `Its proconfig reads ${fn.config || "(nothing)"}`
      ).toBe(true)
    }
  )

  it.each(definers.map((f) => [f.name, f] as const))(
    "%s is not executable by everyone",
    (name, fn) => {
      expect(
        fn.acl,
        `${name} has a null proacl, which means the default rather than no ` +
          "privileges, and the default for a function is EXECUTE to PUBLIC. " +
          "REVOKE ALL ON FUNCTION ... FROM PUBLIC, then grant it to the one " +
          "role that needs it"
      ).not.toBeNull()
      expect(
        fn.publicCanExecute,
        `${name} is executable by PUBLIC, so a function that bypasses RLS by ` +
          "construction is callable by anything holding a connection"
      ).toBe(false)
    }
  )

  it.each(Object.entries(SECURITY_DEFINER_FUNCTIONS))(
    "%s answers for a membership and refuses every other way in",
    async (name, entry) => {
      const { sql: raw } = connect()
      try {
        const { granted, refused } = await entry.probe(raw)
        expect(
          granted.filter((answer) => answer === null),
          `${name} answered nothing where it should have, so the refusals ` +
            "below prove nothing. Check the fixtures this probe reads"
        ).toEqual([])
        expect(
          refused.filter((answer) => answer !== null),
          `${name} answered for a caller that is not entitled to it`
        ).toEqual([])
      } finally {
        await raw.end()
      }
    },
    60_000
  )
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
    // Both GUCs in one statement, both with the third argument true. The
    // second one is what the `users` write policies key on (ADR-028), and a
    // session-scoped version of it would leak the signed-in person onto a
    // pooled backend exactly as the org context would.
    const context = dialect.sqlToQuery(
      setContext({ orgId: ORG_A, workosUserId: "user_probe" })
    )
    expect(context.sql.replace(/\s+/g, " ")).toBe(
      "select set_config($1, $2, true), set_config($3, $4, true)"
    )
    expect(context.params).toEqual([
      ORG_SETTING,
      ORG_A,
      USER_SETTING,
      "user_probe",
    ])
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

  it("catches a definer function that hides and passes one that does not", async () => {
    const { sql: raw } = connect()
    try {
      // The shape the assertions above exist for: runs as its owner, resolves
      // its names against the caller's search path, and inherits the EXECUTE
      // grant to PUBLIC that every function is born with. No REVOKE and no SET
      // written here, deliberately.
      await raw.unsafe(
        `create function public.${PROBE_LOOSE_FN}() returns bigint ` +
          "language sql security definer as $$ select count(*) from orgs $$"
      )
      await raw.unsafe(
        `create function public.${PROBE_TIGHT_FN}() returns bigint ` +
          "language sql security definer set search_path = '' " +
          "as $$ select count(*) from public.orgs $$"
      )
      await raw.unsafe(
        `revoke all on function public.${PROBE_TIGHT_FN}() from public`
      )

      const found = await readFunctions(raw)
      const loose = found.find(
        (f) => f.name === PROBE_LOOSE_FN
      ) as DiscoveredFunction
      const tight = found.find(
        (f) => f.name === PROBE_TIGHT_FN
      ) as DiscoveredFunction

      expect(loose.securityDefiner, "discovery missed a definer").toBe(true)
      expect(
        loose.config.split(",").includes(PINNED_SEARCH_PATH),
        "the negative fixture was not caught"
      ).toBe(false)
      expect(
        loose.acl,
        "a new function no longer arrives with a null proacl, so the " +
          "assertion this fixture guards is untested"
      ).toBeNull()
      expect(
        loose.publicCanExecute,
        "a new function is no longer executable by PUBLIC, so the assertion " +
          "this fixture guards is untested"
      ).toBe(true)
      expect(
        tight.config.split(",").includes(PINNED_SEARCH_PATH),
        "the positive fixture was caught"
      ).toBe(true)
      expect(tight.publicCanExecute, "the positive fixture was caught").toBe(
        false
      )

      // And the catalog shape is not a proxy for the bypass. The loose one is
      // called through `withOrg`, so the caller is `reme_app` with an org
      // context set, and it still counts both orgs: the function does not
      // evaluate the policies its caller is subject to.
      const seen = await withOrg({ orgId: ORG_A }, async (db) =>
        db.execute<{ n: number }>(
          sql`select ${sql.identifier(PROBE_LOOSE_FN)}()::int as n`
        )
      )
      expect(
        seen[0]?.n,
        "a SECURITY DEFINER function no longer reads past the policies, which " +
          "is the premise every assertion in this block rests on"
      ).toBeGreaterThan(1)
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
