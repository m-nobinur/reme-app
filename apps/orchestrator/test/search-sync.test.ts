import {
  eq,
  events,
  type OrgScopedDb,
  searchConnections,
  searchDaily,
  searchProperties,
  searchSnapshot,
  searchUrlStatus,
  sql,
} from "@workspace/db"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sealToken } from "../src/google.ts"
import { searchInstanceId } from "../src/search.ts"
import {
  afterPublish,
  disconnectSearch,
  inspectPages,
  isoWeek,
  isWeeklyHour,
  pullProperty,
  startDueSyncs,
  weeklyFor,
} from "../src/search-sync.ts"
import { freshOrg } from "./fixture.ts"
import { kit, storage } from "./site.ts"

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
}))
vi.mock("../src/sandbox.ts", () => ({}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

/**
 * The publish step, the daily pull, the Monday message and the disconnect
 * against a real database, with Google, IndexNow and the live sitemap stood
 * in for. Skipped without DATABASE_URL, like the publish suite.
 */

const url = process.env.DATABASE_URL
/** A file name the router would serve; public once placed. */
const VERIFICATION_FILE = "google1a2b.html"

type Call = { href: string; method: string; body: string }

/** Google and the site, answering as `answers` says; every request recorded. */
function stubFetch(
  answers: {
    refresh?: "ok" | "revoked"
    sitemapPut?: number
    pages?: string[]
  } = {}
) {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input)
      const body = String(init?.body ?? "")
      calls.push({ href, method: init?.method ?? "GET", body })
      if (href.endsWith("/token")) {
        return answers.refresh === "revoked"
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({ access_token: "ya29.a", expires_in: 3600 })
      }
      if (href.endsWith("/revoke")) return new Response(null, { status: 200 })
      if (href.includes("api.indexnow.org")) {
        return new Response(null, { status: 202 })
      }
      if (href.endsWith("/searchAnalytics/query")) {
        const { dimensions } = JSON.parse(body) as { dimensions: string[] }
        return Response.json({
          rows:
            dimensions[0] === "date"
              ? [
                  {
                    keys: ["2026-10-10"],
                    clicks: 3,
                    impressions: 40,
                    ctr: 0.075,
                    position: 6,
                  },
                  {
                    keys: ["2026-10-11"],
                    clicks: 5,
                    impressions: 60,
                    ctr: 0.083,
                    position: 5,
                  },
                ]
              : [
                  {
                    keys: ["end of tenancy clean", "https://h.test/end"],
                    clicks: 1,
                    impressions: 10,
                    ctr: 0.1,
                    position: 9,
                  },
                  {
                    keys: ["deep clean", "https://h.test/deep"],
                    clicks: 2,
                    impressions: 90,
                    ctr: 0.02,
                    position: 7,
                  },
                ],
        })
      }
      if (href.includes("/sitemaps/")) {
        return new Response(null, { status: answers.sitemapPut ?? 200 })
      }
      if (href.endsWith("/sitemaps")) {
        return Response.json({
          sitemap: [
            {
              path: "https://elsewhere.test/sitemap.xml",
              errors: "9",
            },
            {
              path: `${decodeURIComponent(href.split("/sites/")[1]?.split("/")[0] ?? "")}sitemap.xml`,
              lastSubmitted: "2026-10-01T10:00:00Z",
              lastDownloaded: "2026-10-02T10:00:00Z",
              errors: "1",
              warnings: "0",
            },
          ],
        })
      }
      if (href.endsWith("/sitemap.xml")) {
        const host = new URL(href).host
        const locs = (answers.pages ?? ["/", "/services/"])
          .map((p) => `<url><loc>https://${host}${p}</loc></url>`)
          .join("")
        return new Response(
          `<urlset>${locs}<url><loc>https://other.test/x</loc></url></urlset>`
        )
      }
      if (href.includes("urlInspection")) {
        const { inspectionUrl } = JSON.parse(body) as { inspectionUrl: string }
        return Response.json({
          inspectionResult: {
            indexStatusResult: {
              verdict:
                inspectionUrl.endsWith("/") &&
                !inspectionUrl.endsWith("services/")
                  ? "PASS"
                  : "NEUTRAL",
              coverageState: "Submitted and indexed",
              lastCrawlTime: "2026-10-09T08:00:00Z",
            },
          },
        })
      }
      return new Response("not stubbed", { status: 599 })
    })
  )
  return calls
}

function searchEnv() {
  const store = storage()
  const created: unknown[] = []
  const batches: unknown[] = []
  const terminated: string[] = []
  const env = {
    HYPERDRIVE: { connectionString: url },
    SITE_HOST_SUFFIX: "-stg.remeai.co.uk",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_TOKEN_KEY: Buffer.from(
      crypto.getRandomValues(new Uint8Array(32))
    ).toString("base64"),
    INDEXNOW_KEY: "e589181a6d7f0ffecc3cfe5285688213",
    ROUTES: store.ROUTES,
    SITES: store.SITES,
    SEARCHES: {
      create: async (options: unknown) => {
        created.push(options)
      },
      get: async (id: string) => ({
        terminate: async () => {
          terminated.push(id)
        },
      }),
    },
    SEARCH_SYNC: {
      createBatch: async (batch: unknown[]) => {
        batches.push(...batch)
        return []
      },
    },
  } as unknown as Env
  return { env, store, created, batches, terminated }
}

/** An org with a live connection and one verified property on `host`. */
async function connected(env: Env, opts: { synced?: Date } = {}) {
  const orgId = await freshOrg(kit)
  const host = `h-${orgId.slice(0, 8)}.example.test`
  const sealed = await sealToken(env, orgId, `1//refresh-${orgId}`)
  const [property] = await kit.withOrg({ orgId }, async (db) => {
    await db.insert(searchConnections).values({
      orgId,
      refreshToken: sealed,
      state: "active",
      googleEmail: "a@example.test",
    })
    return db
      .insert(searchProperties)
      .values({
        orgId,
        host,
        siteUrl: `https://${host}/`,
        kind: "subdomain",
        method: "file",
        token: VERIFICATION_FILE,
        state: "verified",
        lastSyncedAt: opts.synced ?? null,
      })
      .returning()
  })
  return {
    orgId,
    host,
    siteUrl: `https://${host}/`,
    propertyId: property?.id ?? "",
  }
}

const rows = <T>(orgId: string, read: (db: OrgScopedDb) => Promise<T>) =>
  kit.withOrg({ orgId }, read)

afterEach(() => vi.unstubAllGlobals())

describe.skipIf(!url)("the daily pull", () => {
  it("writes the days, the query and page pairs by impressions, the sitemap and the inspections", async () => {
    const { env } = searchEnv()
    const { orgId, host, siteUrl } = await connected(env)
    stubFetch()
    const now = new Date("2026-10-12T12:00:00Z")
    expect(await pullProperty(env, kit, orgId, siteUrl, now)).toEqual({
      days: 2,
      pairs: 2,
    })
    // A second pull the same day replaces, and adds nothing.
    await pullProperty(env, kit, orgId, siteUrl, now)
    const daily = await rows(orgId, (db) => db.select().from(searchDaily))
    expect(daily.map((d) => [d.date, d.clicks])).toEqual([
      ["2026-10-10", 3],
      ["2026-10-11", 5],
    ])
    const snapshot = await rows(orgId, (db) =>
      db.select().from(searchSnapshot).orderBy(sql`impressions desc`)
    )
    expect(snapshot.map((s) => [s.query, s.windowEnd])).toEqual([
      ["deep clean", "2026-10-12"],
      ["end of tenancy clean", "2026-10-12"],
    ])
    const [property] = await rows(orgId, (db) =>
      db.select().from(searchProperties)
    )
    expect(property?.lastSyncedAt?.toISOString()).toBe(now.toISOString())
    expect(property?.sitemap).toEqual({
      submitted_at: "2026-10-01T10:00:00.000Z",
      last_downloaded: "2026-10-02T10:00:00.000Z",
      errors: 1,
      warnings: 0,
    })

    // Both sitemap pages on this host, never the other host's page.
    expect(await inspectPages(env, kit, orgId, siteUrl, now)).toBe(2)
    const inspected = await rows(orgId, (db) =>
      db.select().from(searchUrlStatus).orderBy(searchUrlStatus.url)
    )
    expect(inspected.map((u) => [u.url, u.verdict])).toEqual([
      [`https://${host}/`, "PASS"],
      [`https://${host}/services/`, "NEUTRAL"],
    ])
    // The next day only the page not PASS is asked about again.
    const calls = stubFetch()
    expect(
      await inspectPages(
        env,
        kit,
        orgId,
        siteUrl,
        new Date("2026-10-13T12:00:00Z")
      )
    ).toBe(1)
    expect(calls.filter((c) => c.href.includes("urlInspection"))).toHaveLength(
      1
    )
  })

  it("marks the connection needs_reauth when Google refuses the refresh token", async () => {
    const { env } = searchEnv()
    const { orgId, siteUrl } = await connected(env)
    stubFetch({ refresh: "revoked" })
    await expect(pullProperty(env, kit, orgId, siteUrl)).rejects.toThrow(
      "search.needs_reauth"
    )
    const [connection] = await rows(orgId, (db) =>
      db.select().from(searchConnections)
    )
    expect(connection?.state).toBe("needs_reauth")
    expect(await rows(orgId, (db) => db.select().from(searchDaily))).toEqual([])
  })

  it("refuses a site_url that is not one of the org's own, before any request", async () => {
    const { env } = searchEnv()
    const mine = await connected(env)
    const theirs = await connected(env)
    const calls = stubFetch()
    await expect(
      pullProperty(env, kit, mine.orgId, theirs.siteUrl)
    ).rejects.toThrow("search.foreign_site")
    await expect(
      inspectPages(env, kit, mine.orgId, "https://example.com/")
    ).rejects.toThrow("search.foreign_site")
    expect(calls).toEqual([])
  })

  it("starts one instance per org due, for the day", async () => {
    const { env, batches } = searchEnv()
    const due = await connected(env)
    const fresh = await connected(env, { synced: new Date() })
    const unconnected = await freshOrg(kit)
    expect(
      await startDueSyncs(
        env,
        kit,
        [due.orgId, fresh.orgId, unconnected],
        "2026-10-12"
      )
    ).toBe(1)
    expect(batches).toEqual([
      {
        id: `search-sync-${due.orgId}-2026-10-12`,
        params: { org_id: due.orgId },
      },
    ])
  })
})

describe.skipIf(!url)("after a publish", () => {
  const manifest = (siteId: string, revisionId: string, home: string) =>
    JSON.stringify({
      revision_id: revisionId,
      site_id: siteId,
      org_id: siteId,
      routes: [
        { path: "/", file: "index.html" },
        { path: "/services/", file: "services/index.html" },
        { path: "/logo.svg", file: "logo.svg" },
      ],
      headers: {},
      files: {
        "index.html": home.repeat(64),
        "services/index.html": "b".repeat(64),
        "logo.svg": "c".repeat(64),
      },
      built_at: "2026-10-12T10:00:00Z",
    })

  it("tells IndexNow the changed pages and survives Google failing", async () => {
    const { env, store } = searchEnv()
    const { orgId, host } = await connected(env)
    const [before, after] = [crypto.randomUUID(), crypto.randomUUID()]
    await store.SITES.put(
      `sites/${orgId}/${before}/manifest.json`,
      manifest(orgId, before, "a")
    )
    await store.SITES.put(
      `sites/${orgId}/${after}/manifest.json`,
      manifest(orgId, after, "d")
    )
    const calls = stubFetch({ sitemapPut: 403 })
    const done = await afterPublish(env, kit, {
      orgId,
      host,
      siteId: orgId,
      revisionId: after,
      previousRevisionId: before,
    })
    expect(done).toEqual({ indexnow: 202, sitemap: false, started: false })
    const ping = calls.find((c) => c.href.includes("indexnow"))
    expect(JSON.parse(ping?.body ?? "{}")).toEqual({
      host,
      key: env.INDEXNOW_KEY,
      keyLocation: `https://${host}/${env.INDEXNOW_KEY}.txt`,
      urlList: [`https://${host}/`],
    })
    expect(
      calls.some((c) => c.method === "PUT" && c.href.includes("/sitemaps/"))
    ).toBe(true)

    stubFetch()
    expect(
      await afterPublish(env, kit, {
        orgId,
        host,
        siteId: orgId,
        revisionId: after,
        previousRevisionId: before,
      })
    ).toMatchObject({ sitemap: true })
  })

  it("starts verification for a live host with no property, and pings even unconnected", async () => {
    const { env, store, created } = searchEnv()
    const { orgId } = await connected(env)
    const revision = crypto.randomUUID()
    await store.SITES.put(
      `sites/${orgId}/${revision}/manifest.json`,
      manifest(orgId, revision, "a")
    )
    stubFetch()
    const p = {
      orgId,
      host: "new.example.test",
      siteId: orgId,
      revisionId: revision,
      previousRevisionId: null,
    }
    expect(await afterPublish(env, kit, p)).toEqual({
      indexnow: 202,
      sitemap: false,
      started: true,
    })
    expect(created).toHaveLength(1)

    const lone = await freshOrg(kit)
    await store.SITES.put(
      `sites/${lone}/${revision}/manifest.json`,
      manifest(lone, revision, "a")
    )
    expect(
      await afterPublish(env, kit, { ...p, orgId: lone, siteId: lone })
    ).toEqual({ indexnow: 202, sitemap: false, started: false })
    // A database that is gone is still not the publish's failure.
    expect(
      await afterPublish(
        env,
        {
          withOrg: async () => {
            throw new Error("down")
          },
        } as never,
        p
      )
    ).toMatchObject({ sitemap: false })
  })
})

describe.skipIf(!url)("the Monday message", () => {
  it("reports the week for a connected org and asks a paused one to sign in", async () => {
    const { env } = searchEnv()
    const { orgId, siteUrl } = await connected(env)
    stubFetch()
    const now = new Date("2026-10-12T07:00:00Z")
    await pullProperty(env, kit, orgId, siteUrl, now)
    const weekly = await weeklyFor(kit, orgId, now)
    expect(weekly?.key).toBe(`search-weekly-${orgId}-2026-W42`)
    expect(weekly?.message.text[0]).toBe(
      "Search this week: 100 appearances, 8 clicks, average position 5."
    )
    // The sitemap error is ours to fix: an alert, not the owner's message.
    const alerts = await rows(orgId, (db) =>
      db
        .select({ payload: events.payload })
        .from(events)
        .where(eq(events.type, "alert.raised"))
    )
    expect(alerts.map((a) => (a.payload as { kind: string }).kind)).toContain(
      "search.sitemap_errors"
    )

    await rows(orgId, (db) =>
      db.update(searchConnections).set({ state: "needs_reauth" })
    )
    expect((await weeklyFor(kit, orgId, now))?.message).toMatchObject({
      button: { label: "Connect Google" },
    })
  })

  it("knows the hour and the week", () => {
    expect(isWeeklyHour("2026101207")).toBe(true)
    expect(isWeeklyHour("2026101208")).toBe(false)
    expect(isWeeklyHour("2026101307")).toBe(false)
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53")
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01")
  })
})

describe.skipIf(!url)("disconnecting", () => {
  it("revokes the grant, drops the files and the rows, and keeps a revoked row", async () => {
    const { env, store, terminated } = searchEnv()
    const { orgId, host, siteUrl } = await connected(env)
    await store.ROUTES.put(`gsv:${host}:${VERIFICATION_FILE}`, "1")
    stubFetch()
    await pullProperty(env, kit, orgId, siteUrl)
    const calls = stubFetch()
    await disconnectSearch(env, kit, orgId)
    await disconnectSearch(env, kit, orgId)
    expect(
      calls
        .filter((c) => c.href.endsWith("/revoke"))
        .map((c) => new URLSearchParams(c.body).get("token"))
    ).toEqual([`1//refresh-${orgId}`])
    expect([...store.pointers.keys()]).toEqual([])
    expect(terminated).toEqual([searchInstanceId(orgId, host)])
    for (const table of [
      searchProperties,
      searchDaily,
      searchSnapshot,
      searchUrlStatus,
    ]) {
      expect(await rows(orgId, (db) => db.select().from(table))).toEqual([])
    }
    const [connection] = await rows(orgId, (db) =>
      db.select().from(searchConnections)
    )
    expect([connection?.state, connection?.refreshToken]).toEqual([
      "revoked",
      null,
    ])
    const audits = await rows(orgId, (db) =>
      db.select().from(events).where(eq(events.type, "search.disconnected"))
    )
    expect(audits).toHaveLength(1)

    await disconnectSearch(env, kit, orgId, true)
    expect(
      await rows(orgId, (db) => db.select().from(searchConnections))
    ).toEqual([])
  })
})
