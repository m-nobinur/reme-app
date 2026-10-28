import { eq, sql } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import { domains, orgs, searchConnections } from "../src/schema.ts"
import { openTask, readTasks, setStep, syncTasks } from "../src/tasks.ts"
import { withOrg } from "../src/tenancy.ts"

/** The task store against Postgres: the mapping from domain and Google rows, run twice. */
const ORG = crypto.randomUUID()
const NAME = `tasks-probe-${ORG.slice(0, 8)}.example.com`
const MOVED = crypto.randomUUID()

const run = <T>(fn: Parameters<typeof withOrg<T>>[1]) =>
  withOrg({ orgId: ORG }, fn)
const sync = () => run((db) => syncTasks(db, ORG))
const tasks = () => run((db) => readTasks(db))
const states = (task: { steps: { step: string; state: string }[] }) =>
  Object.fromEntries(task.steps.map((s) => [s.step, s.state]))

afterAll(async () => {
  const { sql: client, db } = connect()
  try {
    await db.transaction((tx) => clearOrgs(tx, [ORG, MOVED], []))
  } finally {
    await client.end()
  }
})

describe("owner tasks", () => {
  it("follows a connect from waiting on DNS to live, the same on a second run", async () => {
    await run(async (db) => {
      await db.insert(orgs).values({
        id: ORG,
        slug: `tasks-probe-${ORG.slice(0, 8)}`,
        name: "Tasks probe (fixture)",
      })
      await db.insert(domains).values({
        orgId: ORG,
        siteId: ORG,
        name: NAME,
        primaryHost: NAME,
        origin: "connected",
        method: "records",
        state: "awaiting_dns",
        provider: { name: "Cloudflare" },
      })
    })
    await sync()
    const [first] = await tasks()
    await sync()
    const again = await tasks()
    expect(again).toEqual([first])
    expect(first).toMatchObject({
      kind: "address",
      state: "active",
      detail: { name: NAME, origin: "owned", provider: "Cloudflare" },
    })
    expect(states(first as NonNullable<typeof first>)).toEqual({
      find_out: "done",
      choose: "skipped",
      purchase: "skipped",
      records: "blocked",
      ownership: "skipped",
      certificate: "pending",
      loads: "pending",
    })
    const records = first?.steps.find((s) => s.step === "records")
    expect(records).toMatchObject({ blocked_on: "owner_action" })
    expect(records?.deadline).not.toBeNull()
    // The connect's count of changes stays through a sync that has none.
    await run((db) => syncTasks(db, ORG, { changes: 2 }))
    await sync()
    expect((await tasks())[0]?.detail).toMatchObject({ changes: 2 })

    // What the probe writes survives a sync: its hash, and a wait it noted.
    const hash = "a".repeat(64)
    await run((db) =>
      setStep(db, first?.id as string, "records", {
        state: "blocked",
        blocked_on: "owner_action",
        note: "One record still missing",
        probe_hash: hash,
        evidence: { seen: 1 },
      })
    )
    await sync()
    const probed = await run((db) =>
      db.execute<{ note: string; probe_hash: string }>(
        sql`select note, probe_hash from task_steps where step = 'records'`
      )
    )
    expect(probed[0]).toEqual({
      note: "One record still missing",
      probe_hash: hash,
    })

    await run((db) =>
      db
        .update(domains)
        .set({ state: "active", activatedAt: new Date() })
        .where(eq(domains.name, NAME))
    )
    await sync()
    const [active] = await tasks()
    // Live on the row, but only the probe's load check finishes the task.
    expect(active).toMatchObject({ id: first?.id, state: "active" })
    expect(states(active as NonNullable<typeof active>)).toMatchObject({
      records: "done",
      loads: "in_progress",
    })
    expect(active?.steps.find((s) => s.step === "records")).toMatchObject({
      blocked_on: null,
      deadline: null,
    })
    await run((db) =>
      setStep(db, first?.id as string, "loads", {
        state: "done",
        evidence: { status: 200 },
      })
    )
    await sync()
    const [live] = await tasks()
    expect(live).toMatchObject({ id: first?.id, state: "done" })
    expect(live?.done_at).not.toBeNull()
    // A second sync neither moves the done step back nor the finish time.
    await sync()
    expect(await tasks()).toEqual([live])
  })

  it("adds the Google task beside it, and opening it again keeps one", async () => {
    await run((db) =>
      db.insert(searchConnections).values({
        orgId: ORG,
        refreshToken: "v1.iv.ct",
        state: "needs_permission",
        connectedAt: new Date(),
      })
    )
    await sync()
    const google = (await tasks()).find((t) => t.kind === "google")
    expect(google?.state).toBe("active")
    expect(google?.steps.find((s) => s.step === "permissions")).toMatchObject({
      state: "blocked",
      blocked_on: "permission",
    })
    const id = await run((db) => openTask(db, ORG, "google"))
    expect(id).toBe(google?.id)
    await run((db) =>
      setStep(db, id, "permissions", { state: "blocked", note: "One box" })
    )
    // The mapping leaves a note it did not write.
    await sync()
    const [step] = (await tasks())
      .filter((t) => t.kind === "google")
      .flatMap((t) => t.steps.filter((s) => s.step === "permissions"))
    expect(step?.note).toBe("One box")
    expect((await tasks()).filter((t) => t.kind === "google")).toHaveLength(1)
  })

  it("keeps one task when an unpaid purchase gives way to a connect that goes live", async () => {
    const at =
      (orgId: string) =>
      <T>(fn: Parameters<typeof withOrg<T>>[1]) =>
        withOrg({ orgId }, fn)
    const moved = at(MOVED)
    const tag = MOVED.slice(0, 8)
    await moved(async (db) => {
      await db.insert(orgs).values({
        id: MOVED,
        slug: `tasks-moved-${tag}`,
        name: "Tasks moved (fixture)",
      })
      await db.insert(domains).values({
        orgId: MOVED,
        siteId: MOVED,
        name: `tasks-moved-${tag}.com`,
        primaryHost: `tasks-moved-${tag}.com`,
        origin: "purchased",
        method: "purchased",
        price: { tld: "com", retail_gbp: 12, cost_usd: 10.46 },
        state: "awaiting_payment",
        createdAt: new Date(Date.now() - 60_000),
      })
      await syncTasks(db, MOVED)
    })
    const host = `walk.tasks-moved-${tag}.example`
    await moved(async (db) => {
      await db
        .update(domains)
        .set({ state: "abandoned" })
        .where(eq(domains.orgId, MOVED))
      await db.insert(domains).values({
        orgId: MOVED,
        siteId: MOVED,
        name: host,
        primaryHost: host,
        origin: "connected",
        method: "records",
        state: "active",
        activatedAt: new Date(),
      })
      await syncTasks(db, MOVED)
    })
    const [task] = await moved((db) => readTasks(db))
    await moved((db) =>
      setStep(db, task?.id as string, "loads", { state: "done" })
    )
    // Google's verified write syncs again after the task is done.
    await moved((db) => syncTasks(db, MOVED))
    await moved((db) => syncTasks(db, MOVED))
    const after = await moved((db) => readTasks(db))
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      id: task?.id,
      state: "done",
      detail: { name: host },
    })
    // Removed, the same task is declined, and later syncs keep it the one task.
    await moved(async (db) => {
      await db
        .update(domains)
        .set({ state: "removed", removedAt: new Date() })
        .where(eq(domains.name, host))
      await syncTasks(db, MOVED)
      await syncTasks(db, MOVED)
    })
    const removed = await moved((db) => readTasks(db))
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({ id: task?.id, state: "declined" })

    // Connected again later, the name gets a task of its own.
    await moved(async (db) => {
      await db.insert(domains).values({
        orgId: MOVED,
        siteId: MOVED,
        name: host,
        primaryHost: host,
        origin: "connected",
        method: "records",
        state: "awaiting_dns",
        createdAt: new Date(Date.now() + 1000),
      })
      await syncTasks(db, MOVED)
    })
    const again = await moved((db) => readTasks(db))
    expect(again.map((t) => t.state).sort()).toEqual(["active", "declined"])
  })
})
