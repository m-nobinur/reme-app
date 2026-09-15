import type { ErrorEnvelope } from "@workspace/contracts"
import {
  assignments,
  eq,
  events,
  resolveOrgBySlug,
  siteRevisions,
  sql,
  staff,
  type Tenancy,
  tenancy,
  toAssignment,
  toEventEnvelope,
  toSiteRevision,
} from "@workspace/db"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import { bearerAuth } from "hono/bearer-auth"
import { HTTPException } from "hono/http-exception"
import type { AssignmentParams } from "./cloudflare.ts"
import consoleHtml from "./console.html?raw"
import { probe } from "./sandbox.ts"
import { appendEvent, cancel, TransitionError } from "./state.ts"

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
  status: 400 | 401 | 404 | 409 | 503,
  body: Omit<ErrorEnvelope, "occurred_at">
) => c.json(envelope(body), status)

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
app.get("/console", (c) => c.html(consoleHtml))

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
 * FIXME: a test surface, see sandbox.ts. Behind the bearer and the org, and
 * it takes nothing else from the request: the commands are a constant. The
 * result is appended like any other execution, so a probe leaves a trace.
 * Q4 moves the probes into CI and deletes this route.
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
  const key = c.req.header("idempotency-key")?.trim()
  if (!key || key.length > 255) {
    return failure(c, 400, {
      class: "validation",
      code: "idempotency_key.missing",
      message: "This request needs an Idempotency-Key header.",
      detail: {},
    })
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: unknown
    goal?: unknown
    model?: unknown
  }
  const kind = typeof body.kind === "string" ? body.kind : "site.build"
  // Which of the two coding defaults this assignment runs on (the plan's
  // `--model A|B`). Recorded on the log for the spec resolver to read (N2).
  const model = body.model === "B" ? "B" : "A"
  const goal =
    typeof body.goal === "string" && body.goal.trim()
      ? body.goal.trim()
      : "Build the site from the canonical facts."
  if (!/^site\.(build|revise)$/.test(kind)) {
    return failure(c, 400, {
      class: "validation",
      code: "assignment.kind_unknown",
      message: "kind must be site.build or site.revise.",
      detail: { kind },
    })
  }

  const orgId = c.get("orgId")
  const result = await c.get("kit").withOrg({ orgId }, async (db) => {
    const [existing] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.idempotencyKey, key))
    if (existing) return { row: existing, replayed: true }
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
      payload: { kind, model, goal },
    })
    return { row, replayed: false }
  })
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
})

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
      return { row, revisions }
    })
  if (!found) return notFound(c, id)
  return c.json({
    assignment: toAssignment(found.row),
    revisions: found.revisions.map(toSiteRevision),
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
  return c.json({ assignment_id: id, state })
})

/**
 * The routes whose stories have not landed answer 501 with the story that
 * lands them, the way the router's `/api/*` does until ingest exists. The
 * console script and page already post to them, so every later done-when is
 * exercised through the same commands.
 */
const notYet = (story: string, what: string) => (c: Context) =>
  c.json(
    envelope({
      class: "resource",
      code: "route.not_implemented",
      message: `${what} lands with story ${story}.`,
      detail: { story },
    }),
    501
  )
console_.post("/:id/answer", notYet("N3", "Answering an information request"))
console_.post("/:id/steer", notYet("N3", "Steering the running conversation"))
console_.post("/:id/approve", notYet("P3", "Approving a revision"))
console_.post("/rollback", notYet("P3", "Rolling a site back"))

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
