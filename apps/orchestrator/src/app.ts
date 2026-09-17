import {
  type ErrorEnvelope,
  InformationAnswer,
  PreviewClaim,
  type TaintLabel,
} from "@workspace/contracts"
import {
  assignments,
  eq,
  events,
  facts,
  orgs,
  resolveOrgBySlug,
  siteRevisions,
  sql,
  staff,
  supersedeFact,
  type Tenancy,
  tenancy,
  toAssignment,
  toEventEnvelope,
  toFactRecord,
  toSiteRevision,
} from "@workspace/db"
import { init } from "@workspace/facade"
import {
  PREVIEW_TTL_S,
  SCREENSHOTS,
  signPreview,
} from "@workspace/gates/preview"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import { bearerAuth } from "hono/bearer-auth"
import { HTTPException } from "hono/http-exception"
import { Developer } from "./agents/developer.ts"
import { GOAL_MAX, updateFacts } from "./brief.ts"
import type { AssignmentParams } from "./cloudflare.ts"
import consoleHtml from "./console.html?raw"
import {
  activeDeployment,
  decideApproval,
  rejectApproval,
  requestReview,
} from "./publish.ts"
import { publishedSource } from "./revise.ts"
import { probe, sandboxFor } from "./sandbox.ts"
import { previewHost, siteHost } from "./seed.ts"
import {
  appendEvent,
  assignmentCost,
  cancel,
  TransitionError,
} from "./state.ts"

/**
 * The console routes (M3 drives them). A bearer secret is the whole of the
 * auth for now; the owner screens reach these over a service binding later
 * and never with a session. Every business is addressed by its slug, resolved
 * server-side to an org id the way the api resolves a session (R3): nothing
 * here reads an org id from a request.
 */

/** R4: every failure leaves as the §28.1 envelope. */
const envelope = (body: Omit<ErrorEnvelope, "occurred_at">): ErrorEnvelope => ({
  ...body,
  occurred_at: new Date().toISOString(),
})

const failure = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 503,
  body: Omit<ErrorEnvelope, "occurred_at">
) => c.json(envelope(body), status)

/** §13.1: every console call that makes something carries an Idempotency-Key. */
const idempotencyKey = (c: Context) => {
  const key = c.req.header("idempotency-key")?.trim()
  return key && key.length <= 255 ? key : null
}

const keyMissing = (c: Context) =>
  failure(c, 400, {
    class: "validation",
    code: "idempotency_key.missing",
    message: "This request needs an Idempotency-Key header.",
    detail: {},
  })

const unauthenticated = () =>
  envelope({
    class: "permission",
    code: "console.unauthenticated",
    message: "This request carries no console bearer we accept.",
    detail: {},
  })

type Bindings = Env
type Variables = { kit: Tenancy; orgId: string }
type ConsoleEnv = { Bindings: Bindings; Variables: Variables }

const app = new Hono<ConsoleEnv>()

app.get("/health", (c) => c.json({ status: "ok" }))

// FIXME: a test surface, see the comment at the top of console.html. Delete
// with it once the owner screens read these routes.
app.get("/console", (c) =>
  c.html(consoleHtml, 200, {
    // The page's own script and style are inline; it fetches only this origin.
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  })
)

/** The console, mounted at `/assignments` below. */
const console_ = new Hono<ConsoleEnv>({ strict: false })

// `bearerAuth` compares in constant time. A Worker with no token configured
// refuses everything rather than accepting everything: fail closed.
console_.use("*", async (c, next) => {
  if (!c.env.ORCHESTRATOR_TOKEN) {
    return failure(c, 503, {
      class: "resource",
      code: "console.unconfigured",
      message: "ORCHESTRATOR_TOKEN is not set on this Worker.",
      detail: {},
    })
  }
  // `bearerAuth` is typed against Hono's default environment; the cast is
  // the only way to run it inside a typed middleware.
  const guard = bearerAuth({
    token: c.env.ORCHESTRATOR_TOKEN,
    noAuthenticationHeaderMessage: unauthenticated,
    invalidAuthenticationHeaderMessage: unauthenticated,
    invalidTokenMessage: unauthenticated,
  }) as unknown as MiddlewareHandler<ConsoleEnv>
  return guard(c, next)
})

/** A tenancy kit per request, closed after the response (the api's shape). */
console_.use("*", async (c, next) => {
  const kit = tenancy(c.env.HYPERDRIVE.connectionString)
  c.set("kit", kit)
  try {
    await next()
  } finally {
    // Outside a Worker (the route test) there is no execution context.
    let ctx: { waitUntil: (promise: Promise<unknown>) => void } | null = null
    try {
      ctx = c.executionCtx
    } catch {
      ctx = null
    }
    if (ctx) ctx.waitUntil(kit.close())
    else await kit.close()
  }
})

/** `?org=<slug>` on every console call; resolved here and nowhere else. */
console_.use("*", async (c, next) => {
  const slug = c.req.query("org")?.trim()
  const orgId = slug ? await resolveOrgBySlug(c.get("kit"), slug) : null
  if (!orgId) {
    return failure(c, 404, {
      class: "resource",
      code: "org.unresolved",
      message: "No business we hold answers to that slug.",
      detail: {},
    })
  }
  c.set("orgId", orgId)
  await next()
})

/**
 * The live sandbox probe the staging deploy runs, see sandbox.ts. Behind the
 * bearer and the org, and it takes nothing else from the request: the
 * commands are a constant. The result is appended like any other execution,
 * so a probe leaves a trace.
 */
console_.get("/sandbox/probe", async (c) => {
  const orgId = c.get("orgId")
  const result = await probe(c.env, orgId)
  await c.get("kit").withOrg({ orgId }, (db) =>
    appendEvent(db, {
      orgId,
      assignmentId: null,
      staffId: null,
      type: "sandbox.probed",
      payload: result,
    })
  )
  return c.json(result)
})

console_.get("/", async (c) => {
  const rows = await c
    .get("kit")
    .withOrg({ orgId: c.get("orgId") }, (db) =>
      db
        .select()
        .from(assignments)
        .orderBy(sql`${assignments.createdAt} desc`)
        .limit(50)
    )
  return c.json({ assignments: rows.map(toAssignment) })
})

/**
 * §13.1: an `Idempotency-Key` is required and a duplicate replays the row it
 * made. `staff_id` is the org's Developer and `created_by_staff_id` its Chief
 * of Staff, by staff code, because that is who the console stands in for.
 */
console_.post("/", async (c) => {
  const key = idempotencyKey(c)
  if (!key) return keyMissing(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: unknown
    goal?: unknown
    model?: unknown
    withhold?: unknown
  }
  const kind = typeof body.kind === "string" ? body.kind : "site.build"
  // Which of the two coding defaults this assignment runs on (the plan's
  // `--model A|B`). Recorded on the log for the spec resolver to read (N2).
  const model = body.model === "B" ? "B" : "A"
  // FIXME: a test knob, like console.html. Fact keys left out of the
  // snapshot so a run has to ask for them; the Developer story's withheld
  // phone run is the one user. Delete with the console.
  const withhold = Array.isArray(body.withhold)
    ? body.withhold.filter((k): k is string => typeof k === "string")
    : []
  if (!/^site\.(build|revise)$/.test(kind)) {
    return failure(c, 400, {
      class: "validation",
      code: "assignment.kind_unknown",
      message: "kind must be site.build or site.revise.",
      detail: { kind },
    })
  }
  const text = typeof body.goal === "string" ? body.goal.trim() : ""
  // A revise is its change request; a build has a default brief.
  if (kind === "site.revise" && !text) {
    return failure(c, 400, {
      class: "validation",
      code: "change_request.empty",
      message: "A revise carries the change request as its goal.",
      detail: {},
    })
  }
  const goal = text || "Build the site from the canonical facts."
  // The goal is rendered into the Developer's instructions on every turn.
  if (goal.length > GOAL_MAX) {
    return failure(c, 400, {
      class: "validation",
      code: "goal.too_long",
      message: `A goal is at most ${GOAL_MAX} characters.`,
      detail: { length: goal.length, max: GOAL_MAX },
    })
  }
  return createAssignment(c, key, { kind, goal, model, withhold })
})

/**
 * The row, its `assignment.created` event and the instance, replayed by
 * idempotency key. A `site.revise` names the build whose revision the site
 * serves as `revision_of_assignment_id`, derived here and never sent, and
 * its goal is the owner's change request, tainted as untrusted input (§28.3).
 */
async function createAssignment(
  c: Context<ConsoleEnv>,
  key: string,
  input: {
    kind: string
    goal: string
    model: "A" | "B"
    withhold: string[]
  }
) {
  const { kind, goal, model, withhold } = input
  const taint: TaintLabel[] = kind === "site.revise" ? ["untrusted_input"] : []
  const orgId = c.get("orgId")
  const result = await c.get("kit").withOrg({ orgId }, async (db) => {
    const [existing] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.idempotencyKey, key))
    if (existing) return { row: existing, replayed: true }
    const source =
      kind === "site.revise" ? await publishedSource(db, orgId) : null
    if (kind === "site.revise" && !source) return { unpublished: true as const }
    const codes = await db
      .select({ id: staff.id, code: staff.staffCode })
      .from(staff)
      .where(sql`${staff.staffCode} in ('DEV-001', 'COS-001')`)
    const developer = codes.find((s) => s.code === "DEV-001")
    const chief = codes.find((s) => s.code === "COS-001")
    if (!developer || !chief) return { missing: true as const }
    const [row] = await db
      .insert(assignments)
      .values({
        orgId,
        staffId: developer.id,
        createdByStaffId: chief.id,
        kind,
        goal,
        revisionOfAssignmentId: source?.assignment_id ?? null,
        acceptanceCriteria: [
          "Every price, hour and service area on the site matches a canonical fact",
          "The site builds and every gate passes",
        ],
        // The snapshot id is a placeholder until the resolver exists (N2);
        // the stub Developer reads no facts.
        factSnapshotId: crypto.randomUUID(),
        packRefs: [{ key: "cleaning", version: "0.1.0" }],
        budgetUsd: 5,
        idempotencyKey: key,
      })
      .returning()
    if (!row) throw new Error("insert returned no row")
    await appendEvent(db, {
      orgId,
      assignmentId: row.id,
      staffId: chief.id,
      type: "assignment.created",
      payload: {
        kind,
        model,
        goal,
        withhold,
        ...(source ? { revises_revision_id: source.revision_id } : {}),
      },
      taint,
    })
    return { row, replayed: false }
  })
  if ("unpublished" in result) {
    return failure(c, 409, {
      class: "validation",
      code: "site.not_published",
      message: "This site has no published revision to revise.",
      detail: {},
    })
  }
  if ("missing" in result) {
    return failure(c, 409, {
      class: "validation",
      code: "staff.developer_missing",
      message: "This business has no DEV-001 and COS-001 staff rows.",
      detail: {},
    })
  }
  if (!result.replayed) await start(c, result.row.id, orgId)
  return c.json(toAssignment(result.row), result.replayed ? 200 : 201)
}

/**
 * Create the instance for a row, with the assignment id as the instance id so
 * a second create is refused by Workflows rather than run twice. The row
 * records the instance once it exists; a `queued` row with none is the
 * reconcile case `POST /:id/start` covers.
 */
async function start(
  c: Context<ConsoleEnv>,
  assignmentId: string,
  orgId: string
) {
  const params: AssignmentParams = {
    assignment_id: assignmentId,
    org_id: orgId,
  }
  const instance = await c.env.ASSIGNMENTS.create({ id: assignmentId, params })
  await c
    .get("kit")
    .withOrg({ orgId }, (db) =>
      db
        .update(assignments)
        .set({ workflowInstanceId: instance.id })
        .where(eq(assignments.id, assignmentId))
    )
}

console_.post("/:id/start", async (c) => {
  const id = c.req.param("id")
  const orgId = c.get("orgId")
  const [row] = await c
    .get("kit")
    .withOrg({ orgId }, (db) =>
      db.select().from(assignments).where(eq(assignments.id, id))
    )
  if (!row) return notFound(c, id)
  if (row.state !== "queued" || row.workflowInstanceId) {
    return c.json(toAssignment(row), 200)
  }
  await start(c, row.id, orgId)
  return c.json(toAssignment(row), 202)
})

/** The org's current facts, for the console to show and edit. Before `/:id`, which would take the path. */
console_.get("/facts", async (c) => {
  const rows = await c
    .get("kit")
    .withOrg({ orgId: c.get("orgId") }, (db) =>
      db
        .select()
        .from(facts)
        .where(sql`${facts.validTo} is null`)
        .orderBy(facts.key)
    )
  return c.json({ facts: rows.map(toFactRecord) })
})

/** The most facts one call restates, and the longest value as JSON text. */
const FACTS_MAX = 20
const FACT_VALUE_MAX = 1000

/**
 * The console restating facts the org holds (architect ruling on the
 * console). `updateFacts` owns the rules; this route owns the request's shape.
 */
console_.post("/facts", async (c) => {
  const key = idempotencyKey(c)
  if (!key) return keyMissing(c)
  const body = (await c.req.json().catch(() => ({}))) as { facts?: unknown }
  const changes = (Array.isArray(body.facts) ? body.facts : []) as {
    key?: unknown
    value?: unknown
  }[]
  const wellFormed =
    changes.length > 0 &&
    changes.length <= FACTS_MAX &&
    new Set(changes.map((f) => f?.key)).size === changes.length &&
    changes.every(
      (f) =>
        typeof f?.key === "string" &&
        f.key.length > 0 &&
        f.key.length <= 100 &&
        f.value !== undefined &&
        JSON.stringify(f.value).length <= FACT_VALUE_MAX
    )
  if (!wellFormed) {
    return failure(c, 400, {
      class: "validation",
      code: "facts.malformed",
      message: `Name 1 to ${FACTS_MAX} distinct fact keys, each with a value of at most ${FACT_VALUE_MAX} characters as JSON.`,
      detail: {},
    })
  }
  const orgId = c.get("orgId")
  const result = await c.get("kit").withOrg({ orgId }, (db) =>
    updateFacts(db, {
      orgId,
      idempotencyKey: key,
      changes: changes as { key: string; value: unknown }[],
    })
  )
  if (result.outcome === "unknown_key") {
    return failure(c, 404, {
      class: "resource",
      code: "fact.not_found",
      message:
        "This business holds no fact with that key; the console only restates facts it holds.",
      detail: { key: result.key },
    })
  }
  if (result.outcome === "shape_changed") {
    return failure(c, 400, {
      class: "validation",
      code: "fact.shape_changed",
      message: "A fact keeps the shape of its current value.",
      detail: { key: result.key },
    })
  }
  return c.json({ facts: result.facts }, result.replayed ? 200 : 201)
})

/** What the site serves now, and what a rollback would restore (ADR-032). Before `/:id`, which would take the path. */
console_.get("/site", async (c) => {
  const orgId = c.get("orgId")
  const found = await c.get("kit").withOrg({ orgId }, async (db) => {
    const [org] = await db
      .select({ slug: orgs.slug })
      .from(orgs)
      .where(eq(orgs.id, orgId))
    const active = await activeDeployment(db, orgId)
    const revisionIds = [active?.revisionId, active?.previousRevisionId].filter(
      (id): id is string => typeof id === "string"
    )
    const revisions =
      revisionIds.length === 0
        ? []
        : await db
            .select()
            .from(siteRevisions)
            .where(
              sql`${siteRevisions.id} in (${sql.join(
                revisionIds.map((id) => sql`${id}`),
                sql`, `
              )})`
            )
    return { slug: org?.slug ?? null, active, revisions }
  })
  const byId = new Map(found.revisions.map((r) => [r.id, toSiteRevision(r)]))
  return c.json({
    host: found.slug ? siteHost(found.slug, c.env.SITE_HOST_SUFFIX) : null,
    config_version: found.active?.configVersion ?? null,
    active: found.active ? (byId.get(found.active.revisionId) ?? null) : null,
    previous: found.active?.previousRevisionId
      ? (byId.get(found.active.previousRevisionId) ?? null)
      : null,
  })
})

console_.get("/:id", async (c) => {
  const id = c.req.param("id")
  const found = await c
    .get("kit")
    .withOrg({ orgId: c.get("orgId") }, async (db) => {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, id))
      if (!row) return null
      const revisions = await db
        .select()
        .from(siteRevisions)
        .where(eq(siteRevisions.assignmentId, id))
        .orderBy(sql`${siteRevisions.version} desc`)
      return { row, revisions, cost: await assignmentCost(db, id) }
    })
  if (!found) return notFound(c, id)
  // The log's sum, live, so an open run shows what it has spent so far; the
  // row's `cost_usd` is the same sum frozen when the assignment closed.
  return c.json({
    assignment: toAssignment(found.row),
    revisions: found.revisions.map(toSiteRevision),
    cost_usd: found.cost,
    cost_usd_at_close: found.row.costUsd,
  })
})

/** The stream, in append order (ULIDs sort by time), so a person can read it. */
console_.get("/:id/events", async (c) => {
  const id = c.req.param("id")
  const rows = await c
    .get("kit")
    .withOrg({ orgId: c.get("orgId") }, (db) =>
      db
        .select()
        .from(events)
        .where(eq(events.assignmentId, id))
        .orderBy(events.eventId)
    )
  return c.json({ events: rows.map(toEventEnvelope) })
})

/**
 * Cancel: the row first, then the instance. Terminating an instance that is
 * already finished or was never created is success, not an error (R5).
 */
console_.post("/:id/cancel", async (c) => {
  const id = c.req.param("id")
  const ids = { orgId: c.get("orgId"), assignmentId: id }
  let state: string
  try {
    state = await cancel(c.get("kit"), ids)
  } catch (error) {
    if (
      error instanceof TransitionError &&
      error.code === "assignment.not_found"
    ) {
      return notFound(c, id)
    }
    throw error
  }
  try {
    const instance = await c.env.ASSIGNMENTS.get(id)
    await instance.terminate()
  } catch {
    // No instance, or one that already settled. The row is what counts.
  }
  try {
    // §13 rule 3: a cancelled assignment's container does not outlive it.
    await sandboxFor(c.env, id).destroy()
  } catch {
    // Never started, or already gone.
  }
  return c.json({ assignment_id: id, state })
})

/**
 * §7.2, as the CoS would do it: the answer becomes a canonical fact with
 * `owner_stated` provenance, then an `information.answered` row, then the
 * Workflow is woken with the ids (architect ruling 8: fact, then event, then
 * signal). The Developer sees the fact record, never "the owner said".
 */
console_.post("/:id/answer", async (c) => {
  const id = c.req.param("id")
  const orgId = c.get("orgId")
  const body = (await c.req.json().catch(() => ({}))) as {
    request_id?: unknown
    value?: unknown
  }
  if (typeof body.request_id !== "string" || body.value === undefined) {
    return failure(c, 400, {
      class: "validation",
      code: "answer.malformed",
      message: "An answer names a request_id and carries a value.",
      detail: {},
    })
  }
  const requestId = body.request_id
  const value = parseValue(body.value)
  const result = await c.get("kit").withOrg({ orgId }, async (db) => {
    const [row] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, id))
    if (!row) return { missing: true as const }
    if (row.state !== "blocked_on_information") {
      return { state: row.state }
    }
    const [request] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        sql`${events.assignmentId} = ${id} and ${events.type} = 'information.requested' and ${events.payload}->>'request_id' = ${requestId}`
      )
      .limit(1)
    const field = request?.payload.field
    if (typeof field !== "string") return { no_request: true as const }
    const [existing] = await db
      .select({ factType: facts.factType })
      .from(facts)
      .where(sql`${facts.key} = ${field} and ${facts.validTo} is null`)
    const written = await supersedeFact(db, {
      orgId,
      key: field,
      factType: existing?.factType ?? field.split(".")[0] ?? "answer",
      value,
      provenance: {
        source: "owner_stated",
        confidence: 1,
        verifiedByStaffId: row.createdByStaffId,
      },
    })
    const answer = InformationAnswer.parse({
      answer_id: crypto.randomUUID(),
      org_id: orgId,
      assignment_id: id,
      request_id: requestId,
      fact_id: written.factId,
      answered_at: new Date().toISOString(),
    })
    await appendEvent(db, {
      orgId,
      assignmentId: id,
      staffId: row.createdByStaffId,
      type: "information.answered",
      payload: answer,
    })
    return { answer }
  })
  if ("missing" in result) return notFound(c, id)
  if ("no_request" in result) {
    return failure(c, 404, {
      class: "resource",
      code: "request.not_found",
      message: "No open information request with that id on this assignment.",
      detail: { request_id: requestId },
    })
  }
  if ("state" in result) {
    return failure(c, 409, {
      class: "validation",
      code: "assignment.not_waiting",
      message: "This assignment is not waiting for information.",
      detail: { state: result.state },
    })
  }
  const instance = await c.env.ASSIGNMENTS.get(id)
  await instance.sendEvent({
    type: "answer",
    payload: { request_id: requestId, fact_id: result.answer.fact_id },
  })
  return c.json(result.answer, 202)
})

/** A message into the running conversation; flue joins it at the next turn boundary. */
console_.post("/:id/steer", async (c) => {
  const id = c.req.param("id")
  const orgId = c.get("orgId")
  const body = (await c.req.json().catch(() => ({}))) as { message?: unknown }
  const message = typeof body.message === "string" ? body.message.trim() : ""
  if (!message) {
    return failure(c, 400, {
      class: "validation",
      code: "steer.empty",
      message: "A steer carries a message.",
      detail: {},
    })
  }
  const row = await c.get("kit").withOrg({ orgId }, async (db) => {
    const [found] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, id))
    if (!found) return null
    await appendEvent(db, {
      orgId,
      assignmentId: id,
      staffId: found.createdByStaffId,
      type: "assignment.steered",
      payload: { message },
    })
    return found
  })
  if (!row) return notFound(c, id)
  const receipt = await init(Developer, { id }).dispatch({
    message: { kind: "user", body: message },
  })
  return c.json({ assignment_id: id, submission_id: receipt.submissionId }, 202)
})

/** A console value: JSON when it parses, the text itself otherwise. */
function parseValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
/**
 * A preview link for the assignment's latest revision (ADR-032): a
 * `PreviewClaim` signed over the org this route resolved, the site and
 * revision it found and the one host the router will honour it on,
 * `preview-v{n}-{slug}` under this environment's suffix (ADR-030), good for
 * a day. A revision still `building` has no artifact to show and is refused.
 */
console_.get("/:id/preview", async (c) => {
  const id = c.req.param("id")
  if (!c.env.PREVIEW_KEY) {
    return failure(c, 503, {
      class: "resource",
      code: "preview.unconfigured",
      message: "PREVIEW_KEY is not set on this Worker.",
      detail: {},
    })
  }
  const orgId = c.get("orgId")
  const found = await c.get("kit").withOrg({ orgId }, async (db) => {
    const [revision] = await db
      .select({
        id: siteRevisions.id,
        siteId: siteRevisions.siteId,
        version: siteRevisions.version,
        status: siteRevisions.status,
      })
      .from(siteRevisions)
      .where(eq(siteRevisions.assignmentId, id))
      .orderBy(sql`${siteRevisions.version} desc`)
      .limit(1)
    if (!revision) return null
    const [org] = await db
      .select({ slug: orgs.slug })
      .from(orgs)
      .where(eq(orgs.id, orgId))
    if (!org) return null
    return { revision, slug: org.slug }
  })
  if (!found) return notFound(c, id)
  if (found.revision.status === "building") {
    return failure(c, 409, {
      class: "validation",
      code: "revision.building",
      message: "This revision has no artifact to preview yet.",
      detail: { revision_id: found.revision.id },
    })
  }
  const host = previewHost(
    found.slug,
    found.revision.version,
    c.env.SITE_HOST_SUFFIX
  )
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_S
  const token = await signPreview(
    PreviewClaim.parse({
      org_id: orgId,
      site_id: found.revision.siteId,
      revision_id: found.revision.id,
      host,
      exp,
    }),
    c.env.PREVIEW_KEY
  )
  const base = `https://${host}`
  return c.json({
    revision_id: found.revision.id,
    url: `${base}/open?t=${token}`,
    screenshots: [...SCREENSHOTS].map((s) => `${base}/${s}`),
    expires_at: new Date(exp * 1000).toISOString(),
  })
})

/** A refusal from the publisher's rules, as the envelope, or null when it was something else. */
function refused(c: Context, error: unknown) {
  if (!(error instanceof TransitionError)) return null
  if (error.code === "assignment.not_found") {
    return failure(c, 404, {
      class: "resource",
      code: error.code,
      message: "No assignment with that id in this business.",
      detail: {},
    })
  }
  if (error.errorClass === "validation") {
    return failure(c, 409, {
      class: "validation",
      code: error.code,
      message: error.message,
      detail: {},
    })
  }
  return null
}

/**
 * `POST /:id/review` (ADR-032): the build goes in front of an owner. The
 * request is recorded for the latest preview revision and expires in 72
 * hours; nothing publishes until someone decides.
 */
console_.post("/:id/review", async (c) => {
  const key = idempotencyKey(c)
  if (!key) return keyMissing(c)
  const ids = { orgId: c.get("orgId"), assignmentId: c.req.param("id") }
  try {
    const { request, replayed } = await requestReview(c.get("kit"), ids)
    return c.json(request, replayed ? 200 : 201)
  } catch (error) {
    return refused(c, error) ?? Promise.reject(error)
  }
})

/**
 * `POST /:id/approve` (ADR-032): the console deciding as the owner would,
 * which only a Worker with `CONSOLE_APPROVALS=allow` accepts. The revision
 * named must be the one the review was requested for; the decision and the
 * move to `release_candidate` share a transaction, and the publish is its
 * own Workflow keyed by the approval id, so a second create is refused.
 */
console_.post("/:id/approve", async (c) => {
  const key = idempotencyKey(c)
  if (!key) return keyMissing(c)
  if (c.env.CONSOLE_APPROVALS !== "allow") {
    return failure(c, 403, {
      class: "permission",
      code: "approval.console_forbidden",
      message: "This Worker does not accept approvals from the console.",
      detail: {},
    })
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    revision_id?: unknown
  }
  if (typeof body.revision_id !== "string" || !body.revision_id) {
    return failure(c, 400, {
      class: "validation",
      code: "approval.malformed",
      message: "An approval names the revision_id the reviewer saw.",
      detail: {},
    })
  }
  const orgId = c.get("orgId")
  const ids = { orgId, assignmentId: c.req.param("id") }
  let decision: Awaited<ReturnType<typeof decideApproval>>
  try {
    decision = await decideApproval(c.get("kit"), ids, {
      revisionId: body.revision_id,
      decidedBy: { kind: "console" },
    })
  } catch (error) {
    const answer = refused(c, error)
    if (answer) return answer
    throw error
  }
  const approvalId = decision.decision.approval_id
  try {
    await c.env.PUBLISHES.create({
      id: approvalId,
      params: { org_id: orgId, approval_id: approvalId },
    })
  } catch {
    // Already created: the approval id is the instance id (ADR-032).
  }
  return c.json(
    { ...decision.decision, workflow_instance_id: approvalId },
    decision.replayed ? 200 : 202
  )
})

/**
 * `POST /:id/reject`: the other answer to a review. The build ends
 * `cancelled`, which frees the site for a fresh build, and its candidate
 * enters the seven-day window. Same target check as approve; no console
 * gate, since nothing publishes.
 */
console_.post("/:id/reject", async (c) => {
  const key = idempotencyKey(c)
  if (!key) return keyMissing(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    revision_id?: unknown
  }
  if (typeof body.revision_id !== "string" || !body.revision_id) {
    return failure(c, 400, {
      class: "validation",
      code: "approval.malformed",
      message: "A rejection names the revision_id the reviewer saw.",
      detail: {},
    })
  }
  const ids = { orgId: c.get("orgId"), assignmentId: c.req.param("id") }
  try {
    const { decision, replayed } = await rejectApproval(c.get("kit"), ids, {
      revisionId: body.revision_id,
      decidedBy: { kind: "console" },
    })
    return c.json(decision, replayed ? 200 : 201)
  } catch (error) {
    const answer = refused(c, error)
    if (answer) return answer
    throw error
  }
})

/**
 * `POST /rollback` (ADR-032): activate the previous revision through the
 * publisher, keyed by the idempotency key so a repeated request is one
 * rollback and not two, which would be a roll forward.
 */
console_.post("/rollback", async (c) => {
  const key = idempotencyKey(c)
  if (!key) return keyMissing(c)
  const orgId = c.get("orgId")
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown }
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 300)
      : "rolled back from the console"
  const active = await c
    .get("kit")
    .withOrg({ orgId }, (db) => activeDeployment(db, orgId))
  if (!active?.previousRevisionId) {
    return failure(c, 409, {
      class: "validation",
      code: "rollback.nothing_previous",
      message: "This site has no previous revision to roll back to.",
      detail: {},
    })
  }
  const id = `rollback-${key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`
  let created = true
  try {
    await c.env.PUBLISHES.create({
      id,
      params: { org_id: orgId, site_id: orgId, rollback: { key, reason } },
    })
  } catch {
    created = false
  }
  return c.json(
    {
      workflow_instance_id: id,
      target_revision_id: active.previousRevisionId,
      from_revision_id: active.revisionId,
    },
    created ? 202 : 200
  )
})

function notFound(c: Context, id: string) {
  return failure(c, 404, {
    class: "resource",
    code: "assignment.not_found",
    message: "No assignment with that id in this business.",
    detail: { assignment_id: id },
  })
}

app.route("/assignments", console_)

app.onError((error, c) => {
  // `bearerAuth` refuses with an exception that carries its own typed 401.
  if (error instanceof HTTPException) return error.getResponse()
  console.error(
    JSON.stringify({
      at: new URL(c.req.url).pathname,
      code: (error as { code?: string }).code ?? error.name,
    })
  )
  return failure(c, 503, {
    class: "transient",
    code: "request.failed",
    message: "The request could not be completed.",
    detail: {},
  })
})

export default app
