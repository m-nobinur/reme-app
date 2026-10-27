import { eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import { domains, orgs, searchConnections } from "../src/schema.ts"
import { openTask, readTasks, setStep, syncTasks } from "../src/tasks.ts"
import { withOrg } from "../src/tenancy.ts"

/** The task store against Postgres: the mapping from domain and Google rows, run twice. */
const ORG = crypto.randomUUID()
const NAME = `tasks-probe-${ORG.slice(0, 8)}.example.com`

const run = <T>(fn: Parameters<typeof withOrg<T>>[1]) =>
  withOrg({ orgId: ORG }, fn)
const sync = () => run((db) => syncTasks(db, ORG))
const tasks = () => run((db) => readTasks(db))
const states = (task: { steps: { step: string; state: string }[] }) =>
  Object.fromEntries(task.steps.map((s) => [s.step, s.state]))

afterAll(async () => {
  const { sql: client, db } = connect()
  try {
    await db.transaction((tx) => clearOrgs(tx, [ORG], []))
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

    await run((db) =>
      db
        .update(domains)
        .set({ state: "active", activatedAt: new Date() })
        .where(eq(domains.name, NAME))
    )
    await sync()
    const [live] = await tasks()
    expect(live).toMatchObject({ id: first?.id, state: "done" })
    expect(live?.done_at).not.toBeNull()
    expect(live?.steps.find((s) => s.step === "records")).toMatchObject({
      state: "done",
      blocked_on: null,
      deadline: null,
    })
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
})
