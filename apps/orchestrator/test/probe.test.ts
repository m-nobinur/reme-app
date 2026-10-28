import { openTask, sql, taskSteps } from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import { hold, type Observed, probe, timeless } from "../src/probe.ts"
import { freshOrg, kit } from "./fixture.ts"
import { stepped } from "./step.ts"

/**
 * The probe and hold engine against a database: the hash on the task step
 * is what decides whether the owner hears anything. The domain look through
 * it, with a post, is in domain-db.test.ts.
 */

const url = process.env.DATABASE_URL
const env = { HYPERDRIVE: { connectionString: url ?? "" } } as Env

afterAll(() => kit.close())

/** An org with an address task, and a probe of its `records` step that reads `seen`. */
async function setup() {
  const orgId = await freshOrg(kit)
  const taskId = await kit.withOrg({ orgId }, (db) =>
    openTask(db, orgId, "address")
  )
  const tell = vi.fn(async () => ({ text: "Nearly there." }))
  const look = (name: string, seen: () => Promise<unknown>) =>
    probe(
      stepped(),
      name,
      env,
      { orgId, kind: "address" },
      async (): Promise<Observed<{ n: number }>> => ({
        result: { n: 1 },
        reading: { step: "records", evidence: await seen(), tell },
      })
    )
  const stored = async () => {
    const [row] = await kit.withOrg({ orgId }, (db) =>
      db.select().from(taskSteps).where(sql`${taskSteps.step} = 'records'`)
    )
    return row
  }
  return { taskId, tell, look, stored }
}

describe("timeless", () => {
  it("drops every `at` and `*_at` key, at any depth", () => {
    expect(
      timeless({ at: 1, ok: true, list: [{ checked_at: "x", status: "a" }] })
    ).toEqual({ ok: true, list: [{ status: "a" }] })
  })
})

describe.skipIf(!url)("the probe and hold engine against a database", () => {
  it("words and says a changed reading once, and nothing for the same reading again", async () => {
    const { taskId, tell, look, stored } = await setup()
    const first = await look("look 1", async () => ({ status: "a", at: 1 }))
    expect(first).toEqual({
      n: 1,
      say: {
        key: expect.stringMatching(
          new RegExp(`^task:${taskId}:records:[0-9a-f]{12}$`)
        ),
        text: "Nearly there.",
      },
    })
    const before = await stored()
    expect(before?.evidence).toEqual({ status: "a" })

    // The same state, read at another time: no model call, no message.
    const again = await look("look 2", async () => ({ status: "a", at: 2 }))
    expect(again).toEqual({ n: 1 })
    expect(tell).toHaveBeenCalledTimes(1)
    const after = await stored()
    expect(after).toMatchObject({
      probeHash: before?.probeHash,
      changedAt: before?.changedAt,
    })
    expect(after?.probedAt).not.toEqual(before?.probedAt)

    // A new state is said once more.
    const moved = await look("look 3", async () => ({ status: "b" }))
    expect(moved).toHaveProperty("say")
    expect(tell).toHaveBeenCalledTimes(2)
  })

  it("takes a read that throws as an error, never a change", async () => {
    const { look, stored } = await setup()
    await look("look 1", async () => ({ status: "a" }))
    const before = await stored()
    await expect(
      look("look 2", async () => {
        throw new Error("dns.unavailable")
      })
    ).rejects.toThrow("dns.unavailable")
    expect(await stored()).toEqual(before)
  })

  it("holds until the event or the timeout, then probes again first", async () => {
    const { look } = await setup()
    const timedOut = stepped()
    const quiet = await hold(
      timedOut,
      "check 1",
      { type: "check", timeout: 60_000 },
      () => look("look 2", async () => ({ status: "a" }))
    )
    expect(quiet.woken).toBe(false)
    expect(quiet.seen).toHaveProperty("say")
    expect(timedOut.names).toEqual(["check 1"])

    const nudged = stepped({ type: "check" })
    const woken = await hold(
      nudged,
      "check 2",
      { type: "check", timeout: 60_000 },
      () => look("look 3", async () => ({ status: "a" }))
    )
    expect(woken).toEqual({ woken: true, payload: {}, seen: { n: 1 } })
  })
})
