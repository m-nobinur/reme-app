import {
  ErrorEnvelope,
  GetIndexingOutput,
  GetSearchPerformanceOutput,
} from "@workspace/contracts"
import {
  memberships,
  searchConnections,
  searchDaily,
  searchProperties,
  searchSnapshot,
  searchUrlStatus,
  sql,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getIndexing, getSearchPerformance } from "../src/cos/search-tools.ts"
import type { ToolContext } from "../src/cos/tools.ts"
import {
  type Owner,
  owner,
  type Stub,
  SUFFIX,
  stubOrchestrator,
} from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

/**
 * The two Search Console tools and `POST /google/disconnect`, on a live
 * connection with the orchestrator stood in for: the stored 7 and 28 day
 * answers, the live ones over the bridge, an org that never sees another's
 * rows, a foreign address refused before the orchestrator is asked, and the
 * owner-only disconnect.
 */

const url = process.env.DATABASE_URL
const HOST = "sparkle.example"
const day = (ago: number) =>
  new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10)

describe.skipIf(!url)("the Search Console tools, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch
  let me: Owner
  let other: Owner
  let none: Owner

  /** A connected org with one verified property and 56 days of numbers. */
  async function connect(
    who: Owner,
    {
      host,
      query,
      synced = new Date(),
      state = "active",
    }: {
      host: string
      query: string
      synced?: Date
      state?: "active" | "needs_reauth"
    }
  ) {
    await kit.withOrg({ orgId: who.orgId }, async (db) => {
      await db.insert(searchConnections).values({
        orgId: who.orgId,
        googleEmail: "owner@gmail.invalid",
        refreshToken: "v1.aXY.Y3Q",
        state,
        connectedAt: new Date(),
      })
      const [property] = await db
        .insert(searchProperties)
        .values({
          orgId: who.orgId,
          host,
          siteUrl: `https://${host}/`,
          kind: "subdomain",
          method: "file",
          state: "verified",
          lastSyncedAt: synced,
          sitemap: {
            submitted_at: new Date().toISOString(),
            last_downloaded: null,
            errors: 0,
            warnings: 1,
          },
        })
        .returning({ id: searchProperties.id })
      const propertyId = (property as { id: string }).id
      // The last 28 days: 10 impressions and 1 click a day; the 28 before: 5 and 0.
      await db.insert(searchDaily).values(
        Array.from({ length: 56 }, (_, i) => ({
          orgId: who.orgId,
          propertyId,
          date: day(i + 1),
          clicks: i < 28 ? 1 : 0,
          impressions: i < 28 ? 10 : 5,
          ctr: i < 28 ? 0.1 : 0,
          position: i < 28 ? 4 : 8,
        }))
      )
      await db.insert(searchSnapshot).values([
        {
          orgId: who.orgId,
          propertyId,
          query,
          page: `https://${host}/`,
          clicks: 20,
          impressions: 100,
          ctr: 0.2,
          position: 3,
          windowEnd: day(1),
        },
        {
          orgId: who.orgId,
          propertyId,
          query: `${query} two`,
          page: `https://${host}/areas`,
          clicks: 2,
          impressions: 300,
          ctr: 0.007,
          position: 9,
          windowEnd: day(1),
        },
      ])
      const seen = (page: string, verdict: string, coverage: string) => ({
        orgId: who.orgId,
        propertyId,
        url: `https://${host}/${page}`,
        verdict,
        coverageState: coverage,
        inspectedAt: new Date(),
      })
      await db
        .insert(searchUrlStatus)
        .values([
          seen("", "PASS", "Submitted and indexed"),
          seen("areas", "NEUTRAL", "Crawled - currently not indexed"),
        ])
    })
  }

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    ;[me, other, none] = await Promise.all([
      owner(kit, url as string, "search-me"),
      owner(kit, url as string, "search-other"),
      owner(kit, url as string, "search-none"),
    ])
    await connect(me, { host: HOST, query: "cleaners near me" })
    await connect(other, { host: "rival.example", query: "rival secret" })
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  const context = (
    who: Owner,
    stub: Stub = stubOrchestrator()
  ): ToolContext => ({
    env: {
      ...env(url as string),
      ORCHESTRATOR: stub,
      SITE_HOST_SUFFIX: SUFFIX,
    } as unknown as Env,
    kit,
    owner: {
      orgId: who.orgId,
      session: {
        workosUserId: who.workosUserId,
        sessionId: "session_probe",
        impersonated: false,
        email: "owner@search-probe.invalid",
        name: "Probe Owner",
      },
    },
  })

  describe("get_search_performance", () => {
    it("reads 28 days from Postgres with the change on the 28 before and the as_of date", async () => {
      const stub = stubOrchestrator()
      const out = await getSearchPerformance(context(me, stub), {
        days: 28,
        by: "query",
      })
      expect(GetSearchPerformanceOutput.parse(out)).toEqual(out)
      expect(out).toMatchObject({
        totals: { clicks: 28, impressions: 280, ctr: 0.1, position: 4 },
        delta: { clicks: 28, impressions: 140, position: -4 },
        as_of: day(1),
        stale: false,
      })
      // Most clicks first, and only this org's queries.
      expect(
        (out as { rows: { key: string }[] }).rows.map((r) => r.key)
      ).toEqual(["cleaners near me", "cleaners near me two"])
      expect(JSON.stringify(out)).not.toContain("rival")
      expect(stub.calls).toEqual([])
    })

    it("reads 7 days without a break-down from Postgres too", async () => {
      const stub = stubOrchestrator()
      const out = await getSearchPerformance(context(me, stub), {
        days: 7,
        by: "none",
      })
      expect(out).toMatchObject({
        totals: { clicks: 7, impressions: 70 },
        rows: [],
      })
      expect(stub.calls).toEqual([])
    })

    it("asks Google through the orchestrator for 90 days and for a 7-day break-down", async () => {
      const live = {
        totals: { clicks: 9, impressions: 90, ctr: 0.1, position: 5 },
        delta: null,
        rows: [{ key: "q", clicks: 9, impressions: 90, ctr: 0.1, position: 5 }],
        as_of: day(2),
        stale: false,
      }
      const stub = stubOrchestrator(() => Response.json(live))
      const ninety = await getSearchPerformance(context(me, stub), {
        days: 90,
        by: "page",
      })
      const week = await getSearchPerformance(context(me, stub), {
        days: 7,
        by: "query",
      })
      expect(ninety).toEqual(live)
      expect(week).toEqual(live)
      expect(
        stub.calls.map((c) => [
          c.request.method,
          new URL(c.request.url).pathname + new URL(c.request.url).search,
        ])
      ).toEqual([
        ["GET", "/assignments/search/performance?days=90&by=page"],
        ["GET", "/assignments/search/performance?days=7&by=query"],
      ])
    })

    it("says stale after 48 hours without a sync and when Google needs the owner again", async () => {
      const lapsed = await owner(kit, url as string, "search-lapsed")
      await connect(lapsed, {
        host: "lapsed.example",
        query: "x",
        synced: new Date(Date.now() - 3 * 86_400_000),
      })
      const reauth = await owner(kit, url as string, "search-reauth")
      await connect(reauth, {
        host: "reauth.example",
        query: "y",
        state: "needs_reauth",
      })
      for (const who of [lapsed, reauth]) {
        const out = await getSearchPerformance(context(who), {
          days: 28,
          by: "none",
        })
        expect(out).toMatchObject({ stale: true })
      }
    })

    it("answers connected:false for an org that never connected, and a refusal for one with no numbers yet", async () => {
      expect(
        await getSearchPerformance(context(none), { days: 28, by: "none" })
      ).toEqual({ connected: false })
      const fresh = await owner(kit, url as string, "search-fresh")
      await kit.withOrg({ orgId: fresh.orgId }, (db) =>
        db.insert(searchConnections).values({
          orgId: fresh.orgId,
          refreshToken: "v1.aXY.Y3Q",
          state: "active",
        })
      )
      expect(
        await getSearchPerformance(context(fresh), { days: 28, by: "none" })
      ).toMatchObject({
        outcome: "refused",
        error: { code: "search.no_data_yet" },
      })
    })
  })

  describe("get_indexing", () => {
    it("reads the property, its sitemap and the stored verdicts, the unindexed first", async () => {
      const stub = stubOrchestrator()
      const out = await getIndexing(context(me, stub), {})
      expect(GetIndexingOutput.parse(out)).toEqual(out)
      expect(out).toMatchObject({
        property: "verified",
        sitemap: { errors: 0, warnings: 1 },
      })
      const pages = (out as { pages: { url: string; verdict: string }[] }).pages
      expect(pages.map((p) => [p.url, p.verdict])).toEqual([
        [`https://${HOST}/areas`, "NEUTRAL"],
        [`https://${HOST}/`, "PASS"],
      ])
      expect(JSON.stringify(out)).not.toContain("rival")
      expect(stub.calls).toEqual([])
    })

    it("inspects one page of the org's own website live", async () => {
      const status = {
        url: `https://${HOST}/areas`,
        verdict: "NEUTRAL",
        coverage_state: "Crawled - currently not indexed",
        indexing_state: null,
        robots_state: null,
        google_canonical: null,
        last_crawl_time: null,
        inspected_at: new Date().toISOString(),
      }
      const stub = stubOrchestrator(() => Response.json(status))
      const out = await getIndexing(context(me, stub), {
        url: `https://${HOST}/areas`,
      })
      expect(out).toMatchObject({ property: "verified", pages: [status] })
      expect(stub.calls.map((c) => c.request.url)).toEqual([
        `https://orchestrator/assignments/search/inspect?url=${encodeURIComponent(`https://${HOST}/areas`)}`,
      ])
    })

    it("refuses an address on another host before the orchestrator is asked", async () => {
      const stub = stubOrchestrator()
      for (const address of [
        "https://rival.example/",
        `https://${HOST}.evil.example/`,
        `https://evil.example/${HOST}`,
        "https://not a url",
      ]) {
        expect(
          await getIndexing(context(me, stub), { url: address })
        ).toMatchObject({
          outcome: "refused",
          error: { code: "search.url_foreign" },
        })
      }
      expect(stub.calls).toEqual([])
    })

    it("answers connected:false when never connected", async () => {
      expect(await getIndexing(context(none), {})).toEqual({ connected: false })
    })
  })

  describe("POST /google/disconnect", () => {
    const disconnect = (who: Owner, stub: Stub) =>
      who.call(stub, "/google/disconnect", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      })

    it("bridges to the orchestrator for the owner and relays its 204", async () => {
      const stub = stubOrchestrator(() => new Response(null, { status: 204 }))
      const answered = await disconnect(me, stub)
      expect(answered.status).toBe(204)
      expect(stub.calls.map((c) => [c.request.method, c.request.url])).toEqual([
        ["POST", "https://orchestrator/assignments/search/disconnect"],
      ])
    })

    it("refuses a member who is not the owner without bridging", async () => {
      const member = await owner(kit, url as string, "search-member")
      await kit.withOrg({ orgId: member.orgId }, (db) =>
        db
          .update(memberships)
          .set({ role: "member" })
          .where(sql`${memberships.orgId} = ${member.orgId}`)
      )
      const stub = stubOrchestrator()
      const answered = await disconnect(member, stub)
      expect(answered.status).toBe(403)
      expect(ErrorEnvelope.parse(await answered.json()).code).toBe(
        "google.not_owner"
      )
      expect(stub.calls).toEqual([])
    })
  })
})
