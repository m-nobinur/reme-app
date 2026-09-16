import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import type { AssignmentState } from "@workspace/contracts"
import {
  approvals,
  assignments,
  deployments,
  eq,
  events,
  siteRevisions,
  sql,
  supersedeFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import fc from "fast-check"
import { afterAll, describe, expect, it, vi } from "vitest"
import { advance, TransitionError } from "../src/state.ts"
import { freshOrg, newAssignment } from "./fixture.ts"
import steps from "./workflow-steps.json" with { type: "json" }

// The Workflow base and its error come from workerd; here they are the two
// lines the publisher needs from them.
vi.mock("cloudflare:workers", () => ({
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
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
}))
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
  SLEEP_AFTER: "5m",
  PoolExhaustedError: class PoolExhaustedError extends Error {},
  provision: async () => ({ cold_start_ms: 1 }),
  sandboxFor: () => ({ destroy: async () => undefined }),
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const {
  activate,
  activeDeployment,
  decideApproval,
  probeHost,
  redriveQueued,
  requestReview,
  verifyArtifact,
} = await import("../src/publish.ts")
const { PublishWorkflow } = await import("../src/cloudflare.ts")
const { takeSnapshot } = await import("../src/brief.ts")

const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)
const kit: Tenancy = tenancy(url ?? "postgres://unused")
afterAll(() => kit.close())

const SUFFIX = "-stg.remeai.co.uk"
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex")
const HEADERS = { "x-frame-options": "DENY" }
const GOOD_HTML =
  '<!doctype html><html><head><title>BrightClean</title></head><body><main><h1>BrightClean</h1><p>Weekday cleaning from $35 an hour, call +15550142 to book a visit today.</p><a href="/">Home</a></main></body></html>'

/** A fake R2 holding revisions, and a fake KV holding pointers. */
function storage() {
  const objects = new Map<string, Uint8Array>()
  const pointers = new Map<string, string>()
  return {
    objects,
    pointers,
    SITES: {
      get: async (key: string) => {
        const bytes = objects.get(key)
        return bytes
          ? {
              arrayBuffer: async () => bytes.slice().buffer,
              json: async () => JSON.parse(new TextDecoder().decode(bytes)),
            }
          : null
      },
      put: async (key: string, value: string) => {
        objects.set(key, new TextEncoder().encode(value))
      },
    },
    ROUTES: {
      put: async (key: string, value: string) => {
        pointers.set(key, value)
      },
      get: async (key: string) => pointers.get(key) ?? null,
    },
  }
}

const FACTS = [
  ["business.name", "identity", { name: "BrightClean" }],
  ["business.phone", "contact", { e164: "+15550142" }],
  [
    "pricing.standard_clean_hourly",
    "pricing",
    { currency: "USD", amount_minor: 3500 },
  ],
] as const

const TO_PREVIEW: AssignmentState[] = [
  "briefing",
  "planning",
  "implementing",
  "validating",
  "preview_ready",
]

/** An org with facts, one assignment at `preview_ready`, and a preview revision in the fake R2. */
async function previewed(store = storage(), html = GOOD_HTML, older = 0) {
  const orgId = await freshOrg(kit)
  const ids = await newAssignment(kit, orgId)
  await kit.withOrg({ orgId }, async (db) => {
    for (const [key, factType, value] of FACTS) {
      await supersedeFact(db, {
        orgId,
        key,
        factType,
        value,
        provenance: { source: "owner_stated", confidence: 1 },
      })
    }
    await takeSnapshot(db, ids, [])
  })
  for (const to of TO_PREVIEW) await advance(kit, ids, to)
  // Older revisions of the same assignment, retired, so a stale id exists.
  const others: string[] = []
  for (let i = 0; i < older; i++) {
    others.push(
      await addRevision(store, orgId, ids.assignmentId, html, "retired")
    )
  }
  const revisionId = await addRevision(store, orgId, ids.assignmentId, html)
  return { orgId, ids, revisionId, store, others }
}

async function addRevision(
  store: ReturnType<typeof storage>,
  orgId: string,
  assignmentId: string,
  html: string,
  status: "preview" | "building" | "retired" = "preview"
) {
  const id = crypto.randomUUID()
  const prefix = `sites/${orgId}/${id}/`
  const [latest] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ max: sql<number>`coalesce(max(version), 0)::int` })
      .from(siteRevisions)
      .where(eq(siteRevisions.siteId, orgId))
  )
  await kit.withOrg({ orgId }, (db) =>
    db.insert(siteRevisions).values({
      id,
      orgId,
      siteId: orgId,
      assignmentId,
      version: (latest?.max ?? 0) + 1,
      sourceKey: `${prefix}source.tar.zst`,
      artifactPrefix: `${prefix}dist/`,
      manifestKey: `${prefix}manifest.json`,
      status,
    })
  )
  const files = { "index.html": sha(html) }
  await store.SITES.put(
    `${prefix}manifest.json`,
    JSON.stringify({
      revision_id: id,
      site_id: orgId,
      org_id: orgId,
      routes: [{ path: "/", file: "index.html" }],
      headers: HEADERS,
      files,
      built_at: new Date().toISOString(),
    })
  )
  await store.SITES.put(`${prefix}dist/index.html`, html)
  return id
}

const stateOf = (ids: { orgId: string; assignmentId: string }) =>
  kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const [row] = await db
      .select({ state: assignments.state })
      .from(assignments)
      .where(eq(assignments.id, ids.assignmentId))
    return row?.state
  })

const eventsOf = (ids: { orgId: string; assignmentId: string }, type: string) =>
  kit.withOrg({ orgId: ids.orgId }, (db) =>
    db
      .select()
      .from(events)
      .where(
        sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = ${type}`
      )
  )

live("a review", () => {
  it("moves preview_ready to awaiting_review with one open request, and replays", async () => {
    const { ids, revisionId } = await previewed()
    const first = await requestReview(kit, ids)
    expect(first.replayed).toBe(false)
    expect(first.request.target).toEqual({
      kind: "revision",
      revision_id: revisionId,
    })
    expect(await stateOf(ids)).toBe("awaiting_review")
    const again = await requestReview(kit, ids)
    expect(again.replayed).toBe(true)
    expect(again.request.approval_id).toBe(first.request.approval_id)
    expect(await eventsOf(ids, "approval.requested")).toHaveLength(1)
    const hours =
      (Date.parse(first.request.expires_at) -
        Date.parse(first.request.requested_at)) /
      3_600_000
    expect(hours).toBe(72)
  })

  it("refuses from any state but preview_ready, and without a preview revision", async () => {
    const orgId = await freshOrg(kit)
    const ids = await newAssignment(kit, orgId)
    await advance(kit, ids, "briefing")
    await expect(requestReview(kit, ids)).rejects.toMatchObject({
      code: "assignment.not_previewable",
    })
    const bare = await newAssignment(kit, orgId)
    await expect(requestReview(kit, bare)).rejects.toBeInstanceOf(
      TransitionError
    )
  })
})

live("an approval", () => {
  it("never reaches release_candidate unless it names the revision the review was requested for", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 0, max: 2 }),
        async (extraRevisions, pick) => {
          const { orgId, ids, revisionId, others } = await previewed(
            storage(),
            GOOD_HTML,
            extraRevisions
          )
          // The review binds to the latest revision, whichever that is now.
          const { request } = await requestReview(kit, ids)
          const target =
            request.target.kind === "revision" ? request.target.revision_id : ""
          const candidates = [
            target,
            revisionId,
            crypto.randomUUID(),
            ...others,
          ]
          const named = candidates[pick % candidates.length] as string
          const attempt = decideApproval(kit, ids, {
            revisionId: named,
            decidedBy: { kind: "console" },
          })
          if (named === target) {
            const { decision } = await attempt
            expect(decision.decision).toBe("approved")
            expect(await stateOf(ids)).toBe("release_candidate")
          } else {
            await expect(attempt).rejects.toMatchObject({
              code: "approval.target_mismatch",
            })
            expect(await stateOf(ids)).toBe("awaiting_review")
            const [row] = await kit.withOrg({ orgId }, (db) =>
              db
                .select({ decision: approvals.decision })
                .from(approvals)
                .where(eq(approvals.id, request.approval_id))
            )
            expect(row?.decision).toBeNull()
          }
        }
      ),
      { numRuns: 12 }
    )
  }, 120_000)

  it("is written once and replayed, and refused before a review or after it expired", async () => {
    const { orgId, ids, revisionId } = await previewed()
    await expect(
      decideApproval(kit, ids, {
        revisionId,
        decidedBy: { kind: "console" },
      })
    ).rejects.toMatchObject({ code: "approval.not_requested" })
    const { request } = await requestReview(kit, ids)
    const first = await decideApproval(kit, ids, {
      revisionId,
      decidedBy: { kind: "console" },
    })
    const again = await decideApproval(kit, ids, {
      revisionId,
      decidedBy: { kind: "console" },
    })
    expect(again.replayed).toBe(true)
    expect(again.decision.approval_id).toBe(first.decision.approval_id)
    expect(await eventsOf(ids, "approval.decided")).toHaveLength(1)
    // The database refuses a second decision on the same row outright.
    await expect(
      kit.withOrg({ orgId }, (db) =>
        db
          .update(approvals)
          .set({ decision: "rejected" })
          .where(eq(approvals.id, request.approval_id))
      )
    ).rejects.toThrow()

    // An expired request: inserted as such, since a request cannot be edited.
    const expired = await previewed()
    await kit.withOrg({ orgId: expired.orgId }, async (db) => {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, expired.ids.assignmentId))
      if (!row) throw new Error("gone")
      await db.insert(approvals).values({
        orgId: expired.orgId,
        assignmentId: row.id,
        requestedByStaffId: row.staffId,
        approverStaffId: row.createdByStaffId,
        actionKind: "site.publish",
        target: { kind: "revision", revision_id: expired.revisionId },
        revisionId: expired.revisionId,
        rationale: "probe",
        requestedAt: new Date(Date.now() - 100 * 3_600_000),
        expiresAt: new Date(Date.now() - 28 * 3_600_000),
      })
    })
    await advance(kit, expired.ids, "awaiting_review")
    await expect(
      decideApproval(kit, expired.ids, {
        revisionId: expired.revisionId,
        decidedBy: { kind: "console" },
      })
    ).rejects.toMatchObject({ code: "approval.expired" })
  })
})

live("activation", () => {
  it("appends one deployment per activation, points previous at the last, and moves only a publish's assignment", async () => {
    const { orgId, ids, revisionId, store } = await previewed()
    await requestReview(kit, ids)
    const { decision } = await decideApproval(kit, ids, {
      revisionId,
      decidedBy: { kind: "console" },
    })
    const first = await kit.withOrg({ orgId }, (db) =>
      activate(db, orgId, {
        siteId: orgId,
        revisionId,
        kind: "publish",
        approvalId: decision.approval_id,
        assignmentId: ids.assignmentId,
      })
    )
    expect(first.configVersion).toBe(1)
    expect(first.previousRevisionId).toBeNull()
    expect(await stateOf(ids)).toBe("published")
    // Again, after its commit: the same row, nothing new.
    const same = await kit.withOrg({ orgId }, (db) =>
      activate(db, orgId, {
        siteId: orgId,
        revisionId,
        kind: "publish",
        approvalId: decision.approval_id,
        assignmentId: ids.assignmentId,
      })
    )
    expect(same.id).toBe(first.id)

    const second = await newAssignment(kit, orgId)
    const rev2 = await addRevision(store, orgId, second.assignmentId, GOOD_HTML)
    const row2 = await kit.withOrg({ orgId }, (db) =>
      activate(db, orgId, {
        siteId: orgId,
        revisionId: rev2,
        kind: "rollback",
        reason: "probe",
      })
    )
    expect(row2.configVersion).toBe(2)
    expect(row2.previousRevisionId).toBe(revisionId)
    expect(await stateOf(second)).toBe("queued")
    const active = await kit.withOrg({ orgId }, (db) =>
      activeDeployment(db, orgId)
    )
    expect(active?.revisionId).toBe(rev2)
    const rows = await kit.withOrg({ orgId }, (db) =>
      db.select().from(deployments).where(eq(deployments.siteId, orgId))
    )
    expect(rows).toHaveLength(2)
    // reme_app cannot rewrite what a site served.
    await expect(
      kit.withOrg({ orgId }, (db) =>
        db
          .update(deployments)
          .set({ reason: "x" })
          .where(eq(deployments.id, row2.id))
      )
    ).rejects.toThrow()
  })
})

describe("the artifact check and the probe", () => {
  it("accepts a whole artifact and refuses a missing or altered file", async () => {
    const store = storage()
    const org = "10000001-0000-4000-8000-000000000001"
    const rev = "10000001-0000-4000-8000-000000000002"
    const prefix = `sites/${org}/${rev}/`
    await store.SITES.put(
      `${prefix}manifest.json`,
      JSON.stringify({
        revision_id: rev,
        site_id: org,
        org_id: org,
        routes: [],
        headers: {},
        files: { "index.html": sha("<h1>a</h1>"), "a.css": sha("b{}") },
        built_at: "2026-09-16T00:00:00.000Z",
      })
    )
    await store.SITES.put(`${prefix}dist/index.html`, "<h1>a</h1>")
    expect((await verifyArtifact(store.SITES, org, rev)).ok).toBe(false)
    await store.SITES.put(`${prefix}dist/a.css`, "b{}")
    expect((await verifyArtifact(store.SITES, org, rev)).ok).toBe(true)
    await store.SITES.put(`${prefix}dist/a.css`, "c{}")
    expect(await verifyArtifact(store.SITES, org, rev)).toMatchObject({
      ok: false,
      message: expect.stringContaining("a.css"),
    })
    expect((await verifyArtifact(store.SITES, org, "nope")).ok).toBe(false)
  })

  it("judges the live page by status, blankness and the content gate", async () => {
    const facts = FACTS.map(([key, factType, value], i) => ({
      fact_id: `10000001-0000-4000-8000-00000000000${i}`,
      org_id: "10000001-0000-4000-8000-000000000001",
      key,
      fact_type: factType,
      value,
      version: 1,
      provenance: {
        source: "owner_stated" as const,
        confidence: 1,
        verified_by_staff_id: null,
        verified_at: null,
      },
      valid_from: "2026-09-16T00:00:00.000Z",
      valid_to: null,
      superseded_by_fact_id: null,
    }))
    const answer = (status: number, body: string) =>
      (async () => new Response(body, { status })) as unknown as typeof fetch
    expect(await probeHost("x", facts, answer(200, GOOD_HTML))).toEqual({
      ok: true,
    })
    expect(await probeHost("x", null, answer(200, GOOD_HTML))).toEqual({
      ok: true,
    })
    expect(await probeHost("x", facts, answer(503, GOOD_HTML))).toMatchObject({
      ok: false,
      reason: "status 503",
    })
    expect(
      await probeHost(
        "x",
        facts,
        answer(200, "<html><head></head><body></body></html>")
      )
    ).toMatchObject({ ok: false, reason: "blank page" })
    expect(
      await probeHost(
        "x",
        facts,
        answer(200, GOOD_HTML.replace("$35 an hour", "$49 an hour"))
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining("$49") })
    expect(
      await probeHost("x", null, answer(200, GOOD_HTML.replace("$35", "$49")))
    ).toEqual({ ok: true })
    expect(
      await probeHost("x", facts, (async () => {
        throw new Error("down")
      }) as unknown as typeof fetch)
    ).toMatchObject({ ok: false, reason: "fetch failed: down" })
  })

  it("keeps the routing KV binding inside publish.ts", () => {
    const dir = new URL("../src/", import.meta.url)
    const offenders = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && f !== "publish.ts")
      .filter((f) => /\bROUTES\b/.test(readFileSync(new URL(f, dir), "utf8")))
    expect(offenders).toEqual([])
  })
})

/** A recording step: names in order, every callback run at once, sleeps skipped. */
function fakeStep(names: string[]) {
  return {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name)
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>
      return fn()
    },
    sleep: async (name: string) => {
      names.push(name)
    },
  } as never
}

function workflowEnv(store: ReturnType<typeof storage>) {
  const created: string[] = []
  return {
    created,
    env: {
      HYPERDRIVE: { connectionString: url },
      SITES: store.SITES,
      ROUTES: store.ROUTES,
      SITE_HOST_SUFFIX: SUFFIX,
      CONSOLE_APPROVALS: "allow",
      ASSIGNMENTS: {
        get: async () => ({ status: async () => ({ status: "complete" }) }),
        create: async ({ id }: { id: string }) => {
          created.push(id)
          return { id }
        },
      },
    } as unknown as Env,
  }
}

/** The page the fake router serves for a host: whatever the pointer names, from the fake R2. */
function serveFromPointer(
  store: ReturnType<typeof storage>,
  override?: () => Response | null
) {
  return vi.fn(async (input: string | URL | Request) => {
    const forced = override?.()
    if (forced) return forced
    const host = new URL(String(input)).hostname
    const raw = store.pointers.get(`host:${host}`)
    if (!raw) return new Response("No site here.", { status: 404 })
    const pointer = JSON.parse(raw) as { site_id: string; revision_id: string }
    const object = store.objects.get(
      `sites/${pointer.site_id}/${pointer.revision_id}/dist/index.html`
    )
    return object
      ? new Response(new TextDecoder().decode(object), { status: 200 })
      : new Response("", { status: 404 })
  })
}

live("the publish workflow", () => {
  async function approved(store = storage(), html = GOOD_HTML) {
    const built = await previewed(store, html)
    await requestReview(kit, built.ids)
    const { decision } = await decideApproval(kit, built.ids, {
      revisionId: built.revisionId,
      decidedBy: { kind: "console" },
    })
    return { ...built, approvalId: decision.approval_id }
  }

  it("publishes an approved revision: activates, points the host, probes four times, redrives", async () => {
    const store = storage()
    const { orgId, ids, revisionId, approvalId } = await approved(store)
    const { env, created } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    const names: string[] = []
    const outcome = await new PublishWorkflow({} as never, env).run(
      { payload: { org_id: orgId, approval_id: approvalId } } as never,
      fakeStep(names)
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({
      outcome: "published",
      revision_id: revisionId,
    })
    expect(names).toEqual(steps.PublishWorkflow.publish)
    expect(await stateOf(ids)).toBe("published")
    const slug = `state-test-${orgId.slice(0, 8)}`
    const pointer = JSON.parse(
      store.pointers.get(`host:${slug}${SUFFIX}`) ?? "{}"
    )
    expect(pointer).toMatchObject({
      org_id: orgId,
      site_id: orgId,
      revision_id: revisionId,
      config_version: 1,
    })
    expect(await eventsOf(ids, "publish.probed")).toHaveLength(4)
    expect(created).toEqual([])
    const [revision] = await kit.withOrg({ orgId }, (db) =>
      db.select().from(siteRevisions).where(eq(siteRevisions.id, revisionId))
    )
    expect(revision?.status).toBe("published")
  })

  it("never activates a half-uploaded artifact", async () => {
    const store = storage()
    const { orgId, ids, revisionId, approvalId } = await approved(store)
    store.objects.delete(`sites/${orgId}/${revisionId}/dist/index.html`)
    const { env } = workflowEnv(store)
    const names: string[] = []
    const outcome = await new PublishWorkflow({} as never, env).run(
      { payload: { org_id: orgId, approval_id: approvalId } } as never,
      fakeStep(names)
    )
    expect(outcome).toMatchObject({ outcome: "refused" })
    expect(names).toEqual(steps.PublishWorkflow.refused)
    expect(store.pointers.size).toBe(0)
    expect(
      await kit.withOrg({ orgId }, (db) => activeDeployment(db, orgId))
    ).toBeNull()
    expect(await stateOf(ids)).toBe("release_candidate")
    expect(await eventsOf(ids, "publish.refused")).toHaveLength(1)
  })

  it("refuses a stale approval: a newer revision on the assignment, or a console decision where none is allowed", async () => {
    const store = storage()
    const { orgId, ids, approvalId } = await approved(store)
    await addRevision(store, orgId, ids.assignmentId, GOOD_HTML, "building")
    const { env } = workflowEnv(store)
    await expect(
      new PublishWorkflow({} as never, env).run(
        { payload: { org_id: orgId, approval_id: approvalId } } as never,
        fakeStep([])
      )
    ).rejects.toThrow("approval.stale")
    expect(store.pointers.size).toBe(0)

    const other = await approved(storage())
    const forbidden = workflowEnv(other.store)
    await expect(
      new PublishWorkflow(
        {} as never,
        {
          ...forbidden.env,
          CONSOLE_APPROVALS: undefined,
        } as unknown as Env
      ).run(
        {
          payload: { org_id: other.orgId, approval_id: other.approvalId },
        } as never,
        fakeStep([])
      )
    ).rejects.toThrow("approval.console_forbidden")
  })

  it("rolls back to the previous revision when a probe fails, and raises an alert", async () => {
    const store = storage()
    const first = await approved(store)
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await new PublishWorkflow({} as never, env).run(
      {
        payload: { org_id: first.orgId, approval_id: first.approvalId },
      } as never,
      fakeStep([])
    )
    // A second build on the same site, approved, whose page goes blank after activation.
    const second = await newAssignment(kit, first.orgId)
    for (const to of TO_PREVIEW) await advance(kit, second, to)
    const rev2 = await addRevision(
      store,
      first.orgId,
      second.assignmentId,
      GOOD_HTML
    )
    await kit.withOrg({ orgId: first.orgId }, (db) =>
      takeSnapshot(db, second, [])
    )
    await requestReview(kit, second)
    const { decision } = await decideApproval(kit, second, {
      revisionId: rev2,
      decidedBy: { kind: "console" },
    })
    let probes = 0
    vi.stubGlobal(
      "fetch",
      serveFromPointer(store, () =>
        ++probes === 2 ? new Response("<html></html>", { status: 200 }) : null
      )
    )
    const names: string[] = []
    const outcome = await new PublishWorkflow({} as never, env).run(
      {
        payload: { org_id: first.orgId, approval_id: decision.approval_id },
      } as never,
      fakeStep(names)
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({ outcome: "rolled_back", revision_id: rev2 })
    expect(names).toEqual(steps.PublishWorkflow["probe failure rolled back"])
    const active = await kit.withOrg({ orgId: first.orgId }, (db) =>
      activeDeployment(db, first.orgId)
    )
    expect(active).toMatchObject({
      kind: "rollback",
      revisionId: first.revisionId,
      configVersion: 3,
    })
    const slug = `state-test-${first.orgId.slice(0, 8)}`
    expect(
      JSON.parse(store.pointers.get(`host:${slug}${SUFFIX}`) ?? "{}")
    ).toMatchObject({
      revision_id: first.revisionId,
      config_version: 3,
    })
    expect(await eventsOf(second, "alert.raised")).toHaveLength(1)
    // The assignment stays published: a rollback never moves one (ADR-032).
    expect(await stateOf(second)).toBe("published")
  })

  it("rolls back on request to the previous revision, keyed by the request, and redrives what queued", async () => {
    const store = storage()
    const first = await approved(store)
    const { env, created } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await new PublishWorkflow({} as never, env).run(
      {
        payload: { org_id: first.orgId, approval_id: first.approvalId },
      } as never,
      fakeStep([])
    )
    const second = await newAssignment(kit, first.orgId)
    for (const to of TO_PREVIEW) await advance(kit, second, to)
    const rev2 = await addRevision(
      store,
      first.orgId,
      second.assignmentId,
      GOOD_HTML
    )
    await kit.withOrg({ orgId: first.orgId }, (db) =>
      takeSnapshot(db, second, [])
    )
    await requestReview(kit, second)
    const { decision } = await decideApproval(kit, second, {
      revisionId: rev2,
      decidedBy: { kind: "console" },
    })
    await new PublishWorkflow({} as never, env).run(
      {
        payload: { org_id: first.orgId, approval_id: decision.approval_id },
      } as never,
      fakeStep([])
    )
    // Something queued behind the site lock while the second build was in review.
    const waiting = await newAssignment(kit, first.orgId)
    const names: string[] = []
    const outcome = await new PublishWorkflow({} as never, env).run(
      {
        payload: {
          org_id: first.orgId,
          site_id: first.orgId,
          rollback: { key: "k1", reason: "owner asked" },
        },
      } as never,
      fakeStep(names)
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({
      outcome: "published",
      revision_id: first.revisionId,
    })
    expect(names).toEqual(steps.PublishWorkflow.rollback)
    const active = await kit.withOrg({ orgId: first.orgId }, (db) =>
      activeDeployment(db, first.orgId)
    )
    expect(active).toMatchObject({
      kind: "rollback",
      revisionId: first.revisionId,
      previousRevisionId: rev2,
      reason: "owner asked",
      approvalId: null,
    })
    expect(created).toEqual([`${waiting.assignmentId}-r1`])
    expect(await eventsOf(waiting, "assignment.redriven")).toHaveLength(1)
    // A rollback with nothing before the active row is refused before anything moves.
    const fresh = await approved(storage())
    const freshEnv = workflowEnv(fresh.store)
    await expect(
      new PublishWorkflow({} as never, freshEnv.env).run(
        {
          payload: {
            org_id: fresh.orgId,
            site_id: fresh.orgId,
            rollback: { key: "k2", reason: "x" },
          },
        } as never,
        fakeStep([])
      )
    ).rejects.toThrow("rollback.nothing_previous")
  })

  it("leaves a running queued instance alone when redriving", async () => {
    const orgId = await freshOrg(kit)
    const queued = await newAssignment(kit, orgId)
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(assignments)
        .set({ workflowInstanceId: queued.assignmentId })
        .where(eq(assignments.id, queued.assignmentId))
    )
    const created: string[] = []
    const env = {
      ASSIGNMENTS: {
        get: async () => ({ status: async () => ({ status: "running" }) }),
        create: async ({ id }: { id: string }) => {
          created.push(id)
          return { id }
        },
      },
    } as unknown as Env
    expect(await redriveQueued(env, kit, orgId)).toEqual([])
    expect(created).toEqual([])
  })
})
