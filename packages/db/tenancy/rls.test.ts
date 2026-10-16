import { Conversation } from "@workspace/contracts"
import { type SQL, sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Sql, TransactionSql } from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { connect, connectionString } from "../src/client.ts"
import { activeDomainHost, domainHeldElsewhere } from "../src/domains.ts"
import {
  APP_ROLE,
  ENTER_APP_ROLE,
  LIMITS,
  listOrgIds,
  ORG_SETTING,
  type OrgScopedDb,
  pgCode,
  resolveDomainHost,
  resolveOrg,
  resolveOrgBySlug,
  setContext,
  type Tenancy,
  tenancy,
  USER_SETTING,
  withOrg,
} from "../src/tenancy.ts"
import {
  clearTwoOrgs,
  DOMAIN_OF,
  DOMAIN_PENDING,
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
const APPEND_ONLY = new Set(["deployments", "events", "staff_events"])

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
  // The builder console's way in: a slug to an org id, and null for a slug
  // nothing holds, so a caller cannot enumerate what exists by error class.
  resolve_org_by_slug: {
    probe: async (raw) => {
      const call = async (slug: string) => {
        const [row] = await raw<{ org_id: string | null }[]>`
          select public.resolve_org_by_slug(${slug}) as org_id`
        return row?.org_id ?? null
      }
      return {
        granted: [await call("tenancy-probe-a"), await call("tenancy-probe-b")],
        refused: [await call("tenancy-probe-c"), await call("")],
      }
    },
  },
  // The router's way from a custom hostname to a site (migration 0015): an
  // active domain's apex or its `www.`, three columns back, and nothing for a
  // host that is pending, unknown or empty.
  resolve_domain_host: {
    probe: async (raw) => {
      const call = async (host: string) => {
        const [row] = await raw<{ org_id: string | null }[]>`
          select org_id from public.resolve_domain_host(${host})`
        return row?.org_id ?? null
      }
      return {
        granted: [
          await call(DOMAIN_OF.a),
          await call(`www.${DOMAIN_OF.b}`),
          await call(DOMAIN_OF.b.toUpperCase()),
        ],
        refused: [
          await call(DOMAIN_PENDING),
          await call(`www.${DOMAIN_PENDING}`),
          await call("tenancy-probe-c.example.com"),
          await call(`blog.${DOMAIN_OF.a}`),
          await call(""),
        ],
      }
    },
  },
  // The connect path's takeover guard (migration 0016): whether an org other
  // than the context's ever held a name. A yes is the only answer it gives,
  // so a no counts as a refusal: an org's own name, a name nobody holds.
  domain_held_elsewhere: {
    probe: async (raw) => {
      const call = (org: string | null, name: string) =>
        raw.begin(async (tx) => {
          if (org) await tx`select set_config('app.org_id', ${org}, true)`
          const [row] = await tx<{ held: boolean }[]>`
            select public.domain_held_elsewhere(${name}) as held`
          return row?.held ? "held" : null
        })
      return {
        granted: [
          await call(ORG_B, DOMAIN_OF.a),
          await call(ORG_A, DOMAIN_OF.b.toUpperCase()),
          // No context: every holder is another org's.
          await call(null, DOMAIN_OF.a),
        ],
        refused: [
          await call(ORG_A, DOMAIN_OF.a),
          await call(ORG_A, DOMAIN_PENDING),
          await call(ORG_B, "tenancy-probe-c.example.com"),
          await call(ORG_B, ""),
        ],
      }
    },
  },
  // The retention sweep's way in (ADR-032, amended): every org id, and
  // nothing else. It takes no argument, so there is no other way in to
  // refuse here; the refusal that matters, that an id from it reads nothing
  // without a context, is driven as its own case below.
  list_org_ids: {
    probe: async (raw) => {
      const rows = await raw<{ id: string }[]>`
        select public.list_org_ids() as id`
      const ids = new Set(rows.map((row) => row.id))
      return {
        granted: [ids.has(ORG_A) ? ORG_A : null, ids.has(ORG_B) ? ORG_B : null],
        refused: [],
      }
    },
  },
  // The planner's diversity note (ADR-038, migration 0014). What crosses
  // tenants is the row shape, so the shape is the probe: three library ids,
  // no org id, no text. A column added to it fails here. The caller's own org
  // is excluded in the body; the fixtures hold no planned site to drive that.
  recent_designs: {
    probe: async (raw) => {
      const [row] = await raw<{ result: string }[]>`
        select pg_get_function_result(
          'public.recent_designs(uuid, text)'::regprocedure) as result`
      const shape = "TABLE(direction text, hero text, services text)"
      return {
        granted: [row?.result === shape ? shape : null],
        refused: [],
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

async function denied(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    return pgCode(error) ?? undefined
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

describe("an org id from the platform list buys nothing without a context", () => {
  it("lists both probe orgs, and inside one org's context the other's row is unreadable", async () => {
    const kit = tenancy(process.env.DATABASE_URL ?? "")
    try {
      const ids = await listOrgIds(kit)
      expect(ids).toContain(ORG_A)
      expect(ids).toContain(ORG_B)
      const seen = await kit.withOrg({ orgId: ORG_A }, async (db) => {
        const rows = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from orgs where id = ${ORG_B}`
        )
        return rows[0]?.n
      })
      expect(
        seen,
        "the listed id opened nothing: org B's row stays hidden"
      ).toBe(0)
    } finally {
      await kit.close()
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
    // Both GUCs in one statement, both with the third argument true. The
    // second one is what the `users` write policies key on (ADR-028), and a
    // session-scoped version of it would leak the signed-in person onto a
    // pooled backend exactly as the org context would.
    const context = dialect.sqlToQuery(
      setContext({ orgId: ORG_A, workosUserId: "user_probe" })
    )
    // The two limits ride in the same statement, local like the rest.
    expect(context.sql.replace(/\s+/g, " ")).toBe(
      "select set_config($1, $2, true), set_config($3, $4, true), set_config('statement_timeout', $5, true), set_config('idle_in_transaction_session_timeout', $6, true)"
    )
    expect(context.params).toEqual([
      ORG_SETTING,
      ORG_A,
      USER_SETTING,
      "user_probe",
      LIMITS.statement,
      LIMITS.idle,
    ])
  })
})

describe("a tenant transaction runs under the statement and idle limits", () => {
  // One connection, so the second transaction is on the backend the first
  // one used, and every statement the kit sends is seen on the wire.
  let kit: Tenancy
  let client: Sql
  let sent: string[] = []
  const LIMIT =
    "select current_setting('statement_timeout') as statement, current_setting('idle_in_transaction_session_timeout') as idle, pg_backend_pid() as pid"

  beforeAll(() => {
    kit = tenancy(connectionString(), { max: 1 })
    // The kit's own client, reached the way nothing outside a test would:
    // the symbol the kit keeps its pool under, found by its name.
    const key = Object.getOwnPropertySymbols(kit).find(
      (k) => k.description === "pool"
    )
    if (!key) throw new Error("the tenancy kit keeps no pool symbol")
    client = (kit as unknown as Record<symbol, { $client: Sql }>)[key]
      ?.$client as Sql
    // postgres.js reads `debug` per query.
    // The type lookup postgres.js runs once per new connection is not the
    // kit's, so it is left out of the count.
    client.options.debug = (_id, query) => {
      if (!query.includes("pg_catalog.pg_type")) {
        sent.push(query.replace(/\s+/g, " ").trim())
      }
    }
  })

  afterAll(async () => {
    await kit.close()
  })

  const read = (rows: Record<string, unknown>[]) =>
    rows[0] as { statement: string; idle: string; pid: number }

  it("reads its limits inside withOrg, and the defaults in the next transaction", async () => {
    const plain = async () => read(await client.begin((tx) => tx.unsafe(LIMIT)))
    const before = await plain()
    // Defaults that happen to equal the limits would prove nothing.
    expect(before.statement).not.toBe("5s")
    expect(before.idle).not.toBe("15s")
    const inside = await kit.withOrg({ orgId: ORG_A }, async (db) =>
      read(await db.execute(sql.raw(LIMIT)))
    )
    expect(inside).toMatchObject({ statement: "5s", idle: "15s" })
    const after = await plain()
    expect([after.pid, inside.pid], "the same backend").toEqual([
      before.pid,
      before.pid,
    ])
    expect(after).toEqual(before)
  })

  it("sends as many statements as it did before the limits", async () => {
    sent = []
    await kit.withOrg({ orgId: ORG_A }, (db) => db.execute(sql`select 1`))
    // The context carries both limits, so no round trip was added for them.
    expect(sent).toEqual([
      "begin",
      `set local role ${APP_ROLE}`,
      expect.stringMatching(/statement_timeout.*idle_in_transaction/),
      "select 1",
      "commit",
    ])
  })

  // The server ends the session with 25P03 while no query is waiting, so
  // what reaches the caller is the driver's own code, on its next statement.
  // This is the code the idle limit shows in a log.
  it("surfaces an idle-limit kill as CONNECTION_CLOSED", async () => {
    const error = await kit
      .withOrg({ orgId: ORG_A }, async (db) => {
        await db.execute(
          sql`select set_config('idle_in_transaction_session_timeout', '300ms', true)`
        )
        await new Promise((resolve) => setTimeout(resolve, 800))
        await db.execute(sql`select 1`)
      })
      .then(
        () => null,
        (thrown: unknown) => thrown
      )
    expect(pgCode(error)).toBe("CONNECTION_CLOSED")
  })

  it("leaves the limits out of the single-statement resolvers", async () => {
    for (const resolve of [
      () =>
        resolveOrg(kit, {
          workosUserId: WORKOS_USER_OF.a,
          workosOrganizationId: WORKOS_ORG_OF.a,
        }),
      () => resolveOrgBySlug(kit, "tenancy-probe-a"),
      () => listOrgIds(kit),
    ]) {
      sent = []
      expect(await resolve()).toBeTruthy()
      expect(sent).toEqual([
        "begin",
        `set local role ${APP_ROLE}`,
        expect.stringMatching(/^select public\./),
        "commit",
      ])
    }
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

const CHECK = "23514"
const UNIQUE = "23505"
const FOREIGN_KEY = "23503"
const ROLLED_BACK = "rolled back"

/**
 * Runs as the migrator in a transaction that never commits, so the constraint,
 * not the role, is what refuses, and nothing outlives the case. The error
 * code, or undefined when every statement was taken.
 */
async function inTransaction(run: (tx: TransactionSql) => Promise<unknown>) {
  const { sql: raw } = connect()
  try {
    await raw.begin(async (tx) => {
      await run(tx)
      throw new Error(ROLLED_BACK)
    })
  } catch (error) {
    return error instanceof Error && error.message === ROLLED_BACK
      ? undefined
      : (pgCode(error) ?? undefined)
  } finally {
    await raw.end()
  }
  return undefined
}

describe("deployments and approvals hold their shape", () => {
  /** ADR-032's rules for the two publish tables. */

  async function ids() {
    const { sql: raw } = connect()
    try {
      const [row] =
        await raw`select id, assignment_id from site_revisions where org_id = ${ORG_A} limit 1`
      return {
        revision: String(row?.id),
        assignment: String(row?.assignment_id),
      }
    } finally {
      await raw.end()
    }
  }

  /** An open request for a revision, or a decided one when `decision` is given. */
  function request(
    tx: TransactionSql,
    revision: string,
    assignment: string,
    options: { decision?: "approved" | "rejected"; column?: string } = {}
  ) {
    const target = JSON.stringify({ kind: "revision", revision_id: revision })
    const decided = options.decision !== undefined
    return tx`
      insert into approvals (org_id, assignment_id, requested_by_staff_id,
        approver_staff_id, action_kind, target, revision_id, rationale,
        expires_at, decision, decided_by, decided_at)
      values (${ORG_A}, ${assignment}, ${assignment}, ${assignment},
        'site.publish', ${target}::jsonb, ${options.column ?? revision}, 'probe',
        now() + interval '1 hour', ${options.decision ?? null},
        ${decided ? '{"kind":"console"}' : null}::jsonb,
        ${decided ? new Date().toISOString() : null}::timestamptz)
      returning id`
  }

  const decide = (tx: TransactionSql, id: unknown) =>
    tx`update approvals set decision = 'rejected',
      decided_by = '{"kind":"console"}'::jsonb, decided_at = now()
      where id = ${String(id)}`

  it("refuses a publish without its approval and a rollback with one", async () => {
    const { revision, assignment } = await ids()
    expect(
      await inTransaction(
        (tx) => tx`insert into deployments (org_id, site_id, revision_id,
          config_version, kind) values (${ORG_A}, ${ORG_A}, ${revision}, 99,
          'publish')`
      )
    ).toBe(CHECK)
    expect(
      await inTransaction(async (tx) => {
        const [approval] = await request(tx, revision, assignment, {
          decision: "approved",
        })
        await tx`insert into deployments (org_id, site_id, revision_id,
          config_version, kind, approval_id) values (${ORG_A}, ${ORG_A},
          ${revision}, 99, 'rollback', ${String(approval?.id)})`
      })
    ).toBe(CHECK)
  })

  it("refuses a second deployment at the same config version of a site", async () => {
    const { revision } = await ids()
    expect(
      await inTransaction(
        (tx) => tx`insert into deployments (org_id, site_id, revision_id,
          config_version, kind) values (${ORG_A}, ${ORG_A}, ${revision}, 1,
          'rollback')`
      )
    ).toBe(UNIQUE)
  })

  it("keeps a revision target and its column equal, and a decision whole", async () => {
    const { revision, assignment } = await ids()
    // The column names another revision than the target does.
    expect(
      await inTransaction((tx) =>
        request(tx, revision, assignment, { column: assignment })
      )
    ).toBe(CHECK)
    // A decision with no one who decided it.
    expect(
      await inTransaction(
        (tx) => tx`insert into approvals (org_id, assignment_id,
          requested_by_staff_id, approver_staff_id, action_kind, target,
          revision_id, rationale, expires_at, decision)
          values (${ORG_A}, ${assignment}, ${assignment}, ${assignment},
          'site.publish', ${JSON.stringify({ kind: "revision", revision_id: revision })}::jsonb,
          ${revision}, 'probe', now() + interval '1 hour', 'approved')`
      )
    ).toBe(CHECK)
  })

  it("lets an open request be decided once and never changed after", async () => {
    const { revision, assignment } = await ids()
    expect(
      await inTransaction(async (tx) => {
        const [open] = await request(tx, revision, assignment)
        await decide(tx, open?.id)
      })
    ).toBeUndefined()
    expect(
      await inTransaction(async (tx) => {
        const [open] = await request(tx, revision, assignment)
        await tx`update approvals set rationale = 'changed' where id = ${String(open?.id)}`
      })
    ).toBe(CHECK)
    expect(
      await inTransaction(async (tx) => {
        const [open] = await request(tx, revision, assignment)
        await decide(tx, open?.id)
        await tx`update approvals set decision = 'approved' where id = ${String(open?.id)}`
      })
    ).toBe(CHECK)
  })

  it("holds one open request per revision until it is decided", async () => {
    const { revision, assignment } = await ids()
    expect(
      await inTransaction(async (tx) => {
        await request(tx, revision, assignment)
        await request(tx, revision, assignment)
      })
    ).toBe(UNIQUE)
    expect(
      await inTransaction(async (tx) => {
        const [first] = await request(tx, revision, assignment)
        await decide(tx, first?.id)
        await request(tx, revision, assignment)
      })
    ).toBeUndefined()
  })
})

describe("conversations hold their shape", () => {
  /** Org A's owner, conversation and first message, from `fixtures.ts`. */
  const OWNER_A = "00000000-0000-4000-a000-000000000004"
  const OWNER_B = "00000000-0000-4000-b000-000000000004"
  const CONVERSATION_A = "00000000-0000-4000-a000-000000000015"
  const KEY_A = "__LOCALID_tenancy_a"

  const conversation = (
    tx: TransactionSql,
    org: string,
    options: { kind?: string; key?: string | null; title?: string; by?: string }
  ) => tx`
    insert into conversations (org_id, kind, title, created_by_staff_id,
      idempotency_key)
    values (${org}, ${options.kind ?? "assistant"}, ${options.title ?? null},
      ${options.by ?? (org === ORG_A ? OWNER_A : OWNER_B)},
      ${options.key ?? null})`

  const message = (
    tx: TransactionSql,
    org: string,
    id: string,
    parent: string | null = null,
    into = CONVERSATION_A
  ) => tx`
    insert into conversation_messages (conversation_id, id, org_id, parent_id,
      format, content)
    values (${into}, ${id}, ${org}, ${parent}, 'ai-sdk/v6',
      '{"role":"user","parts":[{"type":"text","text":"x"}]}'::jsonb)`

  it("holds one onboarding conversation per org", async () => {
    expect(
      await inTransaction(async (tx) => {
        await conversation(tx, ORG_A, { kind: "onboarding" })
        await conversation(tx, ORG_B, { kind: "onboarding" })
      })
    ).toBeUndefined()
    expect(
      await inTransaction(async (tx) => {
        await conversation(tx, ORG_A, { kind: "onboarding" })
        await conversation(tx, ORG_A, { kind: "onboarding" })
      })
    ).toBe(UNIQUE)
  })

  it("takes an idempotency key of 1 to 255 characters", async () => {
    expect(
      await inTransaction((tx) =>
        conversation(tx, ORG_A, { key: "k".repeat(255) })
      )
    ).toBeUndefined()
    for (const key of ["", "k".repeat(256)]) {
      expect(
        await inTransaction((tx) => conversation(tx, ORG_A, { key })),
        `${key.length} characters`
      ).toBe(CHECK)
    }
  })

  it("makes one conversation per idempotency key in an org", async () => {
    expect(
      await inTransaction((tx) => conversation(tx, ORG_A, { key: KEY_A }))
    ).toBe(UNIQUE)
    expect(
      await inTransaction((tx) => conversation(tx, ORG_B, { key: KEY_A }))
    ).toBeUndefined()
  })

  it("takes a title of 1 to 120 characters with something in them", async () => {
    // Never stricter than the contract: U+0085 is not whitespace to it.
    for (const title of ["a".repeat(120), "\u0085"]) {
      expect(Conversation.shape.title.safeParse(title).success).toBe(true)
      expect(
        await inTransaction((tx) => conversation(tx, ORG_A, { title })),
        JSON.stringify(title)
      ).toBeUndefined()
    }
    for (const title of ["", "   ", " \t\n\v\f\r", "a".repeat(121)]) {
      expect(
        await inTransaction((tx) => conversation(tx, ORG_A, { title })),
        JSON.stringify(title)
      ).toBe(CHECK)
    }
  })

  it("refuses a creator from another org", async () => {
    expect(
      await inTransaction((tx) => conversation(tx, ORG_A, { by: OWNER_B }))
    ).toBe(FOREIGN_KEY)
  })

  it("keeps a message in its conversation's org", async () => {
    expect(
      await inTransaction((tx) => message(tx, ORG_B, "probe_user_2"))
    ).toBe(FOREIGN_KEY)
  })

  it("stores a message id once per conversation", async () => {
    expect(
      await inTransaction((tx) => message(tx, ORG_A, "probe_user_1"))
    ).toBe(UNIQUE)
  })

  it("takes a parent only from the same conversation", async () => {
    expect(
      await inTransaction((tx) =>
        message(tx, ORG_A, "probe_user_2", "probe_assistant_1")
      )
    ).toBeUndefined()
    expect(
      await inTransaction((tx) =>
        message(tx, ORG_A, "probe_user_2", "not_stored")
      )
    ).toBe(FOREIGN_KEY)
  })

  it("takes no parent from another conversation of the same org, nor itself", async () => {
    expect(
      await inTransaction(async (tx) => {
        const [other] = await tx`
          insert into conversations (org_id, kind, created_by_staff_id)
          values (${ORG_A}, 'assistant', ${OWNER_A}) returning id`
        // `probe_user_1` exists, in CONVERSATION_A.
        await message(tx, ORG_A, "probe_user_2", "probe_user_1", other?.id)
      })
    ).toBe(FOREIGN_KEY)
    expect(
      await inTransaction((tx) => message(tx, ORG_A, "self_1", "self_1"))
    ).toBe(CHECK)
  })

  it("reads a turn written in one transaction back in the order it was written", async () => {
    const read: { id: string; created_at: Date }[] = []
    await inTransaction(async (tx) => {
      // now() is the transaction's start, so both rows carry one created_at.
      await message(tx, ORG_A, "turn_user", "probe_assistant_1")
      await message(tx, ORG_A, "turn_reply", "turn_user")
      read.push(
        ...(await tx<{ id: string; created_at: Date }[]>`
          select id, created_at from conversation_messages
          where conversation_id = ${CONVERSATION_A} order by seq`)
      )
    })
    expect(read.map((r) => r.id)).toEqual([
      "probe_user_1",
      "probe_assistant_1",
      "turn_user",
      "turn_reply",
    ])
    expect(read[2]?.created_at).toEqual(read[3]?.created_at)
  })

  it("refuses a message id that is not a text id", async () => {
    for (const id of ["has space", "a".repeat(65)]) {
      expect(await inTransaction((tx) => message(tx, ORG_A, id)), id).toBe(
        CHECK
      )
    }
  })
})

describe("reminders hold their shape", () => {
  /** Org A's owner and conversation, and org B's, from `fixtures.ts`. */
  const OWNER_A = "00000000-0000-4000-a000-000000000004"
  const OWNER_B = "00000000-0000-4000-b000-000000000004"
  const CONVERSATION_A = "00000000-0000-4000-a000-000000000015"
  const CONVERSATION_B = "00000000-0000-4000-b000-000000000015"
  const KEY_A = "tenancy_reminder_a"

  const reminder = (
    tx: TransactionSql,
    options: {
      org?: string
      title?: string
      by?: string
      conversation?: string | null
      key?: string | null
    }
  ) => tx`
    insert into reminders (org_id, title, source, conversation_id,
      created_by_staff_id, idempotency_key)
    values (${options.org ?? ORG_A}, ${options.title ?? "Call the supplier"},
      'owner', ${options.conversation ?? null},
      ${options.by ?? (options.org === ORG_B ? OWNER_B : OWNER_A)},
      ${options.key ?? null})`

  it("takes a title of 1 to 200 characters with something in them", async () => {
    for (const title of ["a".repeat(200), "\u0085"]) {
      expect(
        await inTransaction((tx) => reminder(tx, { title })),
        JSON.stringify(title)
      ).toBeUndefined()
    }
    for (const title of ["", "   ", " \t\n\v\f\r", "a".repeat(201)]) {
      expect(
        await inTransaction((tx) => reminder(tx, { title })),
        JSON.stringify(title)
      ).toBe(CHECK)
    }
  })

  it("refuses a creator from another org", async () => {
    expect(await inTransaction((tx) => reminder(tx, { by: OWNER_B }))).toBe(
      FOREIGN_KEY
    )
  })

  it("takes an idempotency key of 1 to 255 characters", async () => {
    expect(
      await inTransaction((tx) => reminder(tx, { key: "k".repeat(255) }))
    ).toBeUndefined()
    for (const key of ["", "k".repeat(256)]) {
      expect(
        await inTransaction((tx) => reminder(tx, { key })),
        `${key.length} characters`
      ).toBe(CHECK)
    }
  })

  it("makes one reminder per idempotency key in an org", async () => {
    expect(await inTransaction((tx) => reminder(tx, { key: KEY_A }))).toBe(
      UNIQUE
    )
    expect(
      await inTransaction((tx) => reminder(tx, { org: ORG_B, key: KEY_A }))
    ).toBeUndefined()
  })

  it("takes no conversation, or one from its own org only", async () => {
    for (const conversation of [null, CONVERSATION_A]) {
      expect(
        await inTransaction((tx) => reminder(tx, { conversation })),
        String(conversation)
      ).toBeUndefined()
    }
    expect(
      await inTransaction((tx) =>
        reminder(tx, { conversation: CONVERSATION_B })
      )
    ).toBe(FOREIGN_KEY)
  })
})

describe("domains hold their shape", () => {
  /** Org A's pending fixture, and each org's approval from `fixtures.ts`. */
  const PENDING_A = "00000000-0000-4000-a000-000000000018"
  const APPROVAL_A = "00000000-0000-4000-a000-000000000013"
  const APPROVAL_B = "00000000-0000-4000-b000-000000000013"

  const domain = (
    tx: TransactionSql,
    options: { org?: string; name?: string; host?: string; state?: string }
  ) => tx`
    insert into domains (org_id, site_id, name, primary_host, origin, method, state)
    values (${options.org ?? ORG_A}, ${options.org ?? ORG_A},
      ${options.name ?? "newco.example.com"},
      ${options.host ?? options.name ?? "newco.example.com"},
      'connected', 'records', ${options.state ?? "awaiting_dns"})`

  it("refuses a second live claim on a name, in any org", async () => {
    for (const state of ["awaiting_dns", "verifying", "active"]) {
      expect(
        await inTransaction((tx) =>
          domain(tx, { org: ORG_B, name: DOMAIN_OF.a, state })
        ),
        state
      ).toBe(UNIQUE)
    }
  })

  it("lets a name be claimed again once the claim ended", async () => {
    for (const state of ["removed", "failed"]) {
      expect(
        await inTransaction(async (tx) => {
          await tx`update domains set state = ${state} where name = ${DOMAIN_OF.a}`
          await domain(tx, { org: ORG_B, name: DOMAIN_OF.a })
        }),
        state
      ).toBeUndefined()
    }
  })

  it("takes a lowercase apex name and a primary host of its own", async () => {
    for (const name of [
      "Newco.example.com",
      "newco",
      "-a.example.com",
      "a b.example.com",
      "new_co.example.com",
      // The definer strips a `www.`, so a name carrying one would share a host.
      "www.newco.example.com",
    ]) {
      expect(await inTransaction((tx) => domain(tx, { name })), name).toBe(
        CHECK
      )
    }
    expect(
      await inTransaction((tx) =>
        domain(tx, { name: "newco.example.com", host: "other.example.com" })
      )
    ).toBe(CHECK)
    expect(
      await inTransaction((tx) =>
        domain(tx, {
          name: "xn--bcher-kva.example",
          host: "www.xn--bcher-kva.example",
        })
      )
    ).toBeUndefined()
  })

  it("takes an approval from its own org only, and once", async () => {
    // Org B's own domain lets go of its approval first, so the foreign key
    // is what refuses, not the unique constraint.
    expect(
      await inTransaction(async (tx) => {
        await tx`update domains set approval_id = null where org_id = ${ORG_B}`
        await tx`update domains set approval_id = ${APPROVAL_B} where id = ${PENDING_A}`
      })
    ).toBe(FOREIGN_KEY)
    // Org A's live fixture already holds org A's approval.
    expect(
      await inTransaction(
        (tx) =>
          tx`update domains set approval_id = ${APPROVAL_A} where id = ${PENDING_A}`
      )
    ).toBe(UNIQUE)
  })

  it("lets an org read and change only its own domains", async () => {
    const seen = await withOrg({ orgId: ORG_B }, (db) =>
      db.execute<{ name: string }>(sql`select name from domains`)
    )
    expect(seen.map((row) => row.name)).toEqual([DOMAIN_OF.b])
    const touched = await withOrg({ orgId: ORG_B }, (db) =>
      db.execute(
        sql`update domains set state = 'removed' where name = ${DOMAIN_OF.a}`
      )
    )
    expect(touched.count).toBe(0)
  })

  it("tells a new claim that another org held the name, removed or failed, which its own rows hide", async () => {
    for (const state of ["removed", "failed"]) {
      const seen: unknown[] = []
      const code = await inTransaction(async (tx) => {
        await tx`update domains set state = ${state} where name = ${DOMAIN_OF.a}`
        await tx.unsafe(`set local role ${APP_ROLE}`)
        await tx`select set_config('app.org_id', ${ORG_B}, true)`
        const [visible] = await tx<{ n: number }[]>`
          select count(*)::int as n from domains where name = ${DOMAIN_OF.a}`
        const [held] = await tx<{ held: boolean }[]>`
          select public.domain_held_elsewhere(${DOMAIN_OF.a}) as held`
        await tx`select set_config('app.org_id', ${ORG_A}, true)`
        const [own] = await tx<{ held: boolean }[]>`
          select public.domain_held_elsewhere(${DOMAIN_OF.a}) as held`
        seen.push(visible?.n, held?.held, own?.held)
      })
      expect(code, state).toBeUndefined()
      // Org B sees no row, yet learns the name was held; org A's own row is not another's.
      expect(seen, state).toEqual([0, true, false])
    }
    expect(
      await withOrg({ orgId: ORG_B }, (db) =>
        domainHeldElsewhere(db, DOMAIN_OF.a)
      )
    ).toBe(true)
    expect(
      await withOrg({ orgId: ORG_A }, (db) =>
        domainHeldElsewhere(db, DOMAIN_OF.a)
      )
    ).toBe(false)
  })

  it("answers the router for an active host and no other, and the org for its redirect", async () => {
    const kit = tenancy(connectionString())
    try {
      expect(await resolveDomainHost(kit, `www.${DOMAIN_OF.a}`)).toEqual({
        orgId: ORG_A,
        siteId: ORG_A,
        primaryHost: `www.${DOMAIN_OF.a}`,
      })
      expect(await resolveDomainHost(kit, DOMAIN_PENDING)).toBeNull()
      expect(
        await withOrg({ orgId: ORG_A }, (db) => activeDomainHost(db))
      ).toBe(`www.${DOMAIN_OF.a}`)
      expect(
        await withOrg({ orgId: ORG_B }, (db) => activeDomainHost(db))
      ).toBe(DOMAIN_OF.b)
    } finally {
      await kit.close()
    }
  })
})
