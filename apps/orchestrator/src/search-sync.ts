import { DeploymentManifest, siteHost } from "@workspace/contracts"
import {
  appendEvent,
  conversationMessages,
  eq,
  events,
  failureCode,
  type OrgScopedDb,
  orgs,
  searchConnections,
  searchDaily,
  searchProperties,
  searchSnapshot,
  searchUrlStatus,
  serverMessageId,
  sql,
  type Tenancy,
} from "@workspace/db"
import {
  GoogleError,
  inspectUrl,
  listSitemaps,
  NeedsReauth,
  openToken,
  revokeToken,
  searchAnalytics,
  submitSitemap,
} from "./google.ts"
import { activeDeployment, restoreVerification } from "./publish.ts"
import {
  accessToken,
  FILE,
  forgetHost,
  ownProperty,
  siteUrlOf,
  startSearch,
} from "./search.ts"
import { weeklyReport } from "./search-report.ts"
import { type DailyRow, suggest, type Window } from "./search-rules.ts"

/**
 * Search Console after the connect: what a publish tells search engines, the
 * daily pull into Postgres (`SearchSyncWorkflow`'s step bodies), the Monday
 * message, and the disconnect. Every Google call names a `site_url` read
 * back through `ownProperty` first.
 */

const DAY = 86_400_000
/** A property pulled less than this long ago is not due again. */
export const SYNC_AFTER_MS = 20 * 3_600_000
/** Inspections a property gets a day, of its sitemap pages not PASS or older than `REINSPECT_MS`. */
export const INSPECT_CAP = 20
export const REINSPECT_MS = 7 * DAY
/** The query and page pairs kept, by impressions. */
export const SNAPSHOT_ROWS = 1_000
// shortcut: Google sorts by clicks, so the top 1,000 by impressions are cut
// from the first 5,000; raise it if a site ever has more pairs than that.
const SNAPSHOT_FETCH = 5_000
const INDEXNOW_URL = "https://api.indexnow.org/indexnow"
const FETCH_TIMEOUT_MS = 10_000

/** Search Console's day, YYYY-MM-DD in Pacific time, `days` before `now`. */
export const pacificDay = (now: Date, days = 0) =>
  new Date(now.getTime() - days * DAY).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  })

/** `search-sync-{org_id}-{yyyy-mm-dd}`: a second start the same day is a no-op. */
export const syncInstanceId = (orgId: string, day: string) =>
  `search-sync-${orgId}-${day}`

export type SyncParams = { org_id: string }

const isFile = (property: { method: string; token: string | null }) =>
  property.method === "file" && !!property.token && FILE.test(property.token)

// ---------------------------------------------------------------------------
// After a publish
// ---------------------------------------------------------------------------

async function manifestOf(sites: R2Bucket, siteId: string, revisionId: string) {
  const stored = await sites.get(`sites/${siteId}/${revisionId}/manifest.json`)
  if (!stored) return null
  const parsed = DeploymentManifest.safeParse(await stored.json())
  return parsed.success ? parsed.data : null
}

/** The live pages whose HTML differs from the revision before, as full URLs. */
export async function changedUrls(
  sites: R2Bucket,
  host: string,
  siteId: string,
  revisionId: string,
  previousRevisionId: string | null
): Promise<string[]> {
  const now = await manifestOf(sites, siteId, revisionId)
  if (!now) return []
  const before = previousRevisionId
    ? await manifestOf(sites, siteId, previousRevisionId)
    : null
  const was = new Map(
    before?.routes.map((r) => [r.path, before.files[r.file]]) ?? []
  )
  return now.routes
    .filter(
      (r) => r.file.endsWith(".html") && was.get(r.path) !== now.files[r.file]
    )
    .map((r) => `https://${host}${r.path}`)
}

/** Bing and the other IndexNow engines, told about `urls`; no Google connection needed. */
export async function pingIndexNow(
  key: string,
  host: string,
  urls: string[]
): Promise<number> {
  const response = await fetch(INDEXNOW_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host,
      key,
      keyLocation: `https://${host}/${key}.txt`,
      urlList: urls.slice(0, 10_000),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  await response.body?.cancel()
  if (!response.ok) {
    console.error(
      JSON.stringify({
        code: "search.indexnow_refused",
        status: response.status,
      })
    )
  }
  return response.status
}

export type AfterPublish = {
  indexnow: number | null
  sitemap: boolean
  started: boolean
}

/**
 * The publish's `search` step: IndexNow for the changed pages, always; the
 * sitemap sent to Google again when the live host is a verified property;
 * a `SearchWorkflow` when the org is connected and the host has no property.
 * Never throws: a search engine is never a reason for a publish to fail.
 */
export async function afterPublish(
  env: Env,
  kit: Tenancy,
  p: {
    orgId: string
    host: string
    siteId: string
    revisionId: string
    previousRevisionId: string | null
  }
): Promise<AfterPublish> {
  const done: AfterPublish = { indexnow: null, sitemap: false, started: false }
  const quietly = async (what: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      console.error(
        JSON.stringify({
          code: `search.${what}_failed`,
          org_id: p.orgId,
          error: failureCode(error),
        })
      )
    }
  }
  await quietly("indexnow", async () => {
    const urls = await changedUrls(
      env.SITES,
      p.host,
      p.siteId,
      p.revisionId,
      p.previousRevisionId
    )
    // Staging sites are noindex, so search engines never hear of their URLs.
    const staging = env.SITE_HOST_SUFFIX.startsWith("-stg")
    if (env.INDEXNOW_KEY && !staging && urls.length > 0) {
      done.indexnow = await pingIndexNow(env.INDEXNOW_KEY, p.host, urls)
    }
  })
  await quietly("sitemap", async () => {
    const [connection] = await kit.withOrg({ orgId: p.orgId }, (db) =>
      db.select({ state: searchConnections.state }).from(searchConnections)
    )
    if (connection?.state !== "active") return
    let property: Awaited<ReturnType<typeof ownProperty>>
    try {
      property = await ownProperty(kit, p.orgId, siteUrlOf(p.host))
    } catch (error) {
      if ((error as Error).name !== "search.foreign_site") throw error
      await startSearch(env, p.orgId, p.host)
      done.started = true
      return
    }
    if (property.state !== "verified") return
    await submitSitemap(
      await accessToken(env, kit, p.orgId),
      property.siteUrl,
      `https://${p.host}/sitemap.xml`
    )
    done.sitemap = true
  })
  return done
}

// ---------------------------------------------------------------------------
// The daily pull
// ---------------------------------------------------------------------------

/**
 * Of `orgIds`, those with a live connection and a verified property not
 * pulled for 20 h, each started as one `SearchSyncWorkflow` for `day`. An org
 * that throws is logged and skipped. Returns how many were due.
 */
export async function startDueSyncs(
  env: Env,
  kit: Tenancy,
  orgIds: string[],
  day: string,
  now = Date.now()
): Promise<number> {
  const stale = new Date(now - SYNC_AFTER_MS).toISOString()
  const due: string[] = []
  for (const orgId of orgIds) {
    try {
      const [row] = await kit.withOrg({ orgId }, (db) =>
        db
          .select({ id: searchProperties.id })
          .from(searchProperties)
          .innerJoin(
            searchConnections,
            eq(searchConnections.orgId, searchProperties.orgId)
          )
          .where(
            sql`${searchConnections.state} = 'active' and ${searchProperties.state} = 'verified'
              and (${searchProperties.lastSyncedAt} is null or ${searchProperties.lastSyncedAt} < ${stale}::timestamptz)`
          )
          .limit(1)
      )
      if (row) due.push(orgId)
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "search.sync_due_failed",
          org_id: orgId,
          error: failureCode(error),
        })
      )
    }
  }
  // createBatch skips an id that already exists, so a rerun the same day
  // starts nothing; one that fails is the next hour's to start.
  for (let i = 0; i < due.length; i += 100) {
    try {
      await env.SEARCH_SYNC.createBatch(
        due.slice(i, i + 100).map((orgId) => ({
          id: syncInstanceId(orgId, day),
          params: { org_id: orgId },
        }))
      )
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "search.sync_start_failed",
          error: failureCode(error),
        })
      )
    }
  }
  return due.length
}

/**
 * The sync's first step: the org's verified properties, and every missing
 * verification file of the org's own slug host put back, since KV is a cache
 * of `search_properties.token`. shortcut: the slug host only, because the
 * router serves a file on any host and a custom domain may since be another
 * org's; connected domains bring their own check with that story.
 */
export async function syncTargets(
  env: Env,
  kit: Tenancy,
  orgId: string
): Promise<string[]> {
  const { slug, rows } = await kit.withOrg({ orgId }, async (db) => {
    const [org] = await db
      .select({ slug: orgs.slug })
      .from(orgs)
      .where(eq(orgs.id, orgId))
    const [connection] = await db
      .select({ state: searchConnections.state })
      .from(searchConnections)
    return {
      slug: org?.slug,
      rows:
        connection?.state === "active"
          ? await db.select().from(searchProperties)
          : [],
    }
  })
  const own = slug ? siteHost(slug, env.SITE_HOST_SUFFIX) : null
  for (const row of rows) {
    if (row.host === own && row.token && isFile(row)) {
      await restoreVerification(env, row.host, row.token)
    }
  }
  return rows.filter((r) => r.state === "verified").map((r) => r.siteUrl)
}

const count = (x: number) => Math.max(0, Math.round(x))
const timeOf = (x?: string) => (x ? new Date(x) : null)

/** Google's answer about one property, not its outage or a revoked token. */
const refusedBy = (error: unknown) =>
  error instanceof GoogleError &&
  !(error instanceof NeedsReauth) &&
  error.name !== "google.unavailable"

/**
 * One property's numbers: 30 days by date into `search_daily`, the rolling
 * 28 days by query and page replacing `search_snapshot`, and the sitemap as
 * Google reports it. `last_synced_at` is set with them. A property Google
 * refuses is marked `stale` and answers `stale`, so the org's others still
 * pull; its outage and a revoked token throw.
 */
export async function pullProperty(
  env: Env,
  kit: Tenancy,
  orgId: string,
  siteUrl: string,
  now = new Date()
): Promise<{ days: number; pairs: number; stale?: true }> {
  const property = await ownProperty(kit, orgId, siteUrl)
  const access = await accessToken(env, kit, orgId)
  const endDate = pacificDay(now)
  let daily: Awaited<ReturnType<typeof searchAnalytics>>
  let pairs: typeof daily
  let sitemaps: Awaited<ReturnType<typeof listSitemaps>>
  try {
    daily = await searchAnalytics(access, property.siteUrl, {
      startDate: pacificDay(now, 29),
      endDate,
      dimensions: ["date"],
      dataState: "all",
    })
    pairs = await searchAnalytics(access, property.siteUrl, {
      startDate: pacificDay(now, 27),
      endDate,
      dimensions: ["query", "page"],
      dataState: "all",
      rowLimit: SNAPSHOT_FETCH,
    })
    sitemaps = await listSitemaps(access, property.siteUrl)
  } catch (error) {
    if (!refusedBy(error)) throw error
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(searchProperties)
        .set({ state: "stale" })
        .where(eq(searchProperties.id, property.id))
    )
    return { days: 0, pairs: 0, stale: true }
  }
  const ours =
    sitemaps.find((s) => s.path === `https://${property.host}/sitemap.xml`) ??
    sitemaps[0]
  const ids = { orgId, propertyId: property.id }
  const days = daily.rows.filter((r) => r.keys?.[0])
  const top = pairs.rows
    .filter((r) => r.keys?.[0] && r.keys[1])
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, SNAPSHOT_ROWS)
  const metrics = (r: (typeof days)[number]) => ({
    clicks: count(r.clicks),
    impressions: count(r.impressions),
    ctr: r.ctr,
    position: r.position,
  })
  await kit.withOrg({ orgId }, async (db) => {
    if (days.length > 0) {
      await db
        .insert(searchDaily)
        .values(
          days.map((r) => ({ ...ids, date: r.keys?.[0] ?? "", ...metrics(r) }))
        )
        .onConflictDoUpdate({
          target: [searchDaily.orgId, searchDaily.propertyId, searchDaily.date],
          set: {
            clicks: sql`excluded.clicks`,
            impressions: sql`excluded.impressions`,
            ctr: sql`excluded.ctr`,
            position: sql`excluded.position`,
          },
        })
    }
    await db
      .delete(searchSnapshot)
      .where(eq(searchSnapshot.propertyId, property.id))
    if (top.length > 0) {
      await db.insert(searchSnapshot).values(
        top.map((r) => ({
          ...ids,
          query: r.keys?.[0] ?? "",
          page: r.keys?.[1] ?? "",
          ...metrics(r),
          windowEnd: endDate,
        }))
      )
    }
    await db
      .update(searchProperties)
      .set({
        lastSyncedAt: now,
        ...(ours && {
          sitemap: {
            submitted_at: timeOf(ours.lastSubmitted)?.toISOString() ?? null,
            last_downloaded: timeOf(ours.lastDownloaded)?.toISOString() ?? null,
            errors: count(Number(ours.errors ?? 0) || 0),
            warnings: count(Number(ours.warnings ?? 0) || 0),
          },
        }),
      })
      .where(eq(searchProperties.id, property.id))
  })
  return { days: days.length, pairs: top.length }
}

/** The page addresses in the host's live sitemap, on that host only. */
async function sitemapPages(host: string): Promise<string[]> {
  const response = await fetch(`https://${host}/sitemap.xml`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    await response.body?.cancel()
    return []
  }
  const xml = await response.text()
  const base = `https://${host}/`
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
    .map((m) => m[1]?.replaceAll("&amp;", "&") ?? "")
    .filter((url) => url.startsWith(base))
    .slice(0, 1_000)
}

/**
 * Up to `INSPECT_CAP` of the property's sitemap pages through URL Inspection:
 * never inspected first, then not PASS or older than a week, oldest first.
 * Google's refusal of one page, or its quota, ends the day's round with what
 * it has; only a revoked token throws.
 */
export async function inspectPages(
  env: Env,
  kit: Tenancy,
  orgId: string,
  siteUrl: string,
  now = new Date()
): Promise<number> {
  const property = await ownProperty(kit, orgId, siteUrl)
  let pages: string[]
  try {
    pages = await sitemapPages(property.host)
  } catch {
    return 0
  }
  const known = new Map(
    (
      await kit.withOrg({ orgId }, (db) =>
        db
          .select({
            url: searchUrlStatus.url,
            verdict: searchUrlStatus.verdict,
            inspectedAt: searchUrlStatus.inspectedAt,
          })
          .from(searchUrlStatus)
          .where(eq(searchUrlStatus.propertyId, property.id))
      )
    ).map((r) => [r.url, r])
  )
  const stale = now.getTime() - REINSPECT_MS
  const age = (url: string) => known.get(url)?.inspectedAt.getTime() ?? 0
  const due = pages
    .filter((url) => {
      const row = known.get(url)
      return row?.verdict !== "PASS" || row.inspectedAt.getTime() < stale
    })
    .sort((a, b) => age(a) - age(b))
    .slice(0, INSPECT_CAP)
  if (due.length === 0) return 0
  const access = await accessToken(env, kit, orgId)
  let inspected = 0
  for (const url of due) {
    let status: Awaited<ReturnType<typeof inspectUrl>>
    try {
      status = await inspectUrl(access, property.siteUrl, url)
    } catch (error) {
      if (error instanceof NeedsReauth) throw error
      break
    }
    const values = {
      verdict: status.verdict ?? "VERDICT_UNSPECIFIED",
      coverageState: status.coverageState ?? null,
      indexingState: status.indexingState ?? null,
      robotsState: status.robotsTxtState ?? null,
      googleCanonical: status.googleCanonical ?? null,
      lastCrawlTime: timeOf(status.lastCrawlTime),
      inspectedAt: now,
    }
    await kit.withOrg({ orgId }, (db) =>
      db
        .insert(searchUrlStatus)
        .values({ orgId, propertyId: property.id, url, ...values })
        .onConflictDoUpdate({
          target: [
            searchUrlStatus.orgId,
            searchUrlStatus.propertyId,
            searchUrlStatus.url,
          ],
          set: values,
        })
    )
    inspected++
  }
  return inspected
}

// ---------------------------------------------------------------------------
// The Monday report
// ---------------------------------------------------------------------------

/** `2026-W42`, the ISO week `now` falls in. */
export function isoWeek(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - jan1) / DAY + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** Days summed across the org's properties, position weighted by impressions. */
function byDate(rows: DailyRow[]): DailyRow[] {
  const days = new Map<string, DailyRow>()
  for (const r of rows) {
    const d = days.get(r.date) ?? {
      date: r.date,
      clicks: 0,
      impressions: 0,
      position: 0,
    }
    const impressions = d.impressions + r.impressions
    d.position = impressions
      ? (d.position * d.impressions + r.position * r.impressions) / impressions
      : 0
    d.clicks += r.clicks
    d.impressions = impressions
    days.set(r.date, d)
  }
  return [...days.values()]
}

/** The week ending `weeksBack` weeks before the newest day, or null with no day in it. */
function windowOf(days: DailyRow[], weeksBack: number): Window | null {
  const end = days.reduce((m, r) => (r.date > m ? r.date : m), "")
  if (!end) return null
  const endMs = Date.parse(end)
  const inside = days.filter((r) => {
    const back = (endMs - Date.parse(r.date)) / DAY
    return back >= weeksBack * 7 && back < (weeksBack + 1) * 7
  })
  if (inside.length === 0) return null
  const impressions = inside.reduce((s, r) => s + r.impressions, 0)
  return {
    clicks: inside.reduce((s, r) => s + r.clicks, 0),
    impressions,
    position: impressions
      ? inside.reduce((s, r) => s + r.position * r.impressions, 0) / impressions
      : 0,
  }
}

/** A heartbeat digest item (heartbeat.ts), as this file makes one. */
export type WeeklyItem = {
  key: string
  since: string
  facts: Record<string, string>
}

/**
 * The org's Monday report as a heartbeat item, or null: the week's numbers
 * and at most one suggestion for a connected org, a sign-in prompt for a
 * paused one, and for an org never connected with a live site the one
 * reminder ever. `day` is the org's local Monday at 00:00 UTC, so the week is
 * the owner's week whatever the zone. The facts carry the template's text
 * for the writer, and `chip`, the button the message gets. A fault on our
 * side (a noindex, a robots block, a sitemap error, another canonical)
 * raises an alert instead, once a week, never an owner message.
 */
export async function weeklyItem(
  db: OrgScopedDb,
  orgId: string,
  now: Date,
  day: Date
): Promise<WeeklyItem | null> {
  const week = isoWeek(day)
  const since = day.toISOString()
  const input = await (async () => {
    const [connection] = await db
      .select({ state: searchConnections.state })
      .from(searchConnections)
    if (!connection) {
      if (!(await activeDeployment(db, orgId))) return null
      // Asked by the Monday message before the heartbeat took it over.
      const [sent] = await db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          eq(
            conversationMessages.id,
            serverMessageId(`search-reminder-${orgId}`)
          )
        )
      return {
        key: "search_report:connect:1",
        report: { state: "never" as const, reminded: !!sent },
      }
    }
    const key = `search_report:${week}:1`
    if (connection.state !== "active") {
      const [paused] = await db
        .select({ at: events.recordedAt })
        .from(events)
        .where(sql`${events.type} = 'search.needs_reauth'`)
        .orderBy(sql`${events.recordedAt} desc`)
        .limit(1)
      return {
        key,
        report: { state: connection.state, pausedOn: paused?.at },
      }
    }
    const properties = await db.select().from(searchProperties)
    const daily = byDate(
      await db
        .select({
          date: searchDaily.date,
          clicks: searchDaily.clicks,
          impressions: searchDaily.impressions,
          position: searchDaily.position,
        })
        .from(searchDaily)
        .where(sql`${searchDaily.date} >= ${pacificDay(now, 30)}::date`)
    )
    const snapshot = await db
      .select({
        query: searchSnapshot.query,
        page: searchSnapshot.page,
        clicks: searchSnapshot.clicks,
        impressions: searchSnapshot.impressions,
        ctr: searchSnapshot.ctr,
        position: searchSnapshot.position,
      })
      .from(searchSnapshot)
    const urls = (await db.select().from(searchUrlStatus)).map((r) => ({
      url: r.url,
      verdict: r.verdict,
      coverage_state: r.coverageState,
      indexing_state: r.indexingState,
      robots_state: r.robotsState,
      google_canonical: r.googleCanonical,
      last_crawl_time: r.lastCrawlTime,
      inspected_at: r.inspectedAt,
    }))
    const sitemapErrors = properties.reduce(
      (s, p) => s + ((p.sitemap as { errors?: number } | null)?.errors ?? 0),
      0
    )
    // shortcut: no record yet ties a publish to the pages it changed, so the
    // 28-day cooldown and the before/after result see none; and the weekly
    // cadence is itself the one-suggestion-a-week cap.
    const { suggestion, alerts } = suggest(
      {
        daily,
        snapshot,
        urls,
        changes: [],
        sitemapErrors,
        lastSuggestionAt: null,
      },
      now
    )
    for (const alert of alerts) {
      // Every Monday beat reads the report until one surfaces it.
      const [raised] = await db
        .select({ id: events.eventId })
        .from(events)
        .where(
          sql`${events.type} = 'alert.raised' and ${events.occurredAt} > ${new Date(now.getTime() - 8 * DAY).toISOString()}::timestamptz and ${events.payload}->>'kind' = ${`search.${alert.kind}`} and ${events.payload}->>'week' = ${week}`
        )
        .limit(1)
      if (raised) continue
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "alert.raised",
        payload: {
          kind: `search.${alert.kind}`,
          urls: alert.urls.slice(0, 20),
          week,
        },
      })
    }
    return {
      key,
      report: {
        state: "active" as const,
        thisWeek: windowOf(daily, 0) ?? undefined,
        lastWeek: windowOf(daily, 1),
        suggestion,
      },
    }
  })()
  if (!input) return null
  const report = weeklyReport(input.report)
  if (!report) return null
  const [chip] = report.chips
  return {
    key: input.key,
    since,
    facts: { report: report.text.join(" "), ...(chip && { chip }) },
  }
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

/**
 * The owner's disconnect, and part of deleting their account: the grant
 * revoked at Google, every verification file the org's properties had served
 * dropped, the `search_*` rows deleted, and one `search.disconnected` row.
 * The connection row stays as `revoked` with no token so the CoS does not
 * ask again, unless `erase` (the account is going). The properties stay in
 * the owner's Google account. Safe to repeat.
 */
export async function disconnectSearch(
  env: Env,
  kit: Tenancy,
  orgId: string,
  erase = false
): Promise<void> {
  const { connection, properties } = await kit.withOrg(
    { orgId },
    async (db) => ({
      connection: (
        await db
          .select({ token: searchConnections.refreshToken })
          .from(searchConnections)
      )[0],
      properties: await db.select().from(searchProperties),
    })
  )
  if (!connection?.token && properties.length === 0) {
    if (erase && connection) {
      await kit.withOrg({ orgId }, (db) => db.delete(searchConnections))
    }
    return
  }
  if (connection?.token) {
    try {
      await revokeToken(await openToken(env, orgId, connection.token))
    } catch (error) {
      // The rows still go; the grant stays in the owner's Google account.
      console.error(
        JSON.stringify({
          code: "search.revoke_failed",
          error: failureCode(error),
        })
      )
    }
  }
  for (const p of properties) await forgetHost(env, kit, orgId, p.host)
  await kit.withOrg({ orgId }, async (db) => {
    // The child tables go with their property (on delete cascade).
    await db.delete(searchProperties)
    if (erase) await db.delete(searchConnections)
    else {
      await db
        .update(searchConnections)
        .set({ state: "revoked", refreshToken: null })
    }
    await appendEvent(db, {
      orgId,
      assignmentId: null,
      staffId: null,
      type: "search.disconnected",
      payload: { properties: properties.length },
    })
  })
}
