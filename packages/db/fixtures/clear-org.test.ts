import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { clearOrg } from "../scripts/clear-probes.ts"
import { connect } from "../src/client.ts"
import { assignments, memberships, orgs, staff, users } from "../src/schema.ts"
import { pgCode } from "../src/tenancy.ts"
import { clearOrgs } from "./seed.ts"

/**
 * `clearOrg` against a real database and a stand-in for the Cloudflare API.
 * Run by `pnpm test:seed`. Every org here is made with fresh ids, so the golden
 * seed running beside it in `seed.test.ts` never meets these rows.
 */

const ENV = { kv: "kv-ns", bucket: "sites-bucket", hostSuffix: "-stg.test" }
const { sql: client, db } = connect()

beforeAll(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct"
  process.env.CLOUDFLARE_API_TOKEN = "token"
})

/** Every org made here, cleared at the end whatever a case left. */
const cleanup: string[] = []

afterAll(async () => {
  await db.transaction((tx) => clearOrgs(tx, cleanup, []))
  await client.end()
})

type Call = { method: string; url: string }

/** KV and R2 in memory, answering the four calls `clearOrg` makes. */
function cloud(
  kv: Set<string>,
  r2: Set<string>,
  fail: { kv?: boolean; r2?: boolean } = {}
) {
  const calls: Call[] = []
  const answer = (body: unknown) =>
    Response.json({ success: true, errors: [], ...(body as object) })
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const url = new URL(input)
    calls.push({ method, url: url.pathname })
    if (url.pathname.endsWith("/bulk/delete")) {
      const keys = JSON.parse(String(init.body)) as string[]
      if (fail.kv) {
        return answer({
          result: { successful_key_count: 0, unsuccessful_keys: keys },
        })
      }
      for (const key of keys) kv.delete(key)
      return answer({
        result: { successful_key_count: keys.length, unsuccessful_keys: [] },
      })
    }
    if (method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const keys = [...r2].filter((k) => k.startsWith(prefix))
      return answer({
        result: keys.map((key) => ({ key })),
        result_info: { is_truncated: false },
      })
    }
    // Delete by list. On failure it answers 200 and deletes nothing, which
    // is how a per-key error arrives.
    const keys = JSON.parse(String(init.body)) as string[]
    if (!fail.r2) for (const key of keys) r2.delete(key)
    return answer({ result: keys.map((key) => ({ key })) })
  }) as unknown as typeof fetch
  const deletes = () => calls.filter((c) => c.method !== "GET")
  return { fetcher, calls, deletes }
}

/** An org with one owner and one assignment in `state`. */
async function makeOrg(state: string, owner?: string) {
  const org = randomUUID()
  cleanup.push(org)
  const person = owner ?? randomUUID()
  const who = randomUUID()
  await db.insert(orgs).values({
    id: org,
    slug: `clear-${org.slice(0, 8)}`,
    name: "QA probe cleaning clear-org test",
  })
  if (!owner) {
    await db.insert(users).values({
      id: person,
      workosUserId: `user_${person}`,
      email: `qa-e2e-${person}@example.net`,
      name: "Probe Runner",
    })
  }
  await db.insert(memberships).values({
    id: randomUUID(),
    orgId: org,
    userId: person,
    workosMembershipId: `om_${randomUUID()}`,
    role: "owner",
    status: "active",
  })
  await db.insert(staff).values({
    id: who,
    orgId: org,
    staffCode: "OWN-001",
    displayName: "Probe Owner",
    kind: "human",
    userId: person,
    status: "active",
  })
  await assign(org, who, state)
  return { id: org, org, slug: `clear-${org.slice(0, 8)}`, person, staff: who }
}

function assign(org: string, who: string, state: string, on = db) {
  return on.insert(assignments).values({
    id: randomUUID(),
    orgId: org,
    staffId: who,
    createdByStaffId: who,
    kind: "site.build",
    state: state as "queued",
    goal: "Probe",
    acceptanceCriteria: ["probe"],
    factSnapshotId: randomUUID(),
    budgetUsd: 1,
    idempotencyKey: randomUUID(),
  })
}

const orgRows = async (id: string) =>
  (await db.select().from(orgs).where(eq(orgs.id, id))).length

const siteFiles = (org: string) =>
  new Set([
    `sites/${org}/rev/dist/index.html`,
    `sites/${org}/rev/manifest.json`,
  ])

describe("clearOrg", () => {
  it("clears a finished org in every layer", async () => {
    const made = await makeOrg("published")
    const kv = new Set([`host:${made.slug}${ENV.hostSuffix}`])
    const r2 = siteFiles(made.org)
    const { fetcher } = cloud(kv, r2)
    const { workosUserIds } = await clearOrg(db, made, ENV, fetcher)
    expect(workosUserIds).toEqual([`user_${made.person}`])
    expect([kv.size, r2.size, await orgRows(made.org)]).toEqual([0, 0, 0])
  })

  it("holds the org row, so a new assignment waits and then fails", async () => {
    const made = await makeOrg("cancelled")
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => undefined
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { fetcher: store } = cloud(new Set(), siteFiles(made.org))
    // Pauses at the first Cloudflare call, which comes after the lock.
    const fetcher = (async (input: string, init?: RequestInit) => {
      entered()
      await gate
      return store(input, init)
    }) as unknown as typeof fetch

    const clearing = clearOrg(db, made, ENV, fetcher)
    await inside
    const other = connect()
    const watcher = connect()
    try {
      let settled = false
      const inserting = assign(made.org, made.staff, "queued", other.db).then(
        () => "inserted",
        (error: unknown) => pgCode(error)
      )
      void inserting.then(() => {
        settled = true
      })
      for (;;) {
        if (settled) throw new Error("the insert did not wait for the lock")
        const [row] = await watcher.sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock'
            and query like 'insert into "assignments"%'`
        if (row?.n) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      release()
      await clearing
      expect(await inserting).toBe("23503")
      expect(await orgRows(made.org)).toBe(0)
    } finally {
      release()
      await other.sql.end()
      await watcher.sql.end()
    }
  })

  it("deletes nothing when an assignment is unfinished", async () => {
    const made = await makeOrg("implementing")
    const kv = new Set([`host:${made.slug}${ENV.hostSuffix}`])
    const r2 = siteFiles(made.org)
    const stand = cloud(kv, r2)
    await expect(clearOrg(db, made, ENV, stand.fetcher)).rejects.toThrow(
      /unfinished/
    )
    expect(stand.deletes()).toEqual([])
    expect([kv.size, r2.size, await orgRows(made.org)]).toEqual([1, 2, 1])
  })

  it("rolls back when KV keeps a key", async () => {
    const made = await makeOrg("failed")
    const stand = cloud(new Set(), siteFiles(made.org), { kv: true })
    await expect(clearOrg(db, made, ENV, stand.fetcher)).rejects.toThrow(
      /KV kept/
    )
    expect(await orgRows(made.org)).toBe(1)
  })

  it("rolls back when R2 answers 200 and keeps the files", async () => {
    const made = await makeOrg("failed")
    const r2 = siteFiles(made.org)
    const stand = cloud(new Set(), r2, { r2: true })
    await expect(clearOrg(db, made, ENV, stand.fetcher)).rejects.toThrow(
      /R2 kept/
    )
    expect([r2.size, await orgRows(made.org)]).toEqual([2, 1])
  })

  it("deletes a person in two probes with the second", async () => {
    const first = await makeOrg("published")
    const second = await makeOrg("published", first.person)
    const { fetcher } = cloud(new Set(), new Set())
    expect((await clearOrg(db, first, ENV, fetcher)).workosUserIds).toEqual([])
    expect((await clearOrg(db, second, ENV, fetcher)).workosUserIds).toEqual([
      `user_${first.person}`,
    ])
    const [left] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from users where id = ${first.person}`
    )
    expect(left?.n).toBe(0)
  })
})
