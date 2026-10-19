import { deployments, eq, siteRevisions, sql } from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  advance,
  parkForBudget,
  RETENTION_DAYS,
  TransitionError,
} from "../src/state.ts"
import { freshOrg, newAssignment } from "./fixture.ts"

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {
    env: unknown
    constructor(_ctx: unknown, env: unknown) {
      this.env = env
    }
  },
}))
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}))
vi.mock("../src/container.ts", () => ({
  RemeSandbox: class {},
  SandboxEgress: class {},
  SandboxPool: class {},
}))
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
  SLEEP_AFTER: "5m",
  PoolExhaustedError: class PoolExhaustedError extends Error {},
  provision: async () => ({ cold_start_ms: 1 }),
  sandboxFor: () => ({ destroy: async () => undefined }),
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const { decideApproval, rejectApproval, requestReview, activeDeployment } =
  await import("../src/publish.ts")
const { deleteRevisionFiles, dueRevisions, parkExpiredReviews, retireOthers } =
  await import("../src/retention.ts")
const { PublishWorkflow } = await import("../src/cloudflare.ts")
const {
  addRevision,
  eventsOf,
  fakeStep,
  GOOD_HTML,
  kit,
  previewed,
  serveFromPointer,
  stateOf,
  storage,
  TO_PREVIEW,
  workflowEnv,
} = await import("./site.ts")
const { takeSnapshot } = await import("../src/brief.ts")

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)
afterAll(() => kit.close())

const DAY = 24 * 60 * 60 * 1000
const revisionRow = (orgId: string, id: string) =>
  kit.withOrg({ orgId }, async (db) => {
    const [row] = await db
      .select()
      .from(siteRevisions)
      .where(eq(siteRevisions.id, id))
    if (!row) throw new Error("gone")
    return row
  })

/** A second, third build on the same site: a new assignment at preview_ready with its revision in the store. */
async function anotherBuild(store: ReturnType<typeof storage>, orgId: string) {
  const ids = await newAssignment(kit, orgId)
  await kit.withOrg({ orgId }, (db) => takeSnapshot(db, ids, []))
  for (const to of TO_PREVIEW) await advance(kit, ids, to)
  const revisionId = await addRevision(
    store,
    orgId,
    ids.assignmentId,
    GOOD_HTML
  )
  return { ids, revisionId }
}

/** Approve and publish through the Workflow, the router stood in for by the store. */
async function publish(
  store: ReturnType<typeof storage>,
  orgId: string,
  ids: { orgId: string; assignmentId: string },
  revisionId: string
) {
  await requestReview(kit, ids)
  const { decision } = await decideApproval(kit, ids, {
    revisionId,
    decidedBy: { kind: "console" },
  })
  const { env } = workflowEnv(store)
  vi.stubGlobal("fetch", serveFromPointer(store))
  const names: string[] = []
  const outcome = await new PublishWorkflow({} as never, env).run(
    { payload: { org_id: orgId, approval_id: decision.approval_id } } as never,
    fakeStep(names)
  )
  vi.unstubAllGlobals()
  return { outcome, names }
}

live("three publishes on one site", () => {
  it("keeps the active and the previous, retires the rest with a date, and the sweep deletes exactly the due one, once", async () => {
    const store = storage()
    const first = await previewed(store)
    const { orgId } = first
    const r1 = await publish(store, orgId, first.ids, first.revisionId)
    expect(r1.outcome).toMatchObject({ outcome: "published" })
    expect(r1.names).toContain("retire others")
    const second = await anotherBuild(store, orgId)
    await publish(store, orgId, second.ids, second.revisionId)
    const third = await anotherBuild(store, orgId)
    await publish(store, orgId, third.ids, third.revisionId)

    const v1 = await revisionRow(orgId, first.revisionId)
    const v2 = await revisionRow(orgId, second.revisionId)
    const v3 = await revisionRow(orgId, third.revisionId)
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3])
    expect(v1.status).toBe("retired")
    expect(v1.retireAfter).not.toBeNull()
    const window = (v1.retireAfter as Date).getTime() - Date.now()
    expect(window).toBeGreaterThan((RETENTION_DAYS - 1) * DAY)
    expect(window).toBeLessThanOrEqual(RETENTION_DAYS * DAY)
    expect(v2.status).toBe("published")
    expect(v2.retireAfter).toBeNull()
    expect(v3.status).toBe("published")
    expect(v3.retireAfter).toBeNull()

    // v2 still rolls back: the previous of the active row is v2.
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    const back = await new PublishWorkflow({} as never, env).run(
      {
        payload: {
          org_id: orgId,
          site_id: orgId,
          rollback: { key: "k-retention", reason: "the owner asked" },
        },
      } as never,
      fakeStep([])
    )
    vi.unstubAllGlobals()
    expect(back).toMatchObject({
      outcome: "published",
      revision_id: second.revisionId,
    })
    const active = await kit.withOrg({ orgId }, (db) =>
      activeDeployment(db, orgId)
    )
    expect(active).toMatchObject({
      revisionId: second.revisionId,
      previousRevisionId: third.revisionId,
    })
    // Retiring again after the rollback keeps v2 and v3 as they now stand.
    const again = await kit.withOrg({ orgId }, (db) => retireOthers(db, orgId))
    expect(again).toEqual([])
    expect((await revisionRow(orgId, third.revisionId)).status).toBe(
      "published"
    )

    // The sweep, eight days on: exactly v1's prefix, one event, then nothing.
    const later = new Date(Date.now() + 8 * DAY)
    const soon = new Date(Date.now() + 6 * DAY)
    expect(
      await kit.withOrg({ orgId }, (db) => dueRevisions(db, soon))
    ).toEqual([])
    const due = await kit.withOrg({ orgId }, (db) => dueRevisions(db, later))
    expect(due.map((r) => r.id)).toEqual([first.revisionId])
    const prefix = `sites/${orgId}/${first.revisionId}/`
    const before = [...store.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b))
    expect(before).toEqual([
      `${prefix}dist/index.html`,
      `${prefix}manifest.json`,
      `${prefix}source.tar.zst`,
    ])
    const { keys } = await kit.withOrg({ orgId }, (db) =>
      deleteRevisionFiles(store.SITES, db, v1, later)
    )
    expect(keys.sort((a, b) => a.localeCompare(b))).toEqual(before)
    expect(
      [...store.objects.keys()].filter((k) => k.startsWith(prefix))
    ).toEqual([])
    expect(
      store.objects.has(`sites/${orgId}/${second.revisionId}/manifest.json`)
    ).toBe(true)
    expect(
      store.objects.has(`sites/${orgId}/${third.revisionId}/manifest.json`)
    ).toBe(true)
    const deleted = await eventsOf(first.ids, "revision.files_deleted")
    expect(deleted).toHaveLength(1)
    expect(deleted[0]?.payload).toMatchObject({
      revision_id: first.revisionId,
      keys: before,
      count: 3,
    })
    // Twice: nothing to list, nothing appended, and it is no longer due.
    const twice = await kit.withOrg({ orgId }, (db) =>
      deleteRevisionFiles(store.SITES, db, v1, later)
    )
    expect(twice.keys).toEqual([])
    expect(await eventsOf(first.ids, "revision.files_deleted")).toHaveLength(1)
    expect(
      await kit.withOrg({ orgId }, (db) => dueRevisions(db, later))
    ).toEqual([])
    // All three rows are still there, with their tags derivable from version.
    const rows = await kit.withOrg({ orgId }, (db) =>
      db
        .select()
        .from(siteRevisions)
        .where(eq(siteRevisions.siteId, orgId))
        .orderBy(siteRevisions.version)
    )
    expect(rows.map((r) => `v${r.version}:${r.status}`)).toEqual([
      "v1:retired",
      "v2:published",
      "v3:published",
    ])
  }, 120_000)

  it("refuses to delete the active revision, the previous one, one not yet due, and one not retired", async () => {
    const store = storage()
    const first = await previewed(store)
    const { orgId } = first
    await publish(store, orgId, first.ids, first.revisionId)
    const second = await anotherBuild(store, orgId)
    await publish(store, orgId, second.ids, second.revisionId)
    const later = new Date(Date.now() + 8 * DAY)
    const refusal = async (id: string, at: Date) => {
      const row = await revisionRow(orgId, id)
      try {
        await kit.withOrg({ orgId }, (db) =>
          deleteRevisionFiles(store.SITES, db, row, at)
        )
      } catch (error) {
        expect(error).toBeInstanceOf(TransitionError)
        return (error as TransitionError).message
      }
      return "allowed"
    }
    // Neither is retired, so the status guard answers first for both.
    expect(await refusal(second.revisionId, later)).toBe(
      "the revision is not retired"
    )
    expect(await refusal(first.revisionId, later)).toBe(
      "the revision is not retired"
    )
    // Force the rows retired to reach the active and previous guards.
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(siteRevisions)
        .set({ status: "retired", retireAfter: new Date(Date.now() - DAY) })
        .where(
          sql`${siteRevisions.id} in (${first.revisionId}, ${second.revisionId})`
        )
    )
    expect(await refusal(second.revisionId, later)).toBe(
      "the revision is what the site serves"
    )
    expect(await refusal(first.revisionId, later)).toBe(
      "the revision is what a rollback would restore"
    )
    // A retired, due-later revision of a third build.
    const third = await anotherBuild(store, orgId)
    await advance(kit, third.ids, "cancelled")
    expect(await refusal(third.revisionId, new Date())).toBe(
      "the revision's window has not passed"
    )
    expect(
      store.objects.has(`sites/${orgId}/${third.revisionId}/manifest.json`)
    ).toBe(true)
  }, 60_000)
})

live("a sweep cut off between its deletes and its event", () => {
  it("settles the revision on the next run, once, though its prefix is empty", async () => {
    const store = storage()
    const { orgId, revisionId } = await previewed(store)
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(siteRevisions)
        .set({ status: "retired", retireAfter: new Date(Date.now() - DAY) })
        .where(eq(siteRevisions.id, revisionId))
    )
    // The deletes happened; the event never did.
    const prefix = `sites/${orgId}/${revisionId}/`
    for (const key of [...store.objects.keys()]) {
      if (key.startsWith(prefix)) store.objects.delete(key)
    }
    const row = await revisionRow(orgId, revisionId)
    for (const run of [1, 2]) {
      const { keys } = await kit.withOrg({ orgId }, (db) =>
        deleteRevisionFiles(store.SITES, db, row)
      )
      expect(keys, `run ${run}`).toEqual([])
    }
    expect(await kit.withOrg({ orgId }, (db) => dueRevisions(db))).toEqual([])
    const events = await eventsOf(
      { orgId, assignmentId: row.assignmentId as string },
      "revision.files_deleted"
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ keys: [], count: 0 })
  })
})

live("a build that ends without publishing", () => {
  it("retires its unpublished revisions in the cancelling transaction, and never a published one", async () => {
    const store = storage()
    const built = await previewed(store)
    const { orgId, ids, revisionId } = built
    // A published revision the same assignment owns, and a building one.
    const older = await addRevision(
      store,
      orgId,
      ids.assignmentId,
      GOOD_HTML,
      "building"
    )
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(siteRevisions)
        .set({ status: "published" })
        .where(eq(siteRevisions.id, older))
    )
    const building = await addRevision(
      store,
      orgId,
      ids.assignmentId,
      GOOD_HTML,
      "building"
    )
    await advance(kit, ids, "cancelled")
    expect((await revisionRow(orgId, revisionId)).status).toBe("retired")
    expect((await revisionRow(orgId, building)).status).toBe("retired")
    expect((await revisionRow(orgId, older)).status).toBe("published")
    const changed = await eventsOf(ids, "assignment.state_changed")
    const last = changed.at(-1)?.payload as {
      to: string
      retired_revisions?: string[]
    }
    expect(last.to).toBe("cancelled")
    expect(last.retired_revisions?.sort((a, b) => a.localeCompare(b))).toEqual(
      [revisionId, building].sort((a, b) => a.localeCompare(b))
    )
  })

  it("retires on failed the same way", async () => {
    const store = storage()
    const orgId = await freshOrg(kit)
    const ids = await newAssignment(kit, orgId)
    for (const to of ["briefing", "planning", "implementing"] as const)
      await advance(kit, ids, to)
    const building = await addRevision(
      store,
      orgId,
      ids.assignmentId,
      GOOD_HTML,
      "building"
    )
    await advance(kit, ids, "failed", { reason: "probe" })
    const row = await revisionRow(orgId, building)
    expect(row.status).toBe("retired")
    expect(row.retireAfter).not.toBeNull()
  })
})

live("reviews the owner never answered", () => {
  async function expiredReview(store = storage()) {
    const built = await previewed(store)
    const { request } = await requestReview(kit, built.ids)
    // The request cannot be edited once written, so its clock is moved as the migrator would: by
    // inserting the row expired. Here the shortest honest route is the sweep's own clock.
    return { ...built, request }
  }

  it("parks an expired review and leaves a fresh one, and the park is still approvable and publishes", async () => {
    const store = storage()
    const stale = await expiredReview(store)
    const fresh = await expiredReview(storage())
    const later = new Date(Date.now() + 73 * 60 * 60 * 1000)
    const parked = await kit.withOrg({ orgId: stale.orgId }, (db) =>
      parkExpiredReviews(db, later)
    )
    expect(parked).toEqual([stale.ids.assignmentId])
    expect(await stateOf(stale.ids)).toBe("blocked_on_approval")
    expect(
      await kit.withOrg({ orgId: fresh.orgId }, (db) =>
        parkExpiredReviews(db, new Date())
      )
    ).toEqual([])
    expect(await stateOf(fresh.ids)).toBe("awaiting_review")
    // Twice: nothing to park.
    expect(
      await kit.withOrg({ orgId: stale.orgId }, (db) =>
        parkExpiredReviews(db, later)
      )
    ).toEqual([])

    // The late approval, from the park, past the request's own expiry as far as the clock is
    // concerned once the request is old enough; here the request is not yet expired by wall
    // clock, so this proves the park is approvable and the next case proves the expiry path.
    const { decision } = await decideApproval(kit, stale.ids, {
      revisionId: stale.revisionId,
      decidedBy: { kind: "console" },
    })
    expect(decision.decision).toBe("approved")
    expect(await stateOf(stale.ids)).toBe("release_candidate")
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    const outcome = await new PublishWorkflow({} as never, env).run(
      {
        payload: { org_id: stale.orgId, approval_id: decision.approval_id },
      } as never,
      fakeStep([])
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({ outcome: "published" })
    expect(await stateOf(stale.ids)).toBe("published")
  }, 60_000)

  it("accepts an expired request from the park and says so, but not from awaiting_review, and never a budget park", async () => {
    // An expired request, written as such, then parked.
    const { approvals, assignments } = await import("@workspace/db")
    const built = await previewed(storage())
    const { orgId, ids, revisionId } = built
    await kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, ids.assignmentId))
      if (!row) throw new Error("gone")
      await db.insert(approvals).values({
        orgId,
        assignmentId: row.id,
        requestedByStaffId: row.staffId,
        approverStaffId: row.createdByStaffId,
        actionKind: "site.publish",
        target: { kind: "revision", revision_id: revisionId },
        revisionId,
        rationale: "probe",
        requestedAt: new Date(Date.now() - 100 * 3_600_000),
        expiresAt: new Date(Date.now() - 28 * 3_600_000),
      })
    })
    await advance(kit, ids, "awaiting_review")
    await expect(
      decideApproval(kit, ids, { revisionId, decidedBy: { kind: "console" } })
    ).rejects.toMatchObject({ code: "approval.expired" })
    expect(
      await kit.withOrg({ orgId }, (db) => parkExpiredReviews(db))
    ).toEqual([ids.assignmentId])
    const { decision } = await decideApproval(kit, ids, {
      revisionId,
      decidedBy: { kind: "console" },
    })
    expect(decision.decision).toBe("approved")
    expect(await stateOf(ids)).toBe("release_candidate")
    const decided = await eventsOf(ids, "approval.decided")
    expect(decided[0]?.payload).toMatchObject({ expired: true })

    // A budget park is not a review: the N2 ruling holds.
    const budget = await previewed(storage())
    await kit.withOrg({ orgId: budget.orgId }, async (db) => {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, budget.ids.assignmentId))
      if (!row) throw new Error("gone")
      await db.insert(approvals).values({
        orgId: budget.orgId,
        assignmentId: row.id,
        requestedByStaffId: row.staffId,
        approverStaffId: row.createdByStaffId,
        actionKind: "site.publish",
        target: { kind: "revision", revision_id: budget.revisionId },
        revisionId: budget.revisionId,
        rationale: "probe",
        expiresAt: new Date(Date.now() + 3_600_000),
      })
    })
    const implementing = await newAssignment(kit, budget.orgId)
    // A second assignment cannot take the site lock while the first holds it, so park the first.
    await advance(kit, budget.ids, "cancelled")
    for (const to of ["briefing", "planning", "implementing"] as const)
      await advance(kit, implementing, to)
    await parkForBudget(kit, implementing, { cap_usd: 1, spent_usd: 1 })
    await expect(
      decideApproval(kit, implementing, {
        revisionId: budget.revisionId,
        decidedBy: { kind: "console" },
      })
    ).rejects.toMatchObject({ code: "approval.not_requested" })
    expect(await stateOf(implementing)).toBe("blocked_on_approval")
  }, 60_000)
})

live("rejecting a review", () => {
  it("ends the build cancelled, retires its candidate, refuses a wrong revision and replays", async () => {
    const store = storage()
    const built = await previewed(store)
    const { orgId, ids, revisionId } = built
    const { request } = await requestReview(kit, ids)
    await expect(
      rejectApproval(kit, ids, {
        revisionId: crypto.randomUUID(),
        decidedBy: { kind: "console" },
      })
    ).rejects.toMatchObject({ code: "approval.target_mismatch" })
    const first = await rejectApproval(kit, ids, {
      revisionId,
      decidedBy: { kind: "console" },
    })
    expect(first.replayed).toBe(false)
    expect(first.decision).toMatchObject({
      approval_id: request.approval_id,
      decision: "rejected",
    })
    expect(await stateOf(ids)).toBe("cancelled")
    const row = await revisionRow(orgId, revisionId)
    expect(row.status).toBe("retired")
    expect(row.retireAfter).not.toBeNull()
    const again = await rejectApproval(kit, ids, {
      revisionId,
      decidedBy: { kind: "console" },
    })
    expect(again.replayed).toBe(true)
    expect(await eventsOf(ids, "approval.decided")).toHaveLength(1)
    // The site is free: a new build takes the lock.
    const next = await newAssignment(kit, orgId)
    await advance(kit, next, "briefing")
    expect(await stateOf(next)).toBe("briefing")
    // Nothing was ever activated, so the sweep sees no active row to protect and the file is due in a week.
    expect(
      await kit.withOrg({ orgId }, (db) => db.select().from(deployments))
    ).toEqual([])
  })
})
