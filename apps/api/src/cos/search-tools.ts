import {
  type GetIndexingInput,
  GetIndexingOutput,
  type GetSearchPerformanceInput,
  GetSearchPerformanceOutput,
  SearchSitemap,
  UrlStatus,
} from "@workspace/contracts"
import {
  eq,
  searchConnections,
  searchDaily,
  searchProperties,
  searchSnapshot,
  searchUrlStatus,
  sql,
} from "@workspace/db"
import { bridge } from "../changes.ts"
import { failure } from "../http.ts"
import { domainAnswer, refused, type ToolContext } from "./tools.ts"

/**
 * What the Chief of Staff reads of the owner's Google Search Console: the
 * numbers the daily pull stored, under the org's RLS, or a live call through
 * the orchestrator, which holds the token and refuses any property the org
 * does not hold. Nothing here sees a token or a Google id.
 */

const DAY_MS = 86_400_000
/** A property not synced for this long reads as stale. */
const STALE_MS = 48 * 3_600_000
const TOP = 20

/** `date` moved by `days`, as `YYYY-MM-DD`. */
const shift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10)

const noData = () =>
  failure(404, {
    class: "resource",
    code: "search.no_data_yet",
    message:
      "Google has sent no numbers for this website yet. A new site takes days to a few weeks to show up.",
    detail: {},
  })

const foreign = () =>
  failure(404, {
    class: "resource",
    code: "search.url_foreign",
    message: "That address is not on one of this business's websites.",
    detail: {},
  })

type Property = {
  id: string
  host: string
  kind: "subdomain" | "domain" | "url_prefix"
  state: "pending" | "verified" | "failed" | "stale"
  sitemap: unknown
  lastSyncedAt: Date | null
}

/** The org's connection state and its properties, newest first. */
async function held({ kit, owner }: ToolContext) {
  return kit.withOrg({ orgId: owner.orgId }, async (db) => {
    const [connection] = await db
      .select({ state: searchConnections.state })
      .from(searchConnections)
    const properties: Property[] = await db
      .select({
        id: searchProperties.id,
        host: searchProperties.host,
        kind: searchProperties.kind,
        state: searchProperties.state,
        sitemap: searchProperties.sitemap,
        lastSyncedAt: searchProperties.lastSyncedAt,
      })
      .from(searchProperties)
      .orderBy(sql`${searchProperties.createdAt} desc`)
    return { state: connection?.state, properties }
  })
}

type Sums = { clicks: number; impressions: number; position: number }
type Window = Sums & { days: number }

/** One window of `search_daily`, position weighted by impressions. */
const windowSql = (from: string, to: string) =>
  sql`select coalesce(sum(clicks), 0)::int as clicks,
        coalesce(sum(impressions), 0)::int as impressions,
        coalesce(sum(position * impressions) / nullif(sum(impressions), 0), 0)::float8 as position,
        count(*)::int as days
      from ${searchDaily} where date between ${from} and ${to}`

const totals = ({ clicks, impressions, position }: Sums) => ({
  clicks,
  impressions,
  ctr: impressions > 0 ? clicks / impressions : 0,
  position,
})

export async function getSearchPerformance(
  context: ToolContext,
  { days, by }: GetSearchPerformanceInput
): Promise<GetSearchPerformanceOutput> {
  const { state, properties } = await held(context)
  // A revoked or never-made grant has nothing to read.
  if (!state || state === "revoked") return { connected: false }
  // The stored break-down is the last 28 days, so a 7-day one and anything
  // longer than 28 days are asked of Google.
  if (days === 90 || (days === 7 && by !== "none")) {
    return domainAnswer(
      await bridge(
        context.env,
        context.owner,
        `/search/performance?days=${days}&by=${by}`,
        { method: "GET" }
      ),
      GetSearchPerformanceOutput.parse
    )
  }
  const read = await context.kit.withOrg(
    { orgId: context.owner.orgId },
    async (db) => {
      const [latest] = await db.execute(
        sql`select max(date)::text as as_of from ${searchDaily}`
      )
      const asOf = latest?.as_of as string | null | undefined
      if (!asOf) return null
      const [now] = (await db.execute(
        windowSql(shift(asOf, 1 - days), asOf)
      )) as unknown as Window[]
      const [before] = (await db.execute(
        windowSql(shift(asOf, 1 - 2 * days), shift(asOf, -days))
      )) as unknown as Window[]
      const rows =
        by === "none"
          ? []
          : ((await db.execute(
              sql`select ${sql.raw(by === "query" ? "query" : "page")} as key,
                    sum(clicks)::int as clicks, sum(impressions)::int as impressions,
                    coalesce(sum(position * impressions) / nullif(sum(impressions), 0), 0)::float8 as position
                  from ${searchSnapshot}
                  group by 1 order by 2 desc, 3 desc, 1 limit ${TOP}`
            )) as unknown as ({ key: string } & Sums)[])
      return { asOf, now: now as Window, before: before as Window, rows }
    }
  )
  if (!read) return refused(noData())
  const current = totals(read.now)
  const previous = totals(read.before)
  const synced = properties.map((p) => p.lastSyncedAt?.getTime() ?? 0)
  return GetSearchPerformanceOutput.parse({
    totals: current,
    delta:
      read.before.days > 0
        ? {
            clicks: current.clicks - previous.clicks,
            impressions: current.impressions - previous.impressions,
            ctr: current.ctr - previous.ctr,
            position: current.position - previous.position,
          }
        : null,
    rows: read.rows.map((r) => ({
      key: r.key.slice(0, 500),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
      position: r.position,
    })),
    as_of: read.asOf,
    stale:
      state === "needs_reauth" ||
      Math.max(0, ...synced) < Date.now() - STALE_MS,
  })
}

/** Whether `host` is the property's own host, or under it for a whole domain. */
const covers = (p: Property, host: string) =>
  host === p.host || (p.kind === "domain" && host.endsWith(`.${p.host}`))

export async function getIndexing(
  context: ToolContext,
  { url }: GetIndexingInput
): Promise<GetIndexingOutput> {
  const { state, properties } = await held(context)
  if (!state || state === "revoked") return { connected: false }
  const sitemapOf = (p: Property) =>
    SearchSitemap.safeParse(p.sitemap).data ?? null
  if (url) {
    // The host must be one of the org's own; the orchestrator checks the
    // property again before it asks Google.
    const host = URL.canParse(url) ? new URL(url).host : ""
    const property = properties.find((p) => covers(p, host))
    if (!property) return refused(foreign())
    const page = await domainAnswer(
      await bridge(
        context.env,
        context.owner,
        `/search/inspect?url=${encodeURIComponent(url)}`,
        { method: "GET" }
      ),
      UrlStatus.parse
    )
    if ("outcome" in page) return page
    return GetIndexingOutput.parse({
      property: property.state,
      sitemap: sitemapOf(property),
      pages: [page],
    })
  }
  // The newest property is the one the site is on; an older one redirects.
  const [property] = properties
  if (!property) return { property: "pending", sitemap: null, pages: [] }
  const rows = await context.kit.withOrg({ orgId: context.owner.orgId }, (db) =>
    db
      .select()
      .from(searchUrlStatus)
      .where(eq(searchUrlStatus.propertyId, property.id))
      // Pages Google has not indexed first, then the latest looked at.
      .orderBy(
        sql`(${searchUrlStatus.verdict} = 'PASS')`,
        sql`${searchUrlStatus.inspectedAt} desc`
      )
      .limit(50)
  )
  return GetIndexingOutput.parse({
    property: property.state,
    sitemap: sitemapOf(property),
    pages: rows.map((r) => ({
      url: r.url,
      verdict:
        UrlStatus.shape.verdict.safeParse(r.verdict).data ?? "UNSPECIFIED",
      coverage_state: r.coverageState,
      indexing_state: r.indexingState,
      robots_state: r.robotsState,
      google_canonical: r.googleCanonical,
      last_crawl_time: r.lastCrawlTime?.toISOString() ?? null,
      inspected_at: r.inspectedAt.toISOString(),
    })),
  })
}
