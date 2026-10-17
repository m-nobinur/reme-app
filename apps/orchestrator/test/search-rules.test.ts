import { describe, expect, it } from "vitest"
import {
  cleanQuery,
  type RulesInput,
  type SnapshotRow,
  suggest,
  type UrlRow,
} from "../src/search-rules.ts"

const NOW = new Date("2026-10-19T09:00:00Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)
const SITE = "https://sparkle.remeai.co.uk"

const snap = (over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  query: "deep clean manchester",
  page: `${SITE}/deep-clean`,
  clicks: 3,
  impressions: 400,
  ctr: 0.0075,
  position: 6,
  ...over,
})
const url = (over: Partial<UrlRow> = {}): UrlRow => ({
  url: `${SITE}/deep-clean`,
  verdict: "PASS",
  coverage_state: "Submitted and indexed",
  indexing_state: "INDEXING_ALLOWED",
  robots_state: "ALLOWED",
  google_canonical: `${SITE}/deep-clean`,
  last_crawl_time: daysAgo(2),
  inspected_at: daysAgo(1),
  ...over,
})
const week = (clicksPerDay: number, endDaysAgo: number) =>
  Array.from({ length: 7 }, (_, i) => ({
    date: daysAgo(endDaysAgo + i)
      .toISOString()
      .slice(0, 10),
    clicks: clicksPerDay,
    impressions: 100,
    position: 8,
  }))
const base = (over: Partial<RulesInput> = {}): RulesInput => ({
  daily: [],
  snapshot: [],
  urls: [],
  changes: [],
  sitemapErrors: 0,
  lastSuggestionAt: null,
  ...over,
})
const kind = (i: RulesInput) => suggest(i, NOW).suggestion?.kind ?? null

describe("suggestion rules", () => {
  it("low CTR: fires on a high-impression, position 6, 0.75% row; not at 3%, position 2 or 49 impressions", () => {
    expect(kind(base({ snapshot: [snap()] }))).toBe("low_ctr")
    expect(kind(base({ snapshot: [snap({ ctr: 0.03 })] }))).toBeNull()
    expect(kind(base({ snapshot: [snap({ position: 2 })] }))).toBeNull()
    expect(kind(base({ snapshot: [snap({ impressions: 49 })] }))).toBeNull()
  })

  it("striking distance: position 14 with a healthy CTR fires; position 25 does not", () => {
    const row = snap({ position: 14, ctr: 0.05 })
    expect(kind(base({ snapshot: [row] }))).toBe("striking_distance")
    expect(kind(base({ snapshot: [{ ...row, position: 25 }] }))).toBeNull()
  })

  it("unknown to Google: fires for the unknown state; not for an indexed page", () => {
    const u = url({
      verdict: "NEUTRAL",
      coverage_state: "URL is unknown to Google",
    })
    expect(kind(base({ urls: [u] }))).toBe("unknown_to_google")
    expect(kind(base({ urls: [url()] }))).toBeNull()
  })

  it("crawled, not indexed: needs 14+ days since the crawl", () => {
    const stuck = (d: number) =>
      url({
        verdict: "NEUTRAL",
        coverage_state: "Crawled - currently not indexed",
        last_crawl_time: daysAgo(d),
      })
    expect(kind(base({ urls: [stuck(15), stuck(15)] }))).toBe(
      "crawled_not_indexed"
    )
    expect(kind(base({ urls: [stuck(13)] }))).toBeNull()
  })

  it("drop: 42 -> 21 clicks fires; 42 -> 35 and a base under 20 do not", () => {
    const drop = (a: number, b: number) => [...week(a, 0), ...week(b, 7)]
    const s = suggest(
      base({
        daily: drop(3, 6),
        snapshot: [snap(), snap({ page: `${SITE}/` })],
      }),
      NOW
    ).suggestion
    expect(s).toMatchObject({ kind: "drop", previous: 42, current: 21 })
    expect(kind(base({ daily: drop(5, 6) }))).toBeNull()
    expect(kind(base({ daily: drop(0, 2) }))).toBeNull()
  })

  it("result: reports a due change, 'same' included; not before 28 days or twice", () => {
    const change = (d: number, after: number, reported = false) => ({
      url: `${SITE}/deep-clean`,
      changedAt: daysAgo(d),
      query: "deep clean manchester",
      reported,
      before: { clicks: 1, impressions: 300, position: 6 },
      after: { clicks: after, impressions: 400, position: 6 },
    })
    expect(
      suggest(base({ changes: [change(29, 11)] }), NOW).suggestion
    ).toMatchObject({ kind: "result", outcome: "up" })
    expect(
      suggest(base({ changes: [change(30, 1)] }), NOW).suggestion
    ).toMatchObject({ outcome: "same" })
    expect(kind(base({ changes: [change(20, 11)] }))).toBeNull()
    expect(kind(base({ changes: [change(30, 11, true)] }))).toBeNull()
  })

  it("our bug: alerts for noindex, robots, a foreign canonical and sitemap errors; none when clean", () => {
    const r = suggest(
      base({
        sitemapErrors: 2,
        urls: [
          url({ indexing_state: "BLOCKED_BY_META_TAG" }),
          url({ robots_state: "DISALLOWED" }),
          url({ google_canonical: "https://other.example/x" }),
        ],
      }),
      NOW
    )
    expect(
      r.alerts.map((a) => a.kind).sort((a, b) => a.localeCompare(b))
    ).toEqual([
      "canonical_mismatch",
      "noindex",
      "robots_blocked",
      "sitemap_errors",
    ])
    expect(r.suggestion).toBeNull()
    const slash = url({ google_canonical: `${SITE}/deep-clean/` })
    expect(suggest(base({ urls: [slash] }), NOW).alerts).toEqual([])
  })

  it("holds one suggestion a week and none for a page changed in 28 days", () => {
    const i = base({ snapshot: [snap()] })
    expect(kind({ ...i, lastSuggestionAt: daysAgo(6) })).toBeNull()
    expect(kind({ ...i, lastSuggestionAt: daysAgo(8) })).toBe("low_ctr")
    const changed = {
      url: `${SITE}/deep-clean/`,
      changedAt: daysAgo(27),
      reported: true,
    }
    expect(kind({ ...i, changes: [changed] })).toBeNull()
    expect(
      kind({ ...i, changes: [{ ...changed, changedAt: daysAgo(29) }] })
    ).toBe("low_ctr")
  })

  it("alerts still come while the weekly cap holds the suggestion", () => {
    const r = suggest(
      base({ lastSuggestionAt: daysAgo(1), sitemapErrors: 1 }),
      NOW
    )
    expect(r.suggestion).toBeNull()
    expect(r.alerts).toHaveLength(1)
  })

  it("takes one suggestion, the most urgent first", () => {
    const i = base({
      snapshot: [snap()],
      urls: [url({ coverage_state: "URL is unknown to Google" })],
    })
    expect(kind(i)).toBe("unknown_to_google")
  })
})

describe("cleanQuery", () => {
  it("flattens structure and caps the length", () => {
    expect(cleanQuery('a"b\n\n**c** `d` <e> [f]\u0000g')).toBe("ab c d e f g")
    expect(cleanQuery("x".repeat(500)).length).toBe(80)
  })
})
