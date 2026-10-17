import { eq, searchConnections, searchProperties } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { freshOrg, kit } from "./fixture.ts"

const google = vi.hoisted(() => ({
  accessFor: vi.fn(),
  searchAnalytics: vi.fn(),
  inspectUrl: vi.fn(),
}))
vi.mock("../src/google.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/google.ts")>()),
  ...google,
}))

const { GoogleError, NeedsReauth } = await import("../src/google.ts")
const { liveInspect, livePerformance } = await import("../src/search-read.ts")

/**
 * The two live reads: Google is only ever asked about a property the org
 * holds, a page address must sit on one of those hosts, and a grant Google
 * ended reads as needing the owner again. Google itself is stood in for.
 */

const url = process.env.DATABASE_URL
const env = {} as Env

async function connected(
  host: string,
  {
    state = "active",
    property = "verified",
  }: {
    state?: "active" | "needs_reauth" | "revoked"
    property?: "verified" | "pending" | null
  } = {}
) {
  const orgId = await freshOrg(kit)
  await kit.withOrg({ orgId }, async (db) => {
    await db.insert(searchConnections).values({
      orgId,
      state,
      refreshToken: state === "revoked" ? null : "v1.aXY.Y3Q",
    })
    if (property) {
      await db.insert(searchProperties).values({
        orgId,
        host,
        siteUrl: `https://${host}/`,
        kind: "subdomain",
        method: "file",
        state: property,
      })
    }
  })
  return orgId
}

beforeEach(() => {
  vi.resetAllMocks()
  google.accessFor.mockResolvedValue({ accessToken: "access" })
})

describe.skipIf(!url)("live Search Console reads", () => {
  it("answers 90 days from the org's own property, with the change on the 90 before", async () => {
    const orgId = await connected("sparkle.example")
    await connected("rival.example")
    google.searchAnalytics.mockImplementation(
      async (
        _t: string,
        _site: string,
        q: { startDate: string; dimensions?: string[] }
      ) => {
        if (q.dimensions) {
          return {
            rows: [
              {
                keys: ["cheap"],
                clicks: 1,
                impressions: 50,
                ctr: 0.02,
                position: 9,
              },
              {
                keys: ["cleaners near me"],
                clicks: 8,
                impressions: 80,
                ctr: 0.1,
                position: 3,
              },
              { clicks: 99, impressions: 99, ctr: 1, position: 1 },
            ],
          }
        }
        const recent =
          q.startDate >
          new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10)
        return {
          rows: [
            recent
              ? { clicks: 9, impressions: 130, ctr: 0.07, position: 5 }
              : { clicks: 4, impressions: 100, ctr: 0.04, position: 6 },
          ],
        }
      }
    )
    const out = await livePerformance(env, kit, orgId, {
      days: 90,
      by: "query",
    })
    expect(out).toMatchObject({
      totals: { clicks: 9, impressions: 130, position: 5 },
      delta: { clicks: 5, impressions: 30, position: -1 },
      rows: [
        { key: "cleaners near me", clicks: 8 },
        { key: "cheap", clicks: 1 },
      ],
      stale: false,
    })
    expect(google.searchAnalytics.mock.calls.map((c) => c[1])).toEqual([
      "https://sparkle.example/",
      "https://sparkle.example/",
      "https://sparkle.example/",
    ])
  })

  it("answers connected:false for an org with no grant, and asks Google nothing", async () => {
    const orgId = await freshOrg(kit)
    expect(
      await livePerformance(env, kit, orgId, { days: 90, by: "none" })
    ).toEqual({ connected: false })
    const revoked = await connected("gone.example", { state: "revoked" })
    expect(
      await liveInspect(env, kit, revoked, "https://gone.example/")
    ).toEqual({ connected: false })
    expect(google.accessFor).not.toHaveBeenCalled()
  })

  it("refuses when the grant needs the owner again, or Google says so now", async () => {
    const stale = await connected("stale.example", { state: "needs_reauth" })
    expect(
      await livePerformance(env, kit, stale, { days: 90, by: "none" })
    ).toMatchObject({
      refused: true,
      code: "search.needs_reauth",
    })
    const revoked = await connected("lost.example")
    google.accessFor.mockRejectedValue(new NeedsReauth())
    expect(
      await livePerformance(env, kit, revoked, { days: 90, by: "none" })
    ).toMatchObject({
      refused: true,
      code: "search.needs_reauth",
    })
    const [row] = await kit.withOrg({ orgId: revoked }, (db) =>
      db
        .select({ state: searchConnections.state })
        .from(searchConnections)
        .where(eq(searchConnections.orgId, revoked))
    )
    expect(row?.state).toBe("needs_reauth")
    expect(google.searchAnalytics).not.toHaveBeenCalled()
  })

  it("refuses a page that is not on one of the org's hosts before it asks Google", async () => {
    const orgId = await connected("sparkle.example")
    await connected("rival.example")
    for (const address of [
      "https://rival.example/",
      "https://sparkle.example.evil.example/",
      "https://evil.example/sparkle.example",
      "https://user@sparkle.example/",
      "http://sparkle.example/",
      "not a url",
      "",
    ]) {
      expect(await liveInspect(env, kit, orgId, address)).toMatchObject({
        refused: true,
        code: "search.url_foreign",
      })
    }
    expect(google.inspectUrl).not.toHaveBeenCalled()
  })

  it("refuses until the property is verified", async () => {
    const orgId = await connected("new.example", { property: "pending" })
    expect(
      await liveInspect(env, kit, orgId, "https://new.example/")
    ).toMatchObject({
      refused: true,
      code: "search.no_property",
    })
    expect(google.inspectUrl).not.toHaveBeenCalled()
  })

  it("inspects a page of the org's own property and reads Google's verdict", async () => {
    const orgId = await connected("sparkle.example")
    google.inspectUrl.mockResolvedValue({
      verdict: "NEUTRAL",
      coverageState: "Crawled - currently not indexed",
      googleCanonical: "https://sparkle.example/areas",
      lastCrawlTime: "2026-10-10T08:00:00Z",
    })
    const out = await liveInspect(
      env,
      kit,
      orgId,
      "https://sparkle.example/areas"
    )
    expect(out).toMatchObject({
      url: "https://sparkle.example/areas",
      verdict: "NEUTRAL",
      coverage_state: "Crawled - currently not indexed",
      last_crawl_time: "2026-10-10T08:00:00.000Z",
    })
    expect(google.inspectUrl).toHaveBeenCalledExactlyOnceWith(
      "access",
      "https://sparkle.example/",
      "https://sparkle.example/areas"
    )
  })

  it("leaves out a property Google refuses, and is transient only when all are", async () => {
    const orgId = await connected("sparkle.example")
    await kit.withOrg({ orgId }, (db) =>
      db.insert(searchProperties).values({
        orgId,
        host: "lost.example",
        siteUrl: "https://lost.example/",
        kind: "url_prefix",
        method: "file",
        state: "verified",
      })
    )
    google.searchAnalytics.mockImplementation(
      async (_t: string, site: string) => {
        if (site === "https://lost.example/") {
          throw new GoogleError("google.403", 403)
        }
        return { rows: [{ clicks: 2, impressions: 20, ctr: 0.1, position: 4 }] }
      }
    )
    expect(
      await livePerformance(env, kit, orgId, { days: 7, by: "none" })
    ).toMatchObject({ totals: { clicks: 2, impressions: 20 } })

    google.searchAnalytics.mockRejectedValue(new GoogleError("google.403", 403))
    expect(
      await livePerformance(env, kit, orgId, { days: 7, by: "none" })
    ).toMatchObject({ refused: true, status: 503, code: "google.403" })
  })

  it("reads a Google outage as transient, without what Google said", async () => {
    const orgId = await connected("sparkle.example")
    google.inspectUrl.mockRejectedValue(new Error("secret body"))
    const out = await liveInspect(env, kit, orgId, "https://sparkle.example/")
    expect(out).toMatchObject({
      refused: true,
      status: 503,
      class: "transient",
    })
    expect(JSON.stringify(out)).not.toContain("secret")
  })
})
