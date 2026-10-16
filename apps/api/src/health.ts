import { sql, type Tenancy } from "@workspace/db"

/**
 * `/health` reads the tenant path rather than the database.
 *
 * A health check that runs `select 1` proves the socket and nothing else. Every
 * guarantee this API rests on sits between the socket and the first row, and
 * each of them is silent when it breaks: a credential pointed at a role that
 * holds BYPASSRLS reads every tenant and answers 200, a `set_config` that
 * stopped being transaction-local reads back correctly for one caller, and a
 * migration that dropped a policy leaves a table wide open to a passing query.
 * So this asserts the four things `withOrg` promises, on a live connection.
 */

/**
 * The org this probe claims to be. It is not a real org and no environment
 * seeds it, which is the point: every tenant table must read zero rows under
 * it, in an empty database and in a full one alike.
 *
 * It never reaches a request path. `/health` takes no input at all.
 */
export const PROBE_ORG = "00000000-0000-4000-8000-0000000000ff"

type HealthReport = {
  status: "ok" | "degraded"
  /** The role the transaction ran as. `reme_app`, or the policies are moot. */
  role: string
  /** Whether that role can bypass RLS. True means the boundary is not one. */
  bypasses_rls: boolean
  /** `app.org_id` read back inside the transaction that set it. */
  org_context: string
  /** Rows a tenant table shows an org that does not exist. Zero, or a leak. */
  rows_for_absent_org: number
}

type Probe = {
  who: string
  bypass: boolean | null
  org: string
  visible: number
}

/**
 * One transaction, through the same door every endpoint uses. `orgs` is the
 * table read because it is the tenant root: it scopes on its own key, so a
 * count under an org that was never inserted is zero for exactly one reason.
 */
export async function checkTenantPath(kit: Tenancy): Promise<HealthReport> {
  const probe = await kit.withOrg({ orgId: PROBE_ORG }, async (db) => {
    const rows = await db.execute<Probe>(sql`
      select current_user as who,
             (select rolbypassrls from pg_roles where rolname = current_user)
               as bypass,
             coalesce(current_setting('app.org_id', true), '') as org,
             (select count(*)::int from orgs) as visible`)
    return rows[0]
  })

  const report: Omit<HealthReport, "status"> = {
    role: probe?.who ?? "",
    bypasses_rls: probe?.bypass ?? true,
    org_context: probe?.org ?? "",
    rows_for_absent_org: probe?.visible ?? -1,
  }
  const ok =
    report.role === "reme_app" &&
    report.bypasses_rls === false &&
    report.org_context === PROBE_ORG &&
    report.rows_for_absent_org === 0
  return { status: ok ? "ok" : "degraded", ...report }
}
