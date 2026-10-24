import { idempotencyKey, SetTimeZoneRequest } from "@workspace/contracts"
import {
  eq,
  lowerNextDue,
  type OrgScopedDb,
  orgs,
  recomputeOrgJobs,
  type Tenancy,
} from "@workspace/db"
import type { Owner } from "./changes.ts"
import { knownZone } from "./cos/agent.ts"
import { invalid, keyMissing, readBody } from "./http.ts"

/**
 * The org's time zone after the browser reported its own (ADR-034's
 * change-if). A new zone is written and the org's recurring jobs move into
 * it in the same transaction; `next` is the earliest of them, for
 * `lowerNextDue` after the commit.
 */
export async function rememberZone(
  db: OrgScopedDb,
  orgId: string,
  browser: string | undefined
): Promise<{ zone: string | null; next: Date | null }> {
  const [org] = await db.select({ zone: orgs.timeZone }).from(orgs)
  const held = org?.zone ?? null
  if (!browser || browser === held) return { zone: held, next: null }
  await db.update(orgs).set({ timeZone: browser }).where(eq(orgs.id, orgId))
  return { zone: browser, next: await recomputeOrgJobs(db, browser) }
}

/**
 * `PUT /time-zone`: the browser's zone as the app loads, so check-ins,
 * quiet hours and reminders run on the owner's clock before the first chat
 * turn, and follow the owner when they move.
 */
export async function setTimeZone(
  request: Request,
  env: Pick<Env, "SCHEDULE" | "JOBS">,
  kit: Tenancy,
  owner: Owner
): Promise<Response> {
  if (!idempotencyKey(request)) return keyMissing()
  const parsed = SetTimeZoneRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const zone = parsed.data.time_zone
  if (!knownZone(zone)) return invalid([{ path: ["time_zone"] }])
  const { next } = await kit.withOrg(
    { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
    (db) => rememberZone(db, owner.orgId, zone)
  )
  if (next) await lowerNextDue(env.SCHEDULE, next, env.JOBS)
  return new Response(null, { status: 204 })
}
