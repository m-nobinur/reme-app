import {
  type OrgScopedDb,
  searchDaily,
  searchProperties,
  searchSnapshot,
  searchUrlStatus,
  sql,
  type Tenancy,
} from "@workspace/db"
import { tell } from "./search.ts"
import { cleanQuery } from "./search-rules.ts"

/**
 * What the owner hears besides the Monday report: the first numbers Google
 * has for the site, and, for a site still without any, one check-in on day
 * 10. Fixed templates, since the numbers are quoted. Each message has a key
 * of its own, so a daily sync that finds the same thing says nothing twice.
 */

const DAY = 86_400_000
/** The check-in comes this many days after Google verified the site. */
export const CHECK_IN_DAYS = 10

const people = (n: number) => (n === 1 ? "1 person" : `${n} people`)

export type FirstData = {
  impressions: number
  clicks: number
  /** The query with the most appearances, when Google named any. */
  query?: string
}

/** "34 people have seen you for "dog groomer chapel allerton" so far, and 3 clicked." */
export function firstDataText({ impressions, clicks, query }: FirstData) {
  const clicked = clicks === 0 ? "none clicked yet" : `${clicks} clicked`
  const cleaned = query ? cleanQuery(query) : ""
  const seen = cleaned
    ? `${people(impressions)} saw you for "${cleaned}"`
    : `${people(impressions)} saw your site on Google`
  return `Your first search numbers are in: ${seen}, ${clicked}. I'll send you how it's going every Monday.`
}

export type CheckIn = {
  host: string
  days: number
  /** Pages Google has been asked about, and how many of them it has indexed. */
  pages: number
  indexed: number
}

export function checkInText({ host, days, pages, indexed }: CheckIn) {
  const seen = `It's been ${days} days since ${host} went on Google, and nobody has seen it in search results yet. That's normal for a new site: it usually takes a few weeks.`
  const progress =
    pages === 0
      ? ""
      : ` Google has indexed ${indexed} of the ${pages} pages it has looked at.`
  return `${seen}${progress} Sharing the link with customers and on your social pages helps Google find it sooner.`
}

/** The sums and the top query over the stored 28 days, or null with no appearance at all. */
async function firstData(db: OrgScopedDb): Promise<FirstData | null> {
  const [total] = await db
    .select({
      impressions: sql<number>`coalesce(sum(${searchDaily.impressions}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${searchDaily.clicks}), 0)::int`,
    })
    .from(searchDaily)
  if (!total || total.impressions === 0) return null
  const [top] = await db
    .select({
      query: searchSnapshot.query,
      impressions: sql<number>`sum(${searchSnapshot.impressions})::int`,
      clicks: sql<number>`sum(${searchSnapshot.clicks})::int`,
    })
    .from(searchSnapshot)
    .groupBy(searchSnapshot.query)
    .orderBy(sql`sum(${searchSnapshot.impressions}) desc`)
    .limit(1)
  // The top query's own count when Google gave queries; otherwise the site's.
  return top
    ? { impressions: top.impressions, clicks: top.clicks, query: top.query }
    : total
}

/** The site verified `CHECK_IN_DAYS` ago or more, with what Google says of its pages. */
async function checkIn(db: OrgScopedDb, now: Date): Promise<CheckIn | null> {
  const [property] = await db
    .select({
      id: searchProperties.id,
      host: searchProperties.host,
      verifiedAt: searchProperties.verifiedAt,
    })
    .from(searchProperties)
    .where(
      sql`${searchProperties.state} = 'verified' and ${searchProperties.verifiedAt} <= ${new Date(now.getTime() - CHECK_IN_DAYS * DAY).toISOString()}::timestamptz`
    )
    .orderBy(sql`${searchProperties.verifiedAt} desc`)
    .limit(1)
  if (!property?.verifiedAt) return null
  const [pages] = await db
    .select({
      pages: sql<number>`count(*)::int`,
      indexed: sql<number>`count(*) filter (where ${searchUrlStatus.verdict} = 'PASS')::int`,
    })
    .from(searchUrlStatus)
  return {
    host: property.host,
    days: Math.floor((now.getTime() - property.verifiedAt.getTime()) / DAY),
    pages: pages?.pages ?? 0,
    indexed: pages?.indexed ?? 0,
  }
}

/**
 * The daily sync's last step: the first-numbers message once the site has
 * appeared in search, else the day-10 check-in for a verified site with none.
 * A busy chat or one holding a card throws, for the step's retries.
 */
export async function sayPayoff(
  kit: Tenancy,
  orgId: string,
  now = new Date()
): Promise<"first_data" | "check_in" | null> {
  const { data, due } = await kit.withOrg({ orgId }, async (db) => {
    const first = await firstData(db)
    return { data: first, due: first ? null : await checkIn(db, now) }
  })
  if (data) {
    await tell(kit, orgId, `search.first_data:${orgId}`, {
      text: [firstDataText(data)],
    })
    return "first_data"
  }
  if (!due) return null
  await tell(kit, orgId, `search.check_in:${orgId}`, {
    text: [checkInText(due)],
  })
  return "check_in"
}
