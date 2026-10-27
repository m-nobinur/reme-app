import {
  searchConnections,
  searchDaily,
  searchProperties,
  searchSnapshot,
  searchUrlStatus,
} from "@workspace/db"
import { describe, expect, it, vi } from "vitest"
import {
  CHECK_IN_DAYS,
  checkInText,
  firstDataText,
  sayPayoff,
} from "../src/search-payoff.ts"
import { chatTexts, openChat } from "./chat.ts"
import { freshOrg } from "./fixture.ts"
import { kit } from "./site.ts"

vi.mock("../src/container.ts", () => ({
  RemeSandbox: class {},
  SandboxEgress: class {},
  SandboxPool: class {},
}))
vi.mock("../src/sandbox.ts", () => ({}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const url = process.env.DATABASE_URL
const DAY = 86_400_000
const VERIFICATION_FILE = "google1a2b.html"

describe("the payoff wording", () => {
  it("names the top query, or the site when Google named none", () => {
    expect(
      firstDataText({
        impressions: 34,
        clicks: 3,
        query: 'dog groomer "chapel allerton"',
      })
    ).toContain(
      '34 people saw you for "dog groomer chapel allerton", 3 clicked.'
    )
    expect(firstDataText({ impressions: 1, clicks: 0 })).toContain(
      "1 person saw your site on Google, none clicked yet."
    )
  })

  it("says how long it has been and what Google has indexed", () => {
    const text = checkInText({ host: "x.test", days: 11, pages: 5, indexed: 2 })
    expect(text).toContain("11 days since x.test went on Google")
    expect(text).toContain("indexed 2 of the 5 pages")
    expect(
      checkInText({ host: "x.test", days: 10, pages: 0, indexed: 0 })
    ).not.toContain("indexed")
  })
})

describe.skipIf(!url)("the payoff messages", () => {
  /** An org with a chat and a property verified `verifiedDaysAgo` days ago. */
  async function verified(verifiedDaysAgo: number) {
    const orgId = await freshOrg(kit)
    await openChat(kit, orgId)
    const now = new Date()
    const [property] = await kit.withOrg({ orgId }, async (db) => {
      await db.insert(searchConnections).values({
        orgId,
        refreshToken: "v1.a.b",
        state: "active",
        googleEmail: "a@example.test",
      })
      return db
        .insert(searchProperties)
        .values({
          orgId,
          host: "x.example.test",
          siteUrl: "https://x.example.test/",
          kind: "subdomain",
          method: "file",
          token: VERIFICATION_FILE,
          state: "verified",
          verifiedAt: new Date(now.getTime() - verifiedDaysAgo * DAY),
        })
        .returning({ id: searchProperties.id })
    })
    return { orgId, now, propertyId: property?.id ?? "" }
  }

  it("says the first numbers once, from the top query", async () => {
    const { orgId, propertyId } = await verified(3)
    await kit.withOrg({ orgId }, async (db) => {
      const ids = { orgId, propertyId }
      await db.insert(searchDaily).values({
        ...ids,
        date: "2026-10-20",
        clicks: 3,
        impressions: 40,
        ctr: 0.075,
        position: 6,
      })
      await db.insert(searchSnapshot).values(
        [
          ["dog groomer chapel allerton", "/", 3, 34],
          ["dog wash", "/", 0, 6],
        ].map(([query, page, clicks, impressions]) => ({
          ...ids,
          query: String(query),
          page: String(page),
          clicks: Number(clicks),
          impressions: Number(impressions),
          ctr: 0,
          position: 5,
          windowEnd: "2026-10-26",
        }))
      )
    })
    expect(await sayPayoff(kit, orgId)).toBe("first_data")
    expect(await sayPayoff(kit, orgId)).toBe("first_data")
    expect(await chatTexts(kit, orgId)).toEqual([
      expect.stringContaining(
        '34 people saw you for "dog groomer chapel allerton", 3 clicked.'
      ),
    ])
  })

  it("checks in once on day 10 for a site with no numbers, and not before", async () => {
    const early = await verified(CHECK_IN_DAYS - 1)
    expect(await sayPayoff(kit, early.orgId, early.now)).toBeNull()
    expect(await chatTexts(kit, early.orgId)).toEqual([])

    const { orgId, propertyId, now } = await verified(CHECK_IN_DAYS + 1)
    await kit.withOrg({ orgId }, (db) =>
      db.insert(searchUrlStatus).values({
        orgId,
        propertyId,
        url: "https://x.example.test/",
        verdict: "PASS",
        inspectedAt: now,
      })
    )
    expect(await sayPayoff(kit, orgId, now)).toBe("check_in")
    expect(await sayPayoff(kit, orgId, now)).toBe("check_in")
    expect(await chatTexts(kit, orgId)).toEqual([
      expect.stringContaining("11 days since x.example.test went on Google"),
    ])
  })
})
