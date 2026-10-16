import { readdirSync, readFileSync } from "node:fs"
import {
  formatSiteRevision,
  SITE_PROBE_HEADER,
  SITE_REVISION_HEADER,
} from "@workspace/contracts"
import {
  approvals,
  assignments,
  deployments,
  domains,
  eq,
  events,
  siteRevisions,
  sql,
  supersedeFact,
  tenancy,
} from "@workspace/db"
import fc from "fast-check"
import { afterAll, describe, expect, it, vi } from "vitest"
import type { Activation } from "../src/publish.ts"
import { advance, TransitionError } from "../src/state.ts"
import { freshOrg, newAssignment } from "./fixture.ts"
import steps from "./workflow-steps.json" with { type: "json" }

// The Workflow base and its error come from workerd; here they are the two
// lines the publisher needs from them.
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
  dropDomainPointers,
  probeHost,
  redriveQueued,
  FETCH_TIMEOUT_MS,
  requestReview,
  SERVE_TRIES,
  SERVE_WAIT_MS,
  stillLive,
  verifyArtifact,
  writePointer,
} = await import("../src/publish.ts")
const { PublishWorkflow } = await import("../src/cloudflare.ts")
const { takeSnapshot } = await import("../src/brief.ts")
const {
  addRevision,
  eventsOf,
  FACTS,
  fakeStep,
  GOOD_HTML,
  kit,
  previewed,
  serveFromPointer,
  sha,
  stateOf,
  storage,
  SUFFIX,
  TO_PREVIEW,
  workflowEnv,
} = await import("./site.ts")

const live = describe.skipIf(!process.env.DATABASE_URL)
// The pool these helpers run on, so this file closes the one it used.
afterAll(() => kit.close())

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

  it("waits for the accessibility gate, which runs after the preview", async () => {
    const { ids } = await previewed(storage(), GOOD_HTML, 0, false)
    await expect(requestReview(kit, ids)).rejects.toMatchObject({
      code: "revision.a11y_unchecked",
    })
    expect(await stateOf(ids)).toBe("preview_ready")
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
  const activated = async (orgId: string, input: Activation) => {
    const row = await kit.withOrg({ orgId }, (db) => activate(db, orgId, input))
    if (!row) throw new Error("nothing was activated")
    return row
  }

  it("appends one deployment per activation, points previous at the last, and moves only a publish's assignment", async () => {
    const { orgId, ids, revisionId, store } = await previewed()
    await requestReview(kit, ids)
    const { decision } = await decideApproval(kit, ids, {
      revisionId,
      decidedBy: { kind: "console" },
    })
    const key = crypto.randomUUID()
    const first = await activated(orgId, {
      id: key,
      siteId: orgId,
      revisionId,
      kind: "publish",
      approvalId: decision.approval_id,
      assignmentId: ids.assignmentId,
    })
    expect(first.configVersion).toBe(1)
    expect(first.previousRevisionId).toBeNull()
    expect(await stateOf(ids)).toBe("published")
    // Again, after its commit: the same row, nothing new.
    const same = await activated(orgId, {
      id: key,
      siteId: orgId,
      revisionId,
      kind: "publish",
      approvalId: decision.approval_id,
      assignmentId: ids.assignmentId,
    })
    expect(same.id).toBe(first.id)

    const second = await newAssignment(kit, orgId)
    const rev2 = await addRevision(store, orgId, second.assignmentId, GOOD_HTML)
    const row2 = await activated(orgId, {
      id: crypto.randomUUID(),
      siteId: orgId,
      revisionId: rev2,
      kind: "rollback",
      reason: "probe",
    })
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

  it("checks what is live only between activations, never across one", async () => {
    const { orgId, ids, revisionId, store } = await previewed()
    const first = await activated(orgId, {
      id: crypto.randomUUID(),
      siteId: orgId,
      revisionId,
      kind: "rollback",
      reason: "setup",
    })
    const rev2 = await addRevision(store, orgId, ids.assignmentId, GOOD_HTML)
    // A second pool, so the check waits on the site and not on a connection.
    const other = tenancy(process.env.DATABASE_URL ?? "postgres://unused")
    let held: () => void = () => undefined
    const holding = new Promise<void>((done) => {
      held = done
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((done) => {
      release = done
    })
    const newer = kit.withOrg({ orgId }, async (db) => {
      await activate(db, orgId, {
        id: crypto.randomUUID(),
        siteId: orgId,
        revisionId: rev2,
        kind: "rollback",
        reason: "newer",
      })
      held()
      await gate
    })
    await holding
    const target = {
      site_id: orgId,
      revision_id: revisionId,
      assignment_id: ids.assignmentId,
    }
    const check = other.withOrg({ orgId }, (db) =>
      stillLive(db, orgId, target, first.id, "alert")
    )
    // Uncommitted, the newer activation is invisible: a check that ran now
    // would find the first still live and let a stale alert through.
    await new Promise((done) => setTimeout(done, 200))
    release()
    await newer
    expect(await check).toBe(false)
    await other.close()
  })

  it("adds no row for a revision that is already live", async () => {
    const { orgId, revisionId } = await previewed()
    const input = {
      siteId: orgId,
      revisionId,
      kind: "rollback" as const,
      reason: "setup",
    }
    const first = await activated(orgId, { ...input, id: crypto.randomUUID() })
    const again = await activated(orgId, { ...input, id: crypto.randomUUID() })
    expect(again.id).toBe(first.id)
    const rows = await kit.withOrg({ orgId }, (db) =>
      db.select().from(deployments).where(eq(deployments.siteId, orgId))
    )
    expect(rows).toHaveLength(1)
  })

  it("replays only its own row: another activation of the same revision is not one", async () => {
    const { orgId, ids, revisionId, store } = await previewed()
    const first = await activated(orgId, {
      id: crypto.randomUUID(),
      siteId: orgId,
      revisionId,
      kind: "rollback",
      reason: "setup",
    })
    const rev2 = await addRevision(store, orgId, ids.assignmentId, GOOD_HTML)
    const second = await activated(orgId, {
      id: crypto.randomUUID(),
      siteId: orgId,
      revisionId: rev2,
      kind: "rollback",
      reason: "setup",
    })
    // The owner rolls the second back; a probe's rollback of the same second
    // then finds the first already restored, but not by itself.
    const back = {
      siteId: orgId,
      revisionId: first.revisionId,
      kind: "rollback" as const,
      over: second.id,
    }
    const owners = await activated(orgId, { ...back, id: crypto.randomUUID() })
    expect(
      await kit.withOrg({ orgId }, (db) =>
        activate(db, orgId, { ...back, id: crypto.randomUUID() })
      )
    ).toBeNull()
    // The owner's own retry, after its result was lost, is its row again.
    expect((await activated(orgId, { ...back, id: owners.id })).id).toBe(
      owners.id
    )
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
    // The live page names its own host, and a slug can carry a date.
    const host = "dated-20260925-stg.remeai.co.uk"
    const named = GOOD_HTML.replace(
      "</title>",
      `</title><meta property="og:url" content="https://${host}/">`
    )
    expect(await probeHost(host, facts, answer(200, named))).toEqual({
      ok: true,
    })
    expect(await probeHost("x", facts, answer(200, named))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("20260925"),
    })
    expect(
      await probeHost("x", facts, (async () => {
        throw new Error("down")
      }) as unknown as typeof fetch)
    ).toMatchObject({ ok: false, reason: "fetch failed: down" })
  })

  it("judges only a page its own revision served, and waits for it", async () => {
    const waits: number[] = []
    const pause = async (ms: number) => {
      waits.push(ms)
    }
    const MINE = "10000001-0000-4000-8000-00000000000a"
    const OLDER = "10000001-0000-4000-8000-00000000000b"
    const NEWER = "10000001-0000-4000-8000-00000000000c"
    const mine = { revision_id: MINE, config_version: 2, proof: "proof-for-x" }
    const tag = (revision_id: string, config_version: number) => ({
      [SITE_REVISION_HEADER]: formatSiteRevision({
        revision_id,
        config_version,
      }),
    })
    // Answers in turn, then this revision's own tagged page for good, and
    // keeps the proof each request carried.
    const proofs: (string | null)[] = []
    const router = (answers: Response[], body: string) =>
      (async (_url: string, init: RequestInit) => {
        proofs.push(new Headers(init.headers).get(SITE_PROBE_HEADER))
        return (
          answers.shift() ??
          new Response(body, {
            status: 200,
            headers: tag(MINE, 2),
          })
        )
      }) as unknown as typeof fetch
    const older = () =>
      new Response("<p>older</p>", { status: 200, headers: tag(OLDER, 1) })
    const broken = GOOD_HTML.replace("$35", "$49")
    // The older deployment answers twice, then this one, whose page is judged.
    expect(
      await probeHost(
        "x",
        null,
        router([older(), older()], "<html></html>"),
        mine,
        pause
      )
    ).toMatchObject({ ok: false, reason: "blank page" })
    expect(waits).toHaveLength(2)
    // Every ask proves it is the probe, or the router names no revision.
    expect(proofs).toEqual(["proof-for-x", "proof-for-x", "proof-for-x"])
    // Untagged answers are not this version's either: a cached "nobody" 404,
    // the limiter's 429, the router's own 503, a page with no tag.
    waits.length = 0
    expect(
      await probeHost(
        "x",
        null,
        router(
          [
            new Response("No site here.", { status: 404 }),
            new Response("Too many requests.", { status: 429 }),
            new Response("{}", { status: 503 }),
            new Response(broken, { status: 200 }),
          ],
          GOOD_HTML
        ),
        mine,
        pause
      )
    ).toEqual({ ok: true })
    expect(waits).toHaveLength(4)
    // A newer deployment's page is never judged and never waited for.
    waits.length = 0
    expect(
      await probeHost(
        "x",
        null,
        router(
          [new Response(broken, { status: 200, headers: tag(NEWER, 3) })],
          GOOD_HTML
        ),
        mine,
        pause
      )
    ).toMatchObject({ ok: false, not_served: `${NEWER}@3` })
    expect(waits).toEqual([])
    // One that never serves this version is not judged: after its tries the
    // probe fails as not served, never on the page, and a fetch that throws
    // counts the same way.
    expect(
      await probeHost(
        "x",
        null,
        router(new Array(50).fill(null).map(older), broken),
        mine,
        pause
      )
    ).toMatchObject({ ok: false, not_served: `${OLDER}@1` })
    expect(waits).toHaveLength(SERVE_TRIES - 1)
    expect(
      await probeHost(
        "x",
        null,
        (async () => {
          throw new Error("down")
        }) as unknown as typeof fetch,
        mine,
        pause
      )
    ).toMatchObject({ ok: false, not_served: "fetch failed: down" })
  })

  it("keeps every wait and fetch inside one step's timeout, and long enough for the edge to catch up", async () => {
    // Workflows' default step timeout is 10 minutes per attempt. KV takes up
    // to a minute to reach every location, and the router believes a pointer
    // it read from Postgres for another minute (BELIEVED_FOR).
    const worst =
      (SERVE_TRIES - 1) * SERVE_WAIT_MS + SERVE_TRIES * FETCH_TIMEOUT_MS
    expect(worst).toBeLessThan(10 * 60_000)
    expect((SERVE_TRIES - 1) * SERVE_WAIT_MS).toBeGreaterThanOrEqual(120_000)
    let signal: AbortSignal | undefined
    const asked: string[] = []
    await probeHost("x", null, (async (url: string, init: RequestInit) => {
      asked.push(url)
      signal = init.signal ?? undefined
      return new Response(GOOD_HTML)
    }) as unknown as typeof fetch)
    expect(signal).toBeInstanceOf(AbortSignal)
    // Local dev probes the local router, on the port its config names.
    const pause = async () => undefined
    const fetcher = (async (url: string) => {
      asked.push(url)
      return new Response(GOOD_HTML)
    }) as unknown as typeof fetch
    await probeHost("x.reme.localhost", null, fetcher, undefined, pause, "3004")
    expect(asked).toEqual(["https://x/", "http://x.reme.localhost:3004/"])
  })

  it("points nothing at an org whose owner deleted their account, and says so for good", async () => {
    const puts: string[] = []
    const db = { execute: async () => [{ open: false }] }
    const reading = {
      withOrg: async (_ctx: unknown, fn: (db: never) => Promise<unknown>) =>
        fn(db as never),
    }
    const env = {
      ROUTES: {
        put: async (key: string) => {
          puts.push(key)
        },
      },
    } as unknown as Env
    await expect(
      writePointer(env, reading as never, "o", "s", "h")
    ).rejects.toMatchObject({ code: "org.closed", errorClass: "resource" })
    expect(puts).toEqual([])
  })

  it("points the host at what Postgres says is live, whatever KV holds, after the read commits", async () => {
    const store = storage()
    const site = "10000001-0000-4000-8000-000000000001"
    const newest = {
      id: "d3",
      siteId: site,
      revisionId: "10000001-0000-4000-8000-000000000003",
      configVersion: 3,
    }
    const db = {
      // `orgOpen`: the org still has its owner.
      execute: async () => [{ open: true }],
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [newest] }) }),
        }),
      }),
    }
    // The KV write waits for the read's transaction to end.
    let open = false
    const puts: boolean[] = []
    const reading = {
      withOrg: async (_ctx: unknown, fn: (db: never) => Promise<unknown>) => {
        open = true
        try {
          return await fn(db as never)
        } finally {
          open = false
        }
      },
    }
    const env = {
      ROUTES: {
        put: async (key: string, value: string) => {
          puts.push(open)
          await store.ROUTES.put(key, value)
        },
      },
    } as unknown as Env
    store.pointers.set("host:h", "not a pointer")
    await writePointer(env, reading as never, site, site, "h")
    expect(puts).toEqual([false])
    expect(JSON.parse(store.pointers.get("host:h") ?? "{}")).toEqual({
      org_id: site,
      site_id: site,
      revision_id: newest.revisionId,
      config_version: 3,
    })
  })

  it("serves an active custom domain on its primary host and redirects the other two there", async () => {
    const store = storage()
    const site = "10000001-0000-4000-8000-000000000001"
    const newest = {
      revisionId: "10000001-0000-4000-8000-000000000003",
      configVersion: 3,
    }
    const db = {
      execute: async () => [{ open: true }],
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => ({
              limit: async () =>
                table === domains
                  ? [{ primaryHost: "sparkleclean.co.uk" }]
                  : [newest],
            }),
          }),
        }),
      }),
    }
    const reading = {
      withOrg: async (_ctx: unknown, fn: (db: never) => Promise<unknown>) =>
        fn(db as never),
    }
    const env = { ROUTES: store.ROUTES } as unknown as Env
    const slug = "sparkle-stg.remeai.co.uk"
    expect(await writePointer(env, reading as never, site, site, slug)).toEqual(
      { host: "sparkleclean.co.uk" }
    )
    const read = (host: string) =>
      JSON.parse(store.pointers.get(`host:${host}`) ?? "null")
    expect(read("sparkleclean.co.uk")).toEqual({
      org_id: site,
      site_id: site,
      revision_id: newest.revisionId,
      config_version: 3,
      canonical_host: "sparkleclean.co.uk",
      origin_host: slug,
    })
    for (const host of ["www.sparkleclean.co.uk", slug]) {
      expect(read(host)).toEqual({ redirect_to: "sparkleclean.co.uk" })
    }
    // Removal drops the domain's two keys; the slug is pointed back after.
    await dropDomainPointers(env, "sparkleclean.co.uk")
    expect([...store.pointers.keys()]).toEqual([`host:${slug}`])
  })

  it("finds a deployment no longer live and records it once, the same way everywhere", async () => {
    const inserted: {
      assignmentId: unknown
      type: string
      payload: unknown
    }[] = []
    const current = [{ id: "d3", revisionId: "v2" }]
    const db = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => current }) }),
        }),
      }),
      insert: () => ({
        values: async (row: (typeof inserted)[number]) => {
          inserted.push(row)
        },
      }),
    }
    const target = { site_id: "s", revision_id: "v2", assignment_id: "a" }
    expect(await stillLive(db as never, "org", target, "d3", "probe 5")).toBe(
      true
    )
    expect(inserted).toEqual([])
    // The same revision, rolled back to under another deployment, is not this one's.
    expect(await stillLive(db as never, "org", target, "d2", "probe 5")).toBe(
      false
    )
    expect(inserted).toEqual([
      expect.objectContaining({
        assignmentId: "a",
        type: "publish.superseded",
        payload: {
          step: "probe 5",
          revision_id: "v2",
          live_deployment_id: "d3",
          live_revision_id: "v2",
        },
      }),
    ])
  })

  it("keeps the routing KV binding inside publish.ts", () => {
    const dir = new URL("../src/", import.meta.url)
    const offenders = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && f !== "publish.ts")
      .filter((f) => /\bROUTES\b/.test(readFileSync(new URL(f, dir), "utf8")))
    expect(offenders).toEqual([])
  })

  it("activates nothing over a deployment other than the one it names", async () => {
    const inserted: unknown[] = []
    const current = [{ id: "d3", revisionId: "v1", configVersion: 3 }]
    // Its own row is not there; the site's newest is another activation's.
    const where = () =>
      Object.assign(Promise.resolve([]), {
        orderBy: () => ({ limit: async () => current }),
      })
    const db = {
      // The site lock, which a fake has no one to share with.
      execute: async () => undefined,
      select: () => ({ from: () => ({ where }) }),
      insert: () => ({
        values: async (row: unknown) => {
          inserted.push(row)
        },
      }),
    }
    expect(
      await activate(db as never, "org", {
        id: "d4",
        siteId: "site",
        revisionId: "v1",
        kind: "rollback",
        over: "d2",
      })
    ).toBeNull()
    expect(inserted).toEqual([])
  })
})

live("the publish workflow", () => {
  /**
   * A review opened on a revision with no passing accessibility check, which
   * `requestReview` no longer does: written the way it writes one, so the
   * approval and the publisher are seen to refuse on their own.
   */
  async function uncheckedReview(store = storage()) {
    const built = await previewed(store, GOOD_HTML, 0, false)
    const { orgId, ids, revisionId } = built
    const [request] = await kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, ids.assignmentId))
      if (!row) throw new Error("gone")
      return db
        .insert(approvals)
        .values({
          orgId,
          assignmentId: row.id,
          requestedByStaffId: row.staffId,
          approverStaffId: row.createdByStaffId,
          actionKind: "site.publish",
          target: { kind: "revision", revision_id: revisionId },
          revisionId,
          rationale: "Publish v1 of the site.",
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning()
    })
    if (!request) throw new Error("no request")
    await advance(kit, ids, "awaiting_review")
    return { ...built, approvalId: request.id }
  }

  it("approves nothing and publishes nothing without a passing accessibility check", async () => {
    const store = storage()
    const { orgId, ids, revisionId, approvalId } = await uncheckedReview(store)
    await expect(
      decideApproval(kit, ids, { revisionId, decidedBy: { kind: "console" } })
    ).rejects.toMatchObject({ code: "revision.a11y_unchecked" })
    expect(await stateOf(ids)).toBe("awaiting_review")
    // Decided anyway, as a row from before the gate moved could be.
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(approvals)
        .set({
          decision: "approved",
          decidedBy: { kind: "console" },
          decidedAt: new Date(),
        })
        .where(eq(approvals.id, approvalId))
    )
    await advance(kit, ids, "release_candidate")
    const { env } = workflowEnv(store)
    const names: string[] = []
    const outcome = await new PublishWorkflow({} as never, env).run(
      { payload: { org_id: orgId, approval_id: approvalId } } as never,
      fakeStep(names)
    )
    expect(outcome).toMatchObject({
      outcome: "refused",
      reason: "the revision has no passing accessibility check",
    })
    expect(names).toEqual(steps.PublishWorkflow.refused)
    expect(store.pointers.size).toBe(0)
  })

  async function approved(store = storage(), html = GOOD_HTML) {
    const built = await previewed(store, html)
    await requestReview(kit, built.ids)
    const { decision } = await decideApproval(kit, built.ids, {
      revisionId: built.revisionId,
      decidedBy: { kind: "console" },
    })
    return { ...built, approvalId: decision.approval_id }
  }

  /** Another build on the same site, approved: its facts are the org's as they stand now. */
  async function approveNext(
    store: ReturnType<typeof storage>,
    orgId: string,
    html = GOOD_HTML
  ) {
    const ids = await newAssignment(kit, orgId)
    for (const to of TO_PREVIEW) await advance(kit, ids, to)
    const revisionId = await addRevision(store, orgId, ids.assignmentId, html)
    await kit.withOrg({ orgId }, (db) => takeSnapshot(db, ids, []))
    await requestReview(kit, ids)
    const { decision } = await decideApproval(kit, ids, {
      revisionId,
      decidedBy: { kind: "console" },
    })
    return { ids, revisionId, approvalId: decision.approval_id }
  }

  const publish = (
    env: Env,
    payload: Record<string, unknown>,
    step: ReturnType<typeof fakeStep> = fakeStep([])
  ) => new PublishWorkflow({} as never, env).run({ payload } as never, step)

  const liveNow = (orgId: string) =>
    kit.withOrg({ orgId }, (db) => activeDeployment(db, orgId))

  const superseded = (orgId: string) =>
    kit.withOrg({ orgId }, (db) =>
      db
        .select()
        .from(events)
        .where(
          sql`${events.orgId} = ${orgId} and ${events.type} = 'publish.superseded'`
        )
    )

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

  it("publishes on local dev to the local router's host, and probes it there", async () => {
    const store = storage()
    const { orgId, revisionId, approvalId } = await approved(store)
    const { env } = workflowEnv(store)
    const local = {
      ...env,
      SITE_HOST_SUFFIX: ".reme.localhost",
      SITE_PORT: "3004",
    } as unknown as Env
    const router = serveFromPointer(store)
    vi.stubGlobal("fetch", router)
    const outcome = await new PublishWorkflow({} as never, local).run(
      { payload: { org_id: orgId, approval_id: approvalId } } as never,
      fakeStep([])
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({ outcome: "published" })
    const host = `state-test-${orgId.slice(0, 8)}.reme.localhost`
    expect(
      JSON.parse(store.pointers.get(`host:${host}`) ?? "{}")
    ).toMatchObject({ revision_id: revisionId })
    expect(new Set(router.mock.calls.map(([input]) => String(input)))).toEqual(
      new Set([`http://${host}:3004/`])
    )
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

  it("stops a late probe once a newer version is live: no alert, no rollback, and the newer one probes itself", async () => {
    const store = storage()
    const first = await approved(store)
    const { orgId } = first
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await publish(env, { org_id: orgId, approval_id: first.approvalId })
    const second = await approveNext(store, orgId)
    // While the second sleeps to minute 5, a third goes live with a price
    // only its own facts hold, as v2 did under v1's probe on a staging run.
    let third: Awaited<ReturnType<typeof approveNext>> | null = null
    const thirdNames: string[] = []
    const names: string[] = []
    const outcome = await publish(
      env,
      { org_id: orgId, approval_id: second.approvalId },
      fakeStep(names, {
        "until minute 5": async () => {
          await kit.withOrg({ orgId }, (db) =>
            supersedeFact(db, {
              orgId,
              key: "pricing.standard_clean_hourly",
              factType: "pricing",
              value: { currency: "USD", amount_minor: 4000 },
              provenance: { source: "owner_stated", confidence: 1 },
            })
          )
          third = await approveNext(
            store,
            orgId,
            GOOD_HTML.replace("$35", "$40")
          )
          await publish(
            env,
            { org_id: orgId, approval_id: third.approvalId },
            fakeStep(thirdNames)
          )
        },
      })
    )
    vi.unstubAllGlobals()
    if (!third) throw new Error("the third version never published")
    const { ids: thirdIds, revisionId: rev3 } = third
    expect(outcome).toMatchObject({
      outcome: "superseded",
      revision_id: second.revisionId,
    })
    expect(names).toEqual(steps.PublishWorkflow.superseded)
    expect(thirdNames).toEqual(steps.PublishWorkflow.publish)
    expect(await eventsOf(thirdIds, "publish.probed")).toHaveLength(4)
    expect(await liveNow(orgId)).toMatchObject({
      kind: "publish",
      revisionId: rev3,
      configVersion: 3,
    })
    const slug = `state-test-${orgId.slice(0, 8)}`
    expect(
      JSON.parse(store.pointers.get(`host:${slug}${SUFFIX}`) ?? "{}")
    ).toMatchObject({ revision_id: rev3, config_version: 3 })
    expect(await eventsOf(second.ids, "alert.raised")).toHaveLength(0)
    expect(await eventsOf(second.ids, "publish.probed")).toHaveLength(2)
    const [event] = await eventsOf(second.ids, "publish.superseded")
    expect(event?.payload).toEqual({
      step: "probe 5",
      revision_id: second.revisionId,
      live_deployment_id: expect.any(String),
      live_revision_id: rev3,
    })
  })

  it("rolls back only over the version its probe checked", async () => {
    const store = storage()
    const first = await approved(store)
    const { orgId } = first
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await publish(env, { org_id: orgId, approval_id: first.approvalId })
    const second = await approveNext(store, orgId)
    // The second's minute-2 probe fails, and a third goes live before its rollback.
    let third: Awaited<ReturnType<typeof approveNext>> | null = null
    let probes = 0
    vi.stubGlobal(
      "fetch",
      serveFromPointer(store, () =>
        ++probes === 2 ? new Response("<html></html>", { status: 200 }) : null
      )
    )
    const names: string[] = []
    const outcome = await publish(
      env,
      { org_id: orgId, approval_id: second.approvalId },
      fakeStep(names, {
        "roll back": async () => {
          third = await approveNext(store, orgId)
          await publish(env, { org_id: orgId, approval_id: third.approvalId })
        },
      })
    )
    vi.unstubAllGlobals()
    if (!third) throw new Error("the third version never published")
    const { revisionId: rev3 } = third
    expect(outcome).toMatchObject({ outcome: "superseded" })
    expect(names).toEqual(steps.PublishWorkflow["rollback superseded"])
    expect(await liveNow(orgId)).toMatchObject({
      kind: "publish",
      revisionId: rev3,
      configVersion: 3,
    })
    expect(await eventsOf(second.ids, "alert.raised")).toHaveLength(0)
    expect(await superseded(orgId)).toMatchObject([
      {
        payload: {
          revision_id: second.revisionId,
          live_revision_id: rev3,
        },
      },
    ])
  })

  it("refuses a rollback request once a newer version is live in place of the one it would replace", async () => {
    const store = storage()
    const first = await approved(store)
    const { orgId } = first
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await publish(env, { org_id: orgId, approval_id: first.approvalId })
    const second = await approveNext(store, orgId)
    await publish(env, { org_id: orgId, approval_id: second.approvalId })
    const third = await approveNext(store, orgId)
    const names: string[] = []
    const outcome = await publish(
      env,
      { org_id: orgId, site_id: orgId, rollback: { key: "k", reason: "x" } },
      fakeStep(names, {
        activate: () =>
          publish(env, { org_id: orgId, approval_id: third.approvalId }),
      })
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({ outcome: "superseded" })
    expect(names).toEqual(steps.PublishWorkflow["rollback request superseded"])
    expect(await liveNow(orgId)).toMatchObject({
      revisionId: third.revisionId,
      configVersion: 3,
    })
    expect(await superseded(orgId)).toMatchObject([
      {
        payload: {
          step: "activate",
          revision_id: first.revisionId,
          live_revision_id: third.revisionId,
        },
      },
    ])
  })

  it("stops probing when its revision is live again under a newer deployment", async () => {
    const store = storage()
    const first = await approved(store)
    const { orgId } = first
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await publish(env, { org_id: orgId, approval_id: first.approvalId })
    const second = await approveNext(store, orgId)
    const names: string[] = []
    // A third goes live and the owner rolls it back, so the second's revision
    // serves again, from the owner's rollback and not from this instance.
    const outcome = await publish(
      env,
      { org_id: orgId, approval_id: second.approvalId },
      fakeStep(names, {
        "until minute 5": async () => {
          const third = await approveNext(store, orgId)
          await publish(env, { org_id: orgId, approval_id: third.approvalId })
          await publish(env, {
            org_id: orgId,
            site_id: orgId,
            rollback: { key: "k", reason: "owner asked" },
          })
        },
      })
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({ outcome: "superseded" })
    expect(names).toEqual(steps.PublishWorkflow.superseded)
    expect(await liveNow(orgId)).toMatchObject({
      kind: "rollback",
      revisionId: second.revisionId,
      configVersion: 4,
    })
    expect(await eventsOf(second.ids, "alert.raised")).toHaveLength(0)
  })

  it("rolls back to what its own activation replaced, not what it read before", async () => {
    const store = storage()
    const first = await approved(store)
    const { orgId } = first
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await publish(env, { org_id: orgId, approval_id: first.approvalId })
    const second = await approveNext(store, orgId)
    await publish(env, { org_id: orgId, approval_id: second.approvalId })
    const third = await approveNext(store, orgId)
    // The owner rolls the second back between this publish reading its
    // target and activating; then this publish's minute-2 probe fails.
    let armed = false
    let probes = 0
    vi.stubGlobal(
      "fetch",
      serveFromPointer(store, () =>
        armed && ++probes === 2
          ? new Response("<html></html>", { status: 200 })
          : null
      )
    )
    const names: string[] = []
    const outcome = await publish(
      env,
      { org_id: orgId, approval_id: third.approvalId },
      fakeStep(names, {
        activate: () =>
          publish(env, {
            org_id: orgId,
            site_id: orgId,
            rollback: { key: "k", reason: "owner asked" },
          }),
        "probe 0": async () => {
          armed = true
        },
      })
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({
      outcome: "rolled_back",
      revision_id: third.revisionId,
    })
    expect(names).toEqual(steps.PublishWorkflow["probe failure rolled back"])
    expect(await liveNow(orgId)).toMatchObject({
      kind: "rollback",
      revisionId: first.revisionId,
      configVersion: 5,
    })
  })

  it("raises no alert for a failed probe once a newer version is live, with nothing earlier to restore", async () => {
    const store = storage()
    const first = await approved(store)
    const { orgId } = first
    const { env } = workflowEnv(store)
    let probes = 0
    vi.stubGlobal(
      "fetch",
      serveFromPointer(store, () =>
        ++probes === 1 ? new Response("<html></html>", { status: 200 }) : null
      )
    )
    const names: string[] = []
    const outcome = await publish(
      env,
      { org_id: orgId, approval_id: first.approvalId },
      fakeStep(names, {
        alert: async () => {
          const second = await approveNext(store, orgId)
          await publish(env, { org_id: orgId, approval_id: second.approvalId })
        },
      })
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({ outcome: "superseded" })
    expect(names).toEqual(steps.PublishWorkflow["alert superseded"])
    expect(await eventsOf(first.ids, "alert.raised")).toHaveLength(0)
    const [event] = await eventsOf(first.ids, "publish.superseded")
    expect(event?.payload).toMatchObject({
      step: "alert",
      revision_id: first.revisionId,
    })
  })

  it("keeps the id it minted when an activation is retried after its result was lost", async () => {
    const store = storage()
    const first = await approved(store)
    const { orgId } = first
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await publish(env, { org_id: orgId, approval_id: first.approvalId })
    const second = await approveNext(store, orgId)
    await publish(env, { org_id: orgId, approval_id: second.approvalId })
    const names: string[] = []
    const outcome = await publish(
      env,
      { org_id: orgId, site_id: orgId, rollback: { key: "k", reason: "x" } },
      fakeStep(names, {}, ["activate"])
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({
      outcome: "published",
      revision_id: first.revisionId,
    })
    expect(names).toEqual(steps.PublishWorkflow.rollback)
    const rows = await kit.withOrg({ orgId }, (db) =>
      db.select().from(deployments).where(eq(deployments.siteId, orgId))
    )
    expect(rows).toHaveLength(3)
  })

  it("alerts on a failed probe with nothing earlier to restore, and says so", async () => {
    const store = storage()
    const first = await approved(store)
    const { env } = workflowEnv(store)
    vi.stubGlobal(
      "fetch",
      serveFromPointer(
        store,
        () => new Response("<html></html>", { status: 200 })
      )
    )
    const names: string[] = []
    const outcome = await publish(
      env,
      { org_id: first.orgId, approval_id: first.approvalId },
      fakeStep(names)
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({ outcome: "alerted" })
    expect(names).toEqual(steps.PublishWorkflow["probe failure alerted"])
    const [alert] = await eventsOf(first.ids, "alert.raised")
    expect(alert?.payload).toMatchObject({ kind: "publish.probe_failed" })
  })

  it("alerts and never rolls back when the router never serves its version", async () => {
    const store = storage()
    const first = await approved(store)
    const { orgId } = first
    const { env } = workflowEnv(store)
    vi.stubGlobal("fetch", serveFromPointer(store))
    await publish(env, { org_id: orgId, approval_id: first.approvalId })
    const second = await approveNext(store, orgId)
    // KV stuck on the first version: every answer carries its tag, and its
    // page would fail the second's facts if it were ever judged.
    const stuck = store.pointers.get(
      `host:state-test-${orgId.slice(0, 8)}${SUFFIX}`
    )
    const { revision_id, config_version } = JSON.parse(stuck ?? "{}")
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("<html></html>", {
          status: 200,
          headers: {
            [SITE_REVISION_HEADER]: `${revision_id}@${config_version}`,
          },
        })
    )
    // The waits between tries, taken at once.
    const wait = setTimeout
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) =>
      wait(fn, ms === 15_000 ? 0 : ms)) as typeof setTimeout)
    const names: string[] = []
    const outcome = await publish(
      env,
      { org_id: orgId, approval_id: second.approvalId },
      fakeStep(names)
    )
    vi.unstubAllGlobals()
    expect(outcome).toMatchObject({ outcome: "unconfirmed" })
    expect(names).toEqual(steps.PublishWorkflow["not served"])
    expect(await liveNow(orgId)).toMatchObject({
      kind: "publish",
      revisionId: second.revisionId,
    })
    const [alert] = await eventsOf(second.ids, "alert.raised")
    expect(alert?.payload).toMatchObject({
      kind: "publish.not_served",
      served: `${revision_id}@${config_version}`,
    })
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
