// Search insight rules: pure functions over the rows `search_daily`,
// `search_snapshot` and `search_url_status` hold. No database, no Google call.
// Queries are text strangers typed, so nothing here returns one uncleaned.

const DAY = 86_400_000
type When = Date | string

export type DailyRow = {
  date: string
  clicks: number
  impressions: number
  position: number
}
export type SnapshotRow = {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}
export type UrlRow = {
  url: string
  verdict: string
  coverage_state: string | null
  indexing_state: string | null
  robots_state: string | null
  google_canonical: string | null
  last_crawl_time: When | null
  inspected_at: When
}
/** A past change to a page. `before` and `after` are the live 28-day queries. */
export type PageChange = {
  url: string
  changedAt: When
  query?: string
  reported: boolean
  before?: Window
  after?: Window
}
export type Window = { clicks: number; impressions: number; position: number }

export type RulesInput = {
  daily: DailyRow[]
  snapshot: SnapshotRow[]
  urls: UrlRow[]
  changes: PageChange[]
  sitemapErrors: number
  lastSuggestionAt: When | null
}

export type Suggestion =
  | {
      kind: "drop"
      previous: number
      current: number
      inspect: string[]
      chips: string[]
    }
  | {
      kind: "result"
      page: string
      query: string | null
      before: Window
      after: Window
      outcome: "up" | "down" | "same"
      chips: string[]
    }
  | { kind: "unknown_to_google"; urls: string[]; chips: string[] }
  | { kind: "crawled_not_indexed"; urls: string[]; chips: string[] }
  | {
      kind: "low_ctr"
      page: string
      query: string
      impressions: number
      ctr: number
      position: number
      chips: string[]
    }
  | {
      kind: "striking_distance"
      page: string
      query: string
      impressions: number
      position: number
      chips: string[]
    }

export type Alert = {
  kind: "noindex" | "robots_blocked" | "canonical_mismatch" | "sitemap_errors"
  urls: string[]
}

export const WEEK_MS = 7 * DAY
export const COOLDOWN_MS = 28 * DAY
const MIN_IMPRESSIONS = 50
const QUERY_MAX = 80
const at = (d: When) => new Date(d).getTime()

/** A query cleaned to one line of plain text, cut to length, safe to put in quotes. */
export function cleanQuery(q: string): string {
  const s = q
    .replace(/[\p{C}\p{Z}]+/gu, " ")
    .replace(/["“”`<>[\]*]/g, "")
    .trim()
  return s.length > QUERY_MAX ? `${s.slice(0, QUERY_MAX - 1).trimEnd()}…` : s
}

const sameUrl = (a: string, b: string) =>
  a.replace(/#.*$/, "").replace(/\/$/, "") ===
  b.replace(/#.*$/, "").replace(/\/$/, "")

const sum = (rows: DailyRow[], key: "clicks" | "impressions") =>
  rows.reduce((n, r) => n + r[key], 0)

/** Problems on our side: a platform alert each, never an owner message. */
export function alerts(urls: UrlRow[], sitemapErrors: number): Alert[] {
  const by = (test: (u: UrlRow) => boolean) =>
    urls
      .filter(test)
      .map((u) => u.url)
      .slice(0, 5)
  const found: Alert[] = [
    {
      kind: "noindex",
      urls: by(
        (u) =>
          /noindex/i.test(u.coverage_state ?? "") ||
          /BLOCKED_BY_(META_TAG|HTTP_HEADER)/.test(u.indexing_state ?? "")
      ),
    },
    {
      kind: "robots_blocked",
      urls: by(
        (u) =>
          /DISALLOWED/.test(u.robots_state ?? "") ||
          /BLOCKED_BY_ROBOTS_TXT/.test(u.indexing_state ?? "")
      ),
    },
    {
      kind: "canonical_mismatch",
      urls: by(
        (u) =>
          u.google_canonical !== null && !sameUrl(u.google_canonical, u.url)
      ),
    },
    { kind: "sitemap_errors", urls: [] },
  ]
  return found.filter((a) =>
    a.kind === "sitemap_errors" ? sitemapErrors > 0 : a.urls.length > 0
  )
}

function dropRule(
  daily: DailyRow[],
  snapshot: SnapshotRow[]
): Suggestion | null {
  const end = daily.reduce((m, r) => (r.date > m ? r.date : m), "")
  if (!end) return null
  const endMs = at(end)
  const age = (r: DailyRow) => (endMs - at(r.date)) / DAY
  const current = sum(
    daily.filter((r) => age(r) < 7),
    "clicks"
  )
  const previous = sum(
    daily.filter((r) => age(r) >= 7 && age(r) < 14),
    "clicks"
  )
  if (previous < 20 || current > previous * 0.7) return null
  const clicks = new Map<string, number>()
  for (const r of snapshot)
    clicks.set(r.page, (clicks.get(r.page) ?? 0) + r.clicks)
  const inspect = [...clicks]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([page]) => page)
  return {
    kind: "drop",
    previous,
    current,
    inspect,
    chips: ["Show all queries"],
  }
}

function resultRule(changes: PageChange[], now: number): Suggestion | null {
  for (const c of changes) {
    if (
      c.reported ||
      !c.before ||
      !c.after ||
      now - at(c.changedAt) < COOLDOWN_MS
    )
      continue
    const diff = c.after.clicks - c.before.clicks
    const outcome =
      Math.abs(diff) <= Math.max(2, c.before.clicks * 0.2)
        ? "same"
        : diff > 0
          ? "up"
          : "down"
    return {
      kind: "result",
      page: c.url,
      query: c.query ? cleanQuery(c.query) : null,
      before: c.before,
      after: c.after,
      outcome,
      chips: ["Show all queries"],
    }
  }
  return null
}

/**
 * At most one owner suggestion, none within a week of the last one, none for a
 * page changed in the last 28 days. The alerts are separate and not capped.
 */
export function suggest(
  input: RulesInput,
  now: Date
): { suggestion: Suggestion | null; alerts: Alert[] } {
  const found = alerts(input.urls, input.sitemapErrors)
  const t = now.getTime()
  if (input.lastSuggestionAt && t - at(input.lastSuggestionAt) < WEEK_MS)
    return { suggestion: null, alerts: found }
  const cooling = (url: string) =>
    input.changes.some(
      (c) => sameUrl(c.url, url) && t - at(c.changedAt) < COOLDOWN_MS
    )
  const rows = input.snapshot.filter(
    (r) => r.impressions >= MIN_IMPRESSIONS && !cooling(r.page)
  )
  const top = (hits: SnapshotRow[]) =>
    hits.sort((a, b) => b.impressions - a.impressions)[0]

  const unknown = input.urls.filter(
    (u) => /unknown to google/i.test(u.coverage_state ?? "") && !cooling(u.url)
  )
  // shortcut: how long a page has been in this state is not stored, so a crawl
  // 14+ days ago that left it unindexed stands in; store the first-seen date if
  // that proves too eager.
  const stuck = input.urls.filter(
    (u) =>
      /crawled.{0,3}currently not indexed/i.test(u.coverage_state ?? "") &&
      u.last_crawl_time !== null &&
      t - at(u.last_crawl_time) >= 14 * DAY &&
      !cooling(u.url)
  )
  const low = top(
    rows.filter((r) => r.position >= 4 && r.position <= 10 && r.ctr <= 0.02)
  )
  const near = top(rows.filter((r) => r.position >= 8 && r.position <= 20))

  const suggestion =
    dropRule(input.daily, input.snapshot) ??
    resultRule(input.changes, t) ??
    (unknown.length
      ? ({
          kind: "unknown_to_google",
          urls: unknown.map((u) => u.url),
          chips: ["Why are some pages missing?"],
        } as const)
      : null) ??
    (stuck.length
      ? ({
          kind: "crawled_not_indexed",
          urls: stuck.map((u) => u.url),
          chips:
            stuck.length > 1
              ? ["Yes, I'll tell you", "Merge them into one page", "Leave it"]
              : ["Yes, I'll tell you", "Leave it"],
        } as const)
      : null) ??
    (low
      ? ({
          kind: "low_ctr",
          page: low.page,
          query: cleanQuery(low.query),
          impressions: low.impressions,
          ctr: low.ctr,
          position: low.position,
          chips: ["Rewrite that page's title", "Show all queries", "Not now"],
        } as const)
      : null) ??
    (near
      ? ({
          kind: "striking_distance",
          page: near.page,
          query: cleanQuery(near.query),
          impressions: near.impressions,
          position: near.position,
          chips: ["Add an answer to that page", "Show all queries", "Not now"],
        } as const)
      : null)
  return { suggestion, alerts: found }
}
