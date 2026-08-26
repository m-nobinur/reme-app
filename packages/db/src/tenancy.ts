import { sql } from "drizzle-orm"
import { connect } from "./client.ts"

/**
 * The tenancy kit (§9.2, layer 2). One entry point, `withOrg`, and no other way
 * to reach a database handle: `src/index.ts` exports this and the schema, and
 * `connect` is not on the package surface, so a raw query outside `withOrg` has
 * nothing to run on and does not typecheck.
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
    return fn(tx as OrgScopedDb)
  })
}
