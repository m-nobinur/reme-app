import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { type connect, connectionString } from "./client.ts"
import * as schema from "./schema.ts"

/**
 * The tenancy kit (§9.2, layer 2). One entry point, `withOrg`, and no other way
 * to reach a database handle: `src/index.ts` exports this and the schema, and
 * `connect` is not on the package surface, so there is no exported value to
 * call `.select()` on outside `withOrg`.
 *
 * It comes two ways round, and both lead to the same transaction. `tenancy(url)`
 * is the kit over a pool the caller owns and closes, which is what a Worker
 * needs: Hyperdrive hands its connection string to the request rather than to
 * the environment. `withOrg` is the same thing over `DATABASE_URL`, shared and
 * opened on first use, for the suites, which tear their workers down; nothing
 * can shut it, so a Node script uses `tenancy(url)` and closes that.
 *
 * That covers reaching a handle. It does not cover keeping one, which is the
 * other half: `withOrg` returns whatever the callback returns, so
 * `withOrg(ctx, async (db) => db)` hands the caller a live handle with no cast
 * and no type error. See `revocable` below for why that used to be worse than
 * useless and what closes it.
 *
 * Two statements open the transaction, the role and then four settings (the
 * org, the user and two time limits), and every one of them has to be
 * transaction-local.
 */

/**
 * The role every tenant read and write runs as, created by migration 0001.
 *
 * It exists because Neon's `neondb_owner` has `rolbypassrls = true`, measured
 * 2026-08-27 against project `sparkling-wildflower-04343187`. A policy is not a
 * boundary for a role that bypasses it, and `FORCE ROW LEVEL SECURITY` does not
 * rescue it either: FORCE closes the table-owner hole, not the BYPASSRLS one.
 * Connecting as the owner and trusting the policies would have made every test
 * below fail loudly, which is the good case; shipping it would have made the
 * policies decoration.
 *
 * `reme_app` is NOLOGIN. It is reached with `SET LOCAL ROLE`, so it lasts
 * exactly as long as the transaction and cannot leak onto a pooled connection
 * the way a session-level `SET ROLE` would.
 */
export const APP_ROLE = "reme_app"

/** The GUC the policies read. Set with the third argument true, always. */
export const ORG_SETTING = "app.org_id"

/**
 * The second GUC, for the two policies an org cannot answer (ADR-028). `users`
 * is a platform table: a person is one row however many orgs they work in, and
 * at sign-up their row has to exist before any membership can vouch for it, so
 * the write policies key on who is signing in rather than on where they work.
 *
 * Same rules as the org context. Transaction-local, from the sealed session,
 * never from client input, and unset it reads as NULL and matches nothing.
 */
export const USER_SETTING = "app.workos_user_id"

declare const orgScoped: unique symbol

type Handle = ReturnType<typeof connect>["db"]
type Transaction = Parameters<Parameters<Handle["transaction"]>[0]>[0]

/**
 * A handle that is inside a transaction with an org context set. The brand is
 * unexported, so this type cannot be produced anywhere but here.
 */
export type OrgScopedDb = Transaction & { readonly [orgScoped]: true }

/**
 * Resolved server-side from identity (§9.2, layer 1). Never client input.
 *
 * `workosUserId` is optional because most work is org-scoped and needs nobody
 * in particular. Leave it out and `app.workos_user_id` is set to the empty
 * string, which reads as NULL and matches no row, so the two `users` write
 * policies deny. Sign-in is the caller that has it and the caller that needs
 * it.
 */
export type TenantContext = {
  readonly orgId: string
  readonly workosUserId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The two statements that open a tenant-scoped transaction, the role and the
 * four settings, built here rather than inline so the suite can assert their
 * shape without a database.
 *
 * All are `LOCAL`, and on a direct connection that is unobservable: a session
 * setting and a transaction setting read back identically when no proxy is
 * reassigning backends underneath. The difference only appears through a
 * transaction pooler, which is why `tenancy/pooler.test.ts` measures it against
 * Neon and `tenancy/rls.test.ts` asserts the statement text everywhere else.
 */
export const ENTER_APP_ROLE = sql.raw(`set local role ${APP_ROLE}`)

/** The two limits `setContext` sets, each changed here and nowhere else. */
export const LIMITS = { statement: "5s", idle: "15s" } as const

/**
 * The org and user settings in one statement, so the second GUC costs no extra
 * round trip. `is_local = true` is the third argument, and it is the whole
 * story.
 *
 * The same statement sets the two limits every tenant transaction runs under
 * (ADR-034), local for the same reason: Hyperdrive pools per transaction and
 * `RESET`s a connection on its way back, so neither a session setting nor a
 * startup parameter reaches the next transaction on that backend. A statement
 * that runs past `LIMITS.statement` is cancelled with 57014. A transaction
 * left idle past `LIMITS.idle`, which is a call to something other than the
 * database made while it holds a lock, has its session ended: the server's
 * 25P03 arrives while no query is waiting, so the caller sees the driver's
 * `CONNECTION_CLOSED` on its next statement instead.
 * Both are guesses, and ADR-034 names the measurement that replaces each. The
 * three resolvers below do not set them: each runs one statement, and setting
 * a limit first would cost a round trip on every request.
 */
export const setContext = (ctx: TenantContext) =>
  sql`select set_config(${ORG_SETTING}, ${ctx.orgId}, true),
             set_config(${USER_SETTING}, ${ctx.workosUserId ?? ""}, true),
             set_config('statement_timeout', ${LIMITS.statement}, true),
             set_config('idle_in_transaction_session_timeout', ${LIMITS.idle}, true)`

/**
 * Wraps the transaction handle so it stops working the moment `withOrg`
 * returns.
 *
 * Without this, a handle that escapes the callback keeps working and comes back
 * **promoted rather than degraded**. The transaction is over, so the pooled
 * connection carries no `SET LOCAL ROLE` and no `app.org_id`: the next
 * statement runs as the connecting role, which on Neon is `neondb_owner` and
 * holds `rolbypassrls`. Measured 2026-08-27 against the `tenancy-rls` branch,
 * an escaped handle reported `current_user = neondb_owner` with an empty org
 * context and read every row of both probe orgs. No error, nothing in the log.
 *
 * The shapes that produce it are ordinary rather than perverse:
 * `async (db) => ({ db, rows })` to reuse a handle, a helper that returns the
 * transaction for its caller to finish with, a handler that memoises. All of
 * them typecheck and lint clean, because the brand on `OrgScopedDb` constrains
 * the type and not the connection.
 *
 * Revocation is in the callback's `finally`, so it holds whether the callback
 * returned, threw, or returned the handle inside something else.
 *
 * What it does not cover: a savepoint handle taken with `db.transaction(...)`
 * inside the callback is a different object and is not wrapped, and a method
 * read off the handle while it was still live keeps its own reference. Both are
 * closed for good by connecting as a login role that lacks BYPASSRLS, at which
 * point an escaped handle reads nothing rather than everything. That role does
 * not exist yet: `reme_app` is NOLOGIN with no password and no migration grants
 * one. See `README.md`, "Known gaps".
 */
function revocable(tx: Transaction) {
  let live = true
  const db = new Proxy(tx, {
    get(target, prop, receiver) {
      if (!live) {
        throw new Error(
          "this handle belongs to a withOrg transaction that has already " +
            "ended. Do the work inside the callback, or call withOrg again."
        )
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as OrgScopedDb
  return {
    db,
    revoke: () => {
      live = false
    },
  }
}

/**
 * Runs `fn` in one transaction, as `reme_app`, with `app.org_id` set for the
 * length of that transaction and no longer.
 *
 * The third argument to `set_config` is `true`, which means transaction-local,
 * and it is the whole point. Measured 2026-08-27 against the Neon pooler with
 * twelve concurrent clients doing twenty rounds each: this form returned the
 * caller's own row on 240 of 240 reads and left nothing behind, while the
 * session-scoped form (`false`) returned another tenant's row on 220 to 228 of
 * 240 across three runs and left a live org context on every backend it
 * touched. A lone client reads its own value back either way, which is what
 * makes the session-scoped version pass every quiet test and leak under load.
 * `tenancy/pooler.test.ts` re-measures both.
 */
async function run<T>(
  on: Handle,
  ctx: TenantContext,
  fn: (db: OrgScopedDb) => Promise<T>
): Promise<T> {
  // org_id arrives from a server-side identity lookup, so a malformed one is a
  // bug in the caller rather than hostile input. It still fails here rather
  // than as a cast error three statements later.
  if (!UUID.test(ctx.orgId)) {
    throw new Error(`withOrg needs a uuid org_id, got: ${ctx.orgId}`)
  }
  return on.transaction(async (tx) => {
    await tx.execute(ENTER_APP_ROLE)
    await tx.execute(setContext(ctx))
    const { db, revoke } = revocable(tx)
    try {
      // Awaited rather than returned, so `finally` runs after the callback
      // settles rather than before it.
      return await fn(db)
    } finally {
      revoke()
    }
  })
}

/**
 * The code a failed statement carries: Postgres's SQLSTATE (57014 for the
 * statement limit) or the driver's own (`CONNECTION_CLOSED` for the idle
 * limit, measured in `tenancy/rls.test.ts`). drizzle wraps the driver's
 * error, so the code can be on the cause. Null when neither has one.
 */
export function pgCode(error: unknown): string | null {
  const { code, cause } = (error ?? {}) as {
    code?: unknown
    cause?: { code?: unknown }
  }
  for (const found of [code, cause?.code]) {
    if (typeof found === "string") return found
  }
  return null
}

/**
 * What a catch-all logs for an error it answers: the code `pgCode` finds, or
 * else the error's class, so a failure that is not the database's still says
 * what it was. `unknown` only when there is neither.
 */
export function failureCode(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name
  return pgCode(error) ?? (typeof name === "string" ? name : "unknown")
}

/**
 * A catch-all's log line: where it was, and the code and nothing else. A
 * driver message can carry the connection string it failed on, and every
 * Worker logs to an account-wide sink (R9).
 */
export function logFailure(where: Record<string, string>, error: unknown) {
  console.error(JSON.stringify({ ...where, code: failureCode(error) }))
}

/**
 * Who a request is, before it is anything else. Both halves come from the
 * sealed session and neither is ever read off a request body: `org_id` never
 * comes from client input, and neither does the vendor id it is looked up by.
 */
export type Identity = {
  readonly workosUserId: string
  readonly workosOrganizationId: string
}

/**
 * Where the kit keeps its handle. An unexported symbol, the same trick the
 * `orgScoped` brand above uses: `resolveOrg` needs the pool and nothing outside
 * this file can name the key, so the rule that no handle leaves `withOrg`
 * survives having a second entry point.
 */
const pool = Symbol("pool")

/** The kit, bound to one pool. `close` is the caller's to call. */
export type Tenancy = {
  withOrg: <T>(
    ctx: TenantContext,
    fn: (db: OrgScopedDb) => Promise<T>
  ) => Promise<T>
  close: () => Promise<void>
  readonly [pool]: Handle
}

/**
 * The org a slug names, for the orchestrator, which addresses a business by
 * its slug and holds no session. The same definer path as
 * `resolveOrg`: a null for an unknown slug, never an error that says so.
 */
export async function resolveOrgBySlug(
  kit: Tenancy,
  slug: string
): Promise<string | null> {
  return kit[pool].transaction(async (tx) => {
    await tx.execute(ENTER_APP_ROLE)
    const rows = await tx.execute<{ org_id: string | null }>(
      sql`select public.resolve_org_by_slug(${slug}) as org_id`
    )
    return rows[0]?.org_id ?? null
  })
}

/**
 * The site a custom hostname serves, for the router's Postgres fallback when
 * KV holds no pointer for the host. The same definer path as `resolveOrg`
 * (migration 0015): the apex or its `www.`, an active domain only, and null
 * for anything else, so a host cannot be probed for what state it is in.
 */
export async function resolveDomainHost(
  kit: Tenancy,
  host: string
): Promise<{ orgId: string; siteId: string; primaryHost: string } | null> {
  return kit[pool].transaction(async (tx) => {
    await tx.execute(ENTER_APP_ROLE)
    const rows = await tx.execute<{
      org_id: string
      site_id: string
      primary_host: string
    }>(sql`select * from public.resolve_domain_host(${host})`)
    const row = rows[0]
    return row
      ? {
          orgId: row.org_id,
          siteId: row.site_id,
          primaryHost: row.primary_host,
        }
      : null
  })
}

/**
 * Every org id, for a platform job that then opens each org's own `withOrg`:
 * the hourly retention sweep is the caller today, and nothing enforces that
 * it stays the only one. The function is SECURITY DEFINER (migration 0009)
 * and returns opaque ids and nothing else, so no tenant row is read here and
 * no handle leaves; an id buys nothing without a context, which
 * `tenancy/rls.test.ts` drives.
 */
export async function listOrgIds(kit: Tenancy): Promise<string[]> {
  return kit[pool].transaction(async (tx) => {
    await tx.execute(ENTER_APP_ROLE)
    const rows = await tx.execute<{ id: string }>(
      sql`select public.list_org_ids() as id`
    )
    return rows.map((row) => row.id)
  })
}

/** A design another business in the same industry was planned with. */
export type RecentDesign = {
  direction: string | null
  hero: string | null
  services: string | null
}

/**
 * The planner's diversity note (ADR-038): the direction and home hero and
 * services variants of up to 20 other businesses in `industry`, newest first,
 * never `orgId`'s own. SECURITY DEFINER (migration 0014), returning three
 * library ids per row and nothing that names or belongs to a business.
 */
export async function recentDesigns(
  kit: Tenancy,
  orgId: string,
  industry: string
): Promise<RecentDesign[]> {
  return kit[pool].transaction(async (tx) => {
    await tx.execute(ENTER_APP_ROLE)
    const rows = await tx.execute<RecentDesign>(
      sql`select direction, hero, services from public.recent_designs(${orgId}::uuid, ${industry})`
    )
    return rows.map(({ direction, hero, services }) => ({
      direction,
      hero,
      services,
    }))
  })
}

/**
 * The one read that happens outside an org context, because it is the read that
 * produces one (ADR-029).
 *
 * `resolve_org` is SECURITY DEFINER, so it runs as its owner and no policy is
 * evaluated inside it; migration 0005 carries the reasoning and the body that
 * is therefore the whole boundary. What this adds is the role: the call runs as
 * `reme_app` in a transaction of its own, so the connecting role, which on Neon
 * holds BYPASSRLS, executes nothing on this path either, and `reme_app` is the
 * only role granted EXECUTE. No org context is set and no handle is handed out.
 *
 * Returns the org id, or null when the person holds no active membership in
 * that organization. Null is the ordinary answer for a signed-in person whose
 * org we do not mirror yet, not an error.
 */
export async function resolveOrg(
  kit: Tenancy,
  identity: Identity
): Promise<string | null> {
  return kit[pool].transaction(async (tx) => {
    await tx.execute(ENTER_APP_ROLE)
    const rows = await tx.execute<{ org_id: string | null }>(
      sql`select public.resolve_org(${identity.workosUserId},
                                    ${identity.workosOrganizationId}) as org_id`
    )
    return rows[0]?.org_id ?? null
  })
}

/**
 * A tenancy kit over a connection string the caller supplies, and the only
 * shape that works in a Worker: Hyperdrive hands its connection string to the
 * request through a binding, so there is no environment variable for the lazy
 * one below to read, and each isolate wants its own pool.
 *
 * The caller owns it and closes it. That is the other half of the same
 * problem: the shared kit opens a pool nothing can shut, so a Node process that
 * reads through it never exits (measured 2026-08-28, a script whose only
 * statement was `select 1` returned in 34 ms and was killed at 25 s). Both are answered here rather
 * than only one, because a Worker cannot use an exported teardown and a script
 * cannot use a per-isolate handle.
 */
export function tenancy(
  url: string,
  { max = 5 }: { max?: number } = {}
): Tenancy {
  const client = postgres(url, { max })
  const db = drizzle(client, { schema })
  return {
    withOrg: (ctx, fn) => run(db, ctx, fn),
    close: () => client.end(),
    [pool]: db,
  }
}

let shared: Tenancy | undefined

/**
 * The same thing over `DATABASE_URL`, for the suites. Opened on first use and
 * shared, because they all want one pool.
 *
 * Nothing closes it, so a Node entry point that uses this does not exit.
 * Vitest does, because it tears its workers down.
 */
export async function withOrg<T>(
  ctx: TenantContext,
  fn: (db: OrgScopedDb) => Promise<T>
): Promise<T> {
  shared ??= tenancy(connectionString(), { max: 10 })
  return shared.withOrg(ctx, fn)
}
