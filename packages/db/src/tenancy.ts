import { sql } from "drizzle-orm"
import { connect } from "./client.ts"

/**
 * The tenancy kit (§9.2, layer 2). One entry point, `withOrg`, and no other way
 * to reach a database handle: `src/index.ts` exports this and the schema, and
 * `connect` is not on the package surface, so there is no exported value to
 * call `.select()` on outside `withOrg`.
 *
 * That covers reaching a handle. It does not cover keeping one, which is the
 * other half: `withOrg` returns whatever the callback returns, so
 * `withOrg(ctx, async (db) => db)` hands the caller a live handle with no cast
 * and no type error. See `revocable` below for why that used to be worse than
 * useless and what closes it.
 *
 * Two things happen inside the transaction and both have to be transaction-local.
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

declare const orgScoped: unique symbol

type Handle = ReturnType<typeof connect>["db"]
type Transaction = Parameters<Parameters<Handle["transaction"]>[0]>[0]

/**
 * A handle that is inside a transaction with an org context set. The brand is
 * unexported, so this type cannot be produced anywhere but here.
 */
export type OrgScopedDb = Transaction & { readonly [orgScoped]: true }

/** Resolved server-side from identity (§9.2, layer 1). Never client input. */
export type TenantContext = { readonly orgId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The two statements that open a tenant-scoped transaction, built here rather
 * than inline so the suite can assert their shape without a database.
 *
 * Both are `LOCAL`, and on a direct connection that is unobservable: a session
 * setting and a transaction setting read back identically when no proxy is
 * reassigning backends underneath. The difference only appears through a
 * transaction pooler, which is why `tenancy/pooler.test.ts` measures it against
 * Neon and `tenancy/rls.test.ts` asserts the statement text everywhere else.
 */
export const ENTER_APP_ROLE = sql.raw(`set local role ${APP_ROLE}`)

/** `is_local = true` is the third argument, and it is the whole story. */
export const setOrgContext = (orgId: string) =>
  sql`select set_config(${ORG_SETTING}, ${orgId}, true)`

let handle: Handle | undefined

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
export async function withOrg<T>(
  ctx: TenantContext,
  fn: (db: OrgScopedDb) => Promise<T>
): Promise<T> {
  // org_id arrives from a server-side identity lookup, so a malformed one is a
  // bug in the caller rather than hostile input. It still fails here rather
  // than as a cast error three statements later.
  if (!UUID.test(ctx.orgId)) {
    throw new Error(`withOrg needs a uuid org_id, got: ${ctx.orgId}`)
  }
  handle ??= connect({ max: 10 }).db
  return handle.transaction(async (tx) => {
    await tx.execute(ENTER_APP_ROLE)
    await tx.execute(setOrgContext(ctx.orgId))
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
