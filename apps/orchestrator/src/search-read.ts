import {
  type GetSearchPerformanceInput,
  GetSearchPerformanceOutput,
  UrlStatus,
} from "@workspace/contracts"
import {
  searchConnections,
  searchProperties,
  type Tenancy,
} from "@workspace/db"
import { type Refusal, refuse } from "./domain-flow.ts"
import {
  type AnalyticsRow,
  accessFor,
  GoogleError,
  inspectUrl,
  NeedsReauth,
  searchAnalytics,
} from "./google.ts"

/**
 * The two live reads the Chief of Staff makes of Google: a 90-day (or 7-day
 * break-down) performance answer, and one page's inspection. A `site_url` here
 * only ever comes from one of the org's own `search_properties` rows, read under
 * its RLS, so a caller cannot name another property; a page address must sit
 * on one of those hosts before Google is asked about it.
 */

const DAY_MS = 86_400_000
/** Search Console's newest final data is about two days old. */
const LAG_DAYS = 2
const TOP = 20

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

type Live = {
  accessToken: string
  properties: { siteUrl: string; host: string; kind: string }[]
}

/** The org's verified properties and a fresh access token, or why there is none. */
async function connection(
  env: Env,
  kit: Tenancy,
  orgId: string
): Promise<Live | { connected: false } | Refusal> {
  const { conn, rows } = await kit.withOrg({ orgId }, async (db) => ({
    conn: (
      await db
        .select({
          state: searchConnections.state,
          token: searchConnections.refreshToken,
        })
        .from(searchConnections)
    )[0],
    rows: await db
      .select({
        siteUrl: searchProperties.siteUrl,
        host: searchProperties.host,
        kind: searchProperties.kind,
        state: searchProperties.state,
      })
      .from(searchProperties),
  }))
  if (!conn?.token || conn.state === "revoked") return { connected: false }
  if (conn.state === "needs_reauth") return needsReauth()
  const properties = rows.filter((p) => p.state === "verified")
  if (properties.length === 0) {
    return refuse(
      404,
      "resource",
      "search.no_property",
      "Google has not confirmed this website yet."
    )
  }
  try {
    const { accessToken, sealed } = await accessFor(env, orgId, conn.token)
    if (sealed) {
      await kit.withOrg({ orgId }, (db) =>
        db
          .update(searchConnections)
          .set({ refreshToken: sealed, lastRefreshAt: new Date() })
      )
    }
    return { accessToken, properties }
  } catch (error) {
    if (error instanceof NeedsReauth) {
      await kit.withOrg({ orgId }, (db) =>
        db.update(searchConnections).set({ state: "needs_reauth" })
      )
      return needsReauth()
    }
    return unavailable(error)
  }
}

const needsReauth = () =>
  refuse(
    409,
    "resource",
    "search.needs_reauth",
    "Google no longer lets us read this website's numbers. The owner needs to connect Google again."
  )

/** Google would not answer now: transient, and no detail of what it said. */
const unavailable = (error: unknown) =>
  refuse(
    503,
    "transient",
    error instanceof GoogleError ? error.name : "search.unavailable",
    "Google did not answer."
  )

const sum = (rows: AnalyticsRow[]) => {
  const clicks = rows.reduce((n, r) => n + r.clicks, 0)
  const impressions = rows.reduce((n, r) => n + r.impressions, 0)
  const position =
    impressions > 0
      ? rows.reduce((n, r) => n + r.position * r.impressions, 0) / impressions
      : 0
  return { clicks, impressions, position }
}
const rate = (t: { clicks: number; impressions: number }) =>
  t.impressions > 0 ? t.clicks / t.impressions : 0

/** `GET /search/performance`: Google's own numbers for the last `days`, through the org's properties. */
export async function livePerformance(
  env: Env,
  kit: Tenancy,
  orgId: string,
  { days, by }: GetSearchPerformanceInput,
  now = Date.now()
) {
  const live = await connection(env, kit, orgId)
  if (!("properties" in live)) return live
  const end = now - LAG_DAYS * DAY_MS
  const now0 = { startDate: day(end - (days - 1) * DAY_MS), endDate: day(end) }
  const before = {
    startDate: day(end - (2 * days - 1) * DAY_MS),
    endDate: day(end - days * DAY_MS),
  }
  try {
    const per = await Promise.all(
      live.properties.map(async ({ siteUrl }) => {
        const [current, previous, rows] = await Promise.all([
          searchAnalytics(live.accessToken, siteUrl, now0),
          searchAnalytics(live.accessToken, siteUrl, before),
          by === "none"
            ? { rows: [] }
            : searchAnalytics(live.accessToken, siteUrl, {
                ...now0,
                dimensions: [by],
                rowLimit: TOP,
              }),
        ])
        return {
          current: current.rows,
          previous: previous.rows,
          rows: rows.rows,
        }
      })
    )
    const current = sum(per.flatMap((p) => p.current))
    const previous = sum(per.flatMap((p) => p.previous))
    return GetSearchPerformanceOutput.parse({
      totals: { ...current, ctr: rate(current) },
      delta:
        previous.impressions > 0 || previous.clicks > 0
          ? {
              clicks: current.clicks - previous.clicks,
              impressions: current.impressions - previous.impressions,
              ctr: rate(current) - rate(previous),
              position: current.position - previous.position,
            }
          : null,
      rows: per
        .flatMap((p) => p.rows)
        .flatMap((r) => (r.keys?.[0] ? [{ ...r, key: r.keys[0] }] : []))
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
        .slice(0, TOP)
        .map((r) => ({
          key: r.key.slice(0, 500),
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
        })),
      as_of: now0.endDate,
      stale: false,
    })
  } catch (error) {
    return unavailable(error)
  }
}

/** Whether a verified property is the one `host` belongs to. */
const covers = (p: { host: string; kind: string }, host: string) =>
  host === p.host || (p.kind === "domain" && host.endsWith(`.${p.host}`))

const VERDICTS = new Set(["PASS", "NEUTRAL", "PARTIAL", "FAIL"])
const cut = (s: string | undefined, n: number) => (s ? s.slice(0, n) : null)

/** `GET /search/inspect?url=`: Google's view of one page of one of the org's websites. */
export async function liveInspect(
  env: Env,
  kit: Tenancy,
  orgId: string,
  address: string
) {
  const foreign = refuse(
    404,
    "resource",
    "search.url_foreign",
    "That address is not on one of this business's websites."
  )
  const url = URL.canParse(address) ? new URL(address) : null
  if (url?.protocol !== "https:" || url.username || url.password) {
    return foreign
  }
  const live = await connection(env, kit, orgId)
  if (!("properties" in live)) return live
  const property = live.properties.find((p) => covers(p, url.host))
  if (!property) return foreign
  try {
    const seen = await inspectUrl(live.accessToken, property.siteUrl, url.href)
    return UrlStatus.parse({
      url: url.href.slice(0, 2048),
      verdict: VERDICTS.has(seen.verdict ?? "") ? seen.verdict : "UNSPECIFIED",
      coverage_state: cut(seen.coverageState, 200),
      indexing_state: cut(seen.indexingState, 100),
      robots_state: cut(seen.robotsTxtState, 100),
      google_canonical: cut(seen.googleCanonical, 2048),
      last_crawl_time: seen.lastCrawlTime
        ? new Date(seen.lastCrawlTime).toISOString()
        : null,
      inspected_at: new Date().toISOString(),
    })
  } catch (error) {
    return unavailable(error)
  }
}
