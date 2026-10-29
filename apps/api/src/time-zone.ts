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
import { knownZone } from "./cos/time.ts"
import { invalid, keyMissing, readBody } from "./http.ts"
import { jevZone } from "./jev.ts"
import { readFacts } from "./workspace.ts"

/** Who sets the org's zone, weakest first: each may replace only the ones before it, and the owner always. */
const SOURCES = ["browser", "area", "owner"] as const
export type ZoneSource = (typeof SOURCES)[number]

/**
 * The org's zone after `source` offered `zone` (ADR-034's amendment of
 * 2026-10-29). The browser sets it only when none is stored, the service
 * area may replace the browser's guess, and the owner's word replaces
 * anything. A new zone is written and the org's recurring jobs move into it
 * in the same transaction; `next` is the earliest of them, for
 * `lowerNextDue` after the commit.
 */
export async function offerZone(
  db: OrgScopedDb,
  orgId: string,
  zone: string,
  source: ZoneSource
): Promise<{ zone: string | null; next: Date | null }> {
  const [org] = await db
    .select({ zone: orgs.timeZone, source: orgs.timeZoneSource })
    .from(orgs)
  const held = org?.zone ?? null
  const by = held ? ((org?.source as ZoneSource | null) ?? "browser") : null
  const stronger =
    by === null ||
    source === "owner" ||
    SOURCES.indexOf(source) > SOURCES.indexOf(by)
  if (!stronger) return { zone: held, next: null }
  await db
    .update(orgs)
    .set({ timeZone: zone, timeZoneSource: source })
    .where(eq(orgs.id, orgId))
  return {
    zone,
    next: zone === held ? null : await recomputeOrgJobs(db, zone),
  }
}

/**
 * The org's zone for a turn, after the browser offered its own, and the
 * service area to read a zone from while only the browser has set one.
 */
export async function rememberZone(
  db: OrgScopedDb,
  orgId: string,
  browser: string | undefined
): Promise<{ zone: string | null; next: Date | null; area: string | null }> {
  const offered = browser
    ? await offerZone(db, orgId, browser, "browser")
    : null
  const [org] = await db
    .select({ zone: orgs.timeZone, source: orgs.timeZoneSource })
    .from(orgs)
  const settled = org?.source === "area" || org?.source === "owner"
  const area = settled
    ? null
    : ((await readFacts(db)).find((f) => f.key === "service_area.text")
        ?.value as { text?: string } | undefined)
  return {
    zone: org?.zone ?? null,
    next: offered?.next ?? null,
    area: area?.text ?? null,
  }
}

/**
 * The zone the service area names, read by Jev once the owner has given an
 * area and nothing stronger than the browser has set the zone. Run after
 * the turn; a zone Jev is unsure of, or `Intl` does not know, changes nothing.
 */
export async function zoneFromArea(
  env: Pick<Env, "SCHEDULE" | "JOBS" | "OPENROUTER_API_KEY">,
  kit: Tenancy,
  orgId: string,
  area: string,
  read: (apiKey: string, area: string) => Promise<string | null> = jevZone
): Promise<void> {
  if (!env.OPENROUTER_API_KEY) return
  const zone = await read(env.OPENROUTER_API_KEY, area)
  if (!zone || !knownZone(zone)) return
  const { next } = await kit.withOrg({ orgId }, (db) =>
    offerZone(db, orgId, zone, "area")
  )
  if (next) await lowerNextDue(env.SCHEDULE, next, env.JOBS)
}

/**
 * `PUT /time-zone`: the browser's zone as the app loads, so check-ins,
 * quiet hours and reminders run on a clock before the first chat turn. It
 * is taken only while the org has no zone: after that the owner changes it
 * through the assistant.
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
    (db) => offerZone(db, owner.orgId, zone, "browser")
  )
  if (next) await lowerNextDue(env.SCHEDULE, next, env.JOBS)
  return new Response(null, { status: 204 })
}
