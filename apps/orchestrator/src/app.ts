import {
  type BuildLane,
  BuildSummary,
  type ChangeKind,
  type EnvelopeBody,
  envelope,
  GetSearchPerformanceInput,
  GOAL_MAX,
  InformationAnswer,
  idempotencyKey,
  KEY_MISSING,
  OWNER_BRIDGE_HEADERS,
  PreviewClaim,
  previewHost,
  REQUEST_FAILED,
  siteHost,
  siteUrl,
  type TaintLabel,
  TERMINAL_STATES,
  Uuid,
} from "@workspace/contracts"
import {
  appendEvent,
  assignments,
  currentFacts,
  eq,
  events,
  facts,
  logFailure,
  type OrgScopedDb,
  orgs,
  resolveOrgBySlug,
  STAFF_CODE,
  siteRevisions,
  sql,
  staff,
  steerByKey,
  steerKeyHash,
  type Tenancy,
  tenancy,
  toAssignment,
  toEventEnvelope,
  toFactRecord,
  toSiteRevision,
  waitedOn,
} from "@workspace/db"
import {
  canonical,
  getAgentInstance,
  init,
  SubmissionConflictError,
} from "@workspace/facade"
import {
  PREVIEW_TTL_S,
  SCREENSHOTS,
  signPreview,
} from "@workspace/gates/preview"
import {
  type Context,
  type ErrorHandler,
  Hono,
  type MiddlewareHandler,
  type NotFoundHandler,
} from "hono"
import { bearerAuth } from "hono/bearer-auth"
import { HTTPException } from "hono/http-exception"
import { Developer } from "./agents/developer.ts"
import { creationChoices, hideFacts, updateFacts } from "./brief.ts"
import type { AssignmentParams } from "./cloudflare.ts"
import {
  boughtElsewhere,
  buy,
  buyElsewhere,
  checkoutSession,
  find,
  paymentEvent,
} from "./domain-buy.ts"
import {
  checkNow,
  connect,
  inspectDomain,
  type Refusal,
  remove,
  restoreRoutes,
  revokeDomains,
} from "./domain-flow.ts"
import {
  activeDeployment,
  clearPointers,
  type DecidedBy,
  decideApproval,
  rejectApproval,
  requestReview,
} from "./publish.ts"
import { answers } from "./question.ts"
import { pickLane } from "./quick.ts"
import { recordAnswer } from "./relay.ts"
import { holdDraft, publishedSource } from "./revise.ts"
import { endSandbox, endSite, probe } from "./sandbox.ts"
import { passWake, REDRIVE_DELAYS_S, type RedriveMessage } from "./schedule.ts"
import { connectGoogle } from "./search.ts"
import { liveInspect, livePerformance } from "./search-read.ts"
import { disconnectSearch } from "./search-sync.ts"
import { assignmentCost, cancel, lockRow, TransitionError } from "./state.ts"

/**
 * One route tree, two callers (ADR-032 amendment). The console reaches it with
 * a bearer and addresses a business by its slug, resolved here. The owner
 * reaches it only through the `OwnerApi` entrypoint (cloudflare.ts), which a
 * service binding delivers and no public route or domain can name; `apps/api`
 * resolved the org from the sealed session and sends it as a header. Each
 * caller's middleware sets `orgId` and `caller`, and nothing else here reads
 * who is asking from the request.
 */

/** R4: every failure leaves as the §28.1 envelope. */
const failure = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
  body: EnvelopeBody
) => c.json(envelope(body), status)

/** §13.1: every console call that makes something carries an Idempotency-Key. */
const keyMissing = (c: Context) => failure(c, 400, KEY_MISSING)

const unauthenticated = () =>
  envelope({
    class: "permission",
    code: "console.unauthenticated",
    message: "This request carries no console bearer we accept.",
    detail: {},
  })

/**
 * The `revision_id` an approval or a rejection names, or the 400 that says it
 * was not named. Both routes take the same body under the same rule.
 */
const namedRevision = async (
  c: Context,
  noun: "An approval" | "A rejection"
): Promise<string | Response> => {
  const body = (await c.req.json().catch(() => ({}))) as {
    revision_id?: unknown
  }
  if (typeof body.revision_id !== "string" || !body.revision_id) {
    return failure(c, 400, {
      class: "validation",
      code: "approval.malformed",
      message: `${noun} names the revision_id the reviewer saw.`,
      detail: {},
    })
  }
  return body.revision_id
}

type Bindings = Env
type Variables = { kit: Tenancy; orgId: string; caller: DecidedBy }
export type ConsoleEnv = { Bindings: Bindings; Variables: Variables }

const app = new Hono<ConsoleEnv>()

app.get("/health", (c) => c.json({ status: "ok" }))

/**
 * The console's bearer. `bearerAuth` compares in constant time and refuses by
 * throwing its typed 401, before any query. A Worker with no token configured
 * refuses everything rather than accepting everything: fail closed.
 */
async function refuseBearer(c: Context<ConsoleEnv>): Promise<Response | null> {
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
  await guard(c, async () => undefined)
  return null
}

/**
 * The live sandbox probe each deploy runs, see sandbox.ts. Behind the bearer
 * alone, since production holds no org to run it under, and it takes nothing
 * from the request: the commands are a constant. The result goes to Workers
 * Logs, so a probe leaves a trace.
 */
app.get("/sandbox/probe", async (c) => {
  const denied = await refuseBearer(c)
  if (denied) return denied
  const result = await probe(c.env, "console")
  console.log(JSON.stringify({ type: "sandbox.probed", ...result }))
  return c.json(result)
})

/**
 * Staging's custom-domain routes put back after a router deploy wiped them
 * (domain-flow.ts `restoreRoutes`). Behind the bearer alone, since it spans
 * every org and takes nothing from the request. `ok` false means a route
 * call failed and the log line says which.
 */
app.post("/domains/routes", async (c) => {
  const denied = await refuseBearer(c)
  if (denied) return denied
  return c.json(await restoreRoutes(c.env))
})

/** The console: the bearer, then `?org=<slug>` resolved here and nowhere else. */
const consoleAuth: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const denied = await refuseBearer(c)
  if (denied) return denied
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
  c.set("caller", { kind: "console" })
  await next()
}

/**
 * The owner, over the service binding only: `apps/api` resolved the org from
 * the sealed session and builds a new request for every call, so these
 * headers are its and never a browser's. Never reads `?org=` or a bearer.
 */
export const ownerAuth: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const orgId = c.req.header(OWNER_BRIDGE_HEADERS.orgId) ?? ""
  const userId = c.req.header(OWNER_BRIDGE_HEADERS.workosUserId)?.trim()
  const sessionId = c.req.header(OWNER_BRIDGE_HEADERS.sessionId)?.trim()
  if (!Uuid.safeParse(orgId).success || !userId || !sessionId) {
    return failure(c, 401, {
      class: "permission",
      code: "owner.unauthenticated",
      message: "This request carries no owner identity we accept.",
      detail: {},
    })
  }
  c.set("orgId", orgId)
  c.set("caller", {
    kind: "owner_session",
    user_id: userId,
    session_id: sessionId,
  })
  await next()
}

const byOwner = (c: Context<ConsoleEnv>) =>
  c.get("caller").kind === "owner_session"

/** A tenancy kit per request, closed after the response (the api's shape). */
const openKit: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  // `postgres` connects on first query, so opening the kit before the
  // caller's check costs nothing on a refusal.
  const kit = tenancy(c.env.HYPERDRIVE.connectionString)
  c.set("kit", kit)
  try {
    await next()
    await passWake(c.env)
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
}

/**
 * The seven routes that touch a Workflow, the sandbox or `PREVIEW_KEY`, which
 * the owner reaches (architect ruling 3). Owner reads and fact writes run in
 * `apps/api` under `withOrg`.
 */
const bridge = new Hono<ConsoleEnv>()

/** Everything else: the console's alone, and 404 in owner mode. */
const consoleOnly = new Hono<ConsoleEnv>()

/** The owner's alone, and 404 on the console's app: the account's takedown. */
const ownerOnly = new Hono<ConsoleEnv>()

consoleOnly.get("/", async (c) => {
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
bridge.post("/", async (c) => {
  const key = idempotencyKey(c.req.raw)
  if (!key) return keyMissing(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: unknown
    goal?: unknown
    model?: unknown
    withhold?: unknown
    change_kind?: unknown
    draft_revision_id?: unknown
    label?: unknown
  }
  const kind = typeof body.kind === "string" ? body.kind : "site.build"
  // Both are the console's test levers; an owner gets the defaults.
  const owner = byOwner(c)
  // Which of the two coding defaults this assignment runs on (the plan's
  // `--model A|B`). Recorded on the log for the spec resolver to read (N2).
  const model = !owner && body.model === "B" ? "B" : "A"
  // Fact keys left out of the snapshot, so a run has to ask for them. Driven
  // by `scripts/builder.mjs --withhold <key>` and the tier-2 golden builds.
  const withhold =
    !owner && Array.isArray(body.withhold)
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
  const label = BuildSummary.shape.label.safeParse(
    typeof body.label === "string" ? body.label.trim() : undefined
  ).data
  // A change to a site not live yet names the draft it starts from.
  const draft = body.draft_revision_id
  if (
    draft !== undefined &&
    (kind !== "site.revise" || !Uuid.safeParse(draft).success)
  ) {
    return failure(c, 400, {
      class: "validation",
      code: "assignment.draft_invalid",
      message: "draft_revision_id is a revision id, and only on a site.revise.",
      detail: {},
    })
  }
  return createAssignment(c, key, {
    kind,
    goal,
    model,
    withhold,
    ...pickLane(kind, body.change_kind),
    ...(typeof draft === "string" ? { draft } : {}),
    // A label that does not fit is dropped, never a reason to refuse the change.
    ...(label ? { label } : {}),
  })
})

/** Builds an owner may start in 24 hours (open item 76: a guess until someone hits it). */
const OWNER_DAILY_BUILDS = 20

export type NewAssignment = {
  kind: string
  goal: string
  model: "A" | "B"
  withhold: string[]
  lane: BuildLane
  change_kind: ChangeKind | null
  /** The failed build this one starts again (retry.ts), whose plan it keeps. */
  retry_of?: { assignment_id: string; blueprint: unknown }
  /** The owner's draft a change starts from, before the site is live (`holdDraft`). */
  draft?: string
  /** A change's short name in the owner's terms, for the panel and the ready line. */
  label?: string
}

/** The row and its `assignment.created` event, or why not, in the caller's transaction. */
export async function insertAssignment(
  db: OrgScopedDb,
  orgId: string,
  key: string,
  owner: boolean,
  input: NewAssignment
): Promise<
  | { row: typeof assignments.$inferSelect; replayed: boolean }
  | { capped: true }
  | { unpublished: true }
  | { missing: true }
  | { draft_moved: true }
> {
  const { kind, goal, model, withhold, lane, change_kind } = input
  const taint: TaintLabel[] =
    owner || kind === "site.revise" ? ["untrusted_input"] : []
  const [existing] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.idempotencyKey, key))
  if (existing) return { row: existing, replayed: true }
  if (owner) {
    // The owner's own builds only, read off each recent row's created
    // event, so console and harness builds on the org use none of it.
    // ponytail: count-then-insert, so k concurrent creates at 19 can all
    // pass and overshoot by k - 1. An advisory lock per org if that matters.
    const [today] = await db
      .select({ built: sql<number>`count(*)::int` })
      .from(assignments)
      .innerJoin(
        events,
        sql`${events.assignmentId} = ${assignments.id} and ${events.type} = 'assignment.created'`
      )
      .where(
        sql`${assignments.createdAt} > now() - interval '24 hours' and ${events.payload}->>'origin' = 'owner'`
      )
    if ((today?.built ?? 0) >= OWNER_DAILY_BUILDS) {
      return { capped: true as const }
    }
  }
  const codes = await db
    .select({ id: staff.id, code: staff.staffCode })
    .from(staff)
    .where(
      sql`${staff.staffCode} in (${STAFF_CODE.developer}, ${STAFF_CODE.chief})`
    )
  const developer = codes.find((s) => s.code === STAFF_CODE.developer)
  const chief = codes.find((s) => s.code === STAFF_CODE.chief)
  if (!developer || !chief) return { missing: true as const }
  // Last before the insert: holding the draft pauses it in this transaction.
  const source = input.draft
    ? await holdDraft(db, orgId, input.draft)
    : kind === "site.revise"
      ? await publishedSource(db, orgId)
      : null
  if (input.draft && !source) return { draft_moved: true as const }
  if (kind === "site.revise" && !source) return { unpublished: true as const }
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
      // A placeholder: the Workflow's first step takes the snapshot and
      // writes its id here (`takeSnapshot`).
      factSnapshotId: crypto.randomUUID(),
      packRefs: [{ key: "cleaning", version: "0.1.0" }],
      budgetUsd: 20,
      idempotencyKey: key,
      ...(input.retry_of ? { blueprint: input.retry_of.blueprint } : {}),
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
      // The lane is chosen once, here, and read back by the Workflow and EV3.
      lane,
      change_kind,
      origin: owner ? "owner" : "console",
      ...(source ? { revises_revision_id: source.revision_id } : {}),
      ...(input.draft ? { draft_revision_id: input.draft } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.retry_of ? { retry_of: input.retry_of.assignment_id } : {}),
    },
    taint,
  })
  return { row, replayed: false }
}

/**
 * The row, its `assignment.created` event and the instance, replayed by
 * idempotency key. A `site.revise` names the build whose revision the site
 * serves as `revision_of_assignment_id`, derived here and never sent, and
 * its goal is the owner's change request, tainted as untrusted input (§28.3),
 * as is any goal an owner sends.
 * `origin` on the event is who asked, which decides whether the build opens
 * its own review at `preview_ready` (cloudflare.ts).
 */
async function createAssignment(
  c: Context<ConsoleEnv>,
  key: string,
  input: NewAssignment
) {
  const orgId = c.get("orgId")
  const result = await c
    .get("kit")
    .withOrg({ orgId }, (db) =>
      insertAssignment(db, orgId, key, byOwner(c), input)
    )
  if ("unpublished" in result) {
    return failure(c, 409, {
      class: "validation",
      code: "site.not_published",
      message: "This site has no published revision to revise.",
      detail: {},
    })
  }
  if ("capped" in result) {
    return failure(c, 429, {
      class: "budgetary",
      code: "builds.daily_cap",
      message: `A business starts at most ${OWNER_DAILY_BUILDS} builds in 24 hours.`,
      detail: { max: OWNER_DAILY_BUILDS },
    })
  }
  if ("draft_moved" in result) {
    return failure(c, 409, {
      class: "validation",
      code: "change.draft_moved",
      message: "The draft changed while the change was asked for. Ask again.",
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
 * a second create is refused by Workflows rather than run twice. The build
 * is taken once its row commits: a create that throws may still have made
 * the instance, so the row records the id either way, and redrives queued at
 * `REDRIVE_DELAYS_S` start a new instance when that id has none.
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
  await c.env.ASSIGNMENTS.create({ id: assignmentId, params }).catch(
    async (error: unknown) => {
      console.error(
        JSON.stringify({
          code: "assignment.start_failed",
          assignment_id: assignmentId,
          error: error instanceof Error ? error.name : "unknown",
        })
      )
      const redrive: RedriveMessage = { kind: "redrive", orgId }
      await c.env.JOBS.sendBatch(
        REDRIVE_DELAYS_S.map((delaySeconds) => ({
          body: redrive,
          delaySeconds,
        }))
      ).catch(() => undefined)
    }
  )
  await c
    .get("kit")
    .withOrg({ orgId }, (db) =>
      db
        .update(assignments)
        .set({ workflowInstanceId: assignmentId })
        .where(eq(assignments.id, assignmentId))
    )
}

consoleOnly.post("/:id/start", async (c) => {
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
consoleOnly.get("/facts", async (c) => {
  const rows = await c
    .get("kit")
    .withOrg({ orgId: c.get("orgId") }, currentFacts)
  return c.json({ facts: rows.map(toFactRecord) })
})

/** The most facts one call restates, and the longest value as JSON text. */
const FACTS_MAX = 20
const FACT_VALUE_MAX = 1000

/** The refusal a key the org holds no fact for gets, wherever it is named. */
const factNotFound = (c: Context, key: string) =>
  failure(c, 404, {
    class: "resource",
    code: "fact.not_found",
    message:
      "This business holds no fact with that key; the console only restates facts it holds.",
    detail: { key },
  })

/**
 * The console restating facts the org holds (architect ruling on the
 * console). `updateFacts` owns the rules; this route owns the request's shape.
 */
consoleOnly.post("/facts", async (c) => {
  const key = idempotencyKey(c.req.raw)
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
  if (result.outcome === "unknown_key") return factNotFound(c, result.key)
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
consoleOnly.get("/site", async (c) => {
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

/**
 * ADR-033: the facts the owner has asked the site not to show, as the whole
 * set. `hideFacts` owns the rules; this route owns the request's shape. A
 * shorter list shows a fact again and an empty one shows them all, so there
 * is no second verb to undo. Before `/:id`, which would take the path.
 */
consoleOnly.post("/site/hidden", async (c) => {
  const key = idempotencyKey(c.req.raw)
  if (!key) return keyMissing(c)
  const body = (await c.req.json().catch(() => ({}))) as { fact_keys?: unknown }
  const factKeys = body.fact_keys
  const wellFormed =
    Array.isArray(factKeys) &&
    factKeys.length <= FACTS_MAX &&
    new Set(factKeys).size === factKeys.length &&
    factKeys.every(
      (k) => typeof k === "string" && k.length > 0 && k.length <= 100
    )
  if (!wellFormed) {
    return failure(c, 400, {
      class: "validation",
      code: "hidden.malformed",
      message: `Name up to ${FACTS_MAX} distinct fact keys, each of at most 100 characters, as fact_keys.`,
      detail: {},
    })
  }
  const orgId = c.get("orgId")
  const result = await c
    .get("kit")
    .withOrg({ orgId }, (db) =>
      hideFacts(db, { orgId, idempotencyKey: key, factKeys })
    )
  if (result.outcome === "unknown_key") return factNotFound(c, result.key)
  return c.json({ hidden: result.hidden }, result.replayed ? 200 : 201)
})

consoleOnly.get("/:id", async (c) => {
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
        .orderBy(sql`${siteRevisions.createdAt} desc`)
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
consoleOnly.get("/:id/events", async (c) => {
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
bridge.post("/:id/cancel", async (c) => {
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
  await halt(c.env, c.get("orgId"), id)
  return c.json({ assignment_id: id, state })
})

/** A cancelled assignment's instance and container, after its row. */
async function halt(env: Env, orgId: string, id: string) {
  try {
    const instance = await env.ASSIGNMENTS.get(id)
    await instance.terminate()
  } catch {
    // No instance, or one that already settled. The row is what counts.
  }
  try {
    // §13 rule 3: a cancelled assignment's container does not outlive it.
    await endSandbox(env, { orgId, assignmentId: id })
  } catch {
    // Never started, or already gone.
  }
}

/**
 * The owner deleting their account (ADR-035): every open build is cancelled
 * the way `/:id/cancel` does it, then the site's routing pointer goes, so the
 * router asks Postgres and answers 410 for the closed org. The api calls it
 * only after the org reads as closed, so nothing puts the pointer back. Safe
 * to repeat: a second call finds nothing open and deletes a missing key.
 */
ownerOnly.post("/site/takedown", async (c) => {
  const orgId = c.get("orgId")
  const open = await c
    .get("kit")
    .withOrg({ orgId }, (db) =>
      db
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          sql`${assignments.state} not in ('published', 'failed', 'cancelled')`
        )
    )
  for (const { id } of open) {
    await cancel(
      c.get("kit"),
      { orgId, assignmentId: id },
      "the owner deleted their account"
    )
    await halt(c.env, orgId, id)
  }
  // QE2: a published site's sandbox can still be warm with no build open.
  // One per site, which the site lock makes safe, keyed by the org.
  await endSite(c.env, orgId)
  await clearPointers(c.env, c.get("kit"), orgId)
  await revokeDomains(c.env, c.get("kit"), orgId)
  await disconnectSearch(c.env, c.get("kit"), orgId, true)
  return c.body(null, 204)
})

/** A domain route's refusal, as the §28.1 envelope. */
const domainRefused = (c: Context, r: Refusal) =>
  failure(c, r.status, {
    class: r.class,
    code: r.code,
    message: r.message,
    detail: {},
  })

/**
 * Custom domains, connect path (domain-flow.ts): claim a domain and start
 * its Workflow, check it now and nudge the Workflow, or remove it. The org
 * is the bridge's; the name is the only thing the caller says.
 */
ownerOnly.post("/domains", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown
    approval_id?: unknown
    conversation_id?: unknown
  }
  const result = await connect(c.env, c.get("kit"), c.get("orgId"), body)
  if ("refused" in result) return domainRefused(c, result)
  return c.json(result.output, result.status)
})

/**
 * Google Search Console (search.ts): the callback's code traded for the
 * org's sealed refresh token, under the org and the person the bridge named.
 */
ownerOnly.post("/search/connect", async (c) => {
  const caller = c.get("caller")
  const result = await connectGoogle(
    c.env,
    c.get("kit"),
    c.get("orgId"),
    caller.kind === "owner_session" ? caller.user_id : "",
    await c.req.json().catch(() => null)
  )
  if ("refused" in result) {
    return failure(c, result.status, {
      class: result.class,
      code: result.code,
      message: result.message,
      detail: {},
    })
  }
  return c.body(null, 204)
})

/** The owner ending the Google connection (search-sync.ts). Safe to repeat. */
ownerOnly.post("/search/disconnect", async (c) => {
  await disconnectSearch(c.env, c.get("kit"), c.get("orgId"))
  return c.body(null, 204)
})

/**
 * Buying a domain (domain-buy.ts): find names, open a purchase, record the
 * Checkout Session the api made, and apply a Stripe event the api verified.
 */
ownerOnly.post("/domains/find", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const result = await find(c.env, c.get("kit"), c.get("orgId"), body)
  if ("refused" in result) return domainRefused(c, result)
  return c.json(result)
})

ownerOnly.post("/domains/buy", async (c) => {
  const body = await c.req.json().catch(() => null)
  const result = await buy(c.env, c.get("kit"), c.get("orgId"), body)
  if ("refused" in result) return domainRefused(c, result)
  return c.json(result.output, result.status)
})

/** The owner buying a name themselves, and saying they have (domain-buy.ts). */
ownerOnly.post("/domains/elsewhere", async (c) => {
  const body = await c.req.json().catch(() => null)
  const refusal = await buyElsewhere(c.env, c.get("kit"), c.get("orgId"), body)
  if (refusal) return domainRefused(c, refusal)
  return c.body(null, 204)
})

ownerOnly.post("/domains/bought", async (c) => {
  const body = await c.req.json().catch(() => null)
  const result = await boughtElsewhere(
    c.env,
    c.get("kit"),
    c.get("orgId"),
    body
  )
  if ("refused" in result) return domainRefused(c, result)
  return c.json(result.output, result.status)
})

ownerOnly.post("/domains/:id/checkout-session", async (c) => {
  const body = await c.req.json().catch(() => null)
  const refusal = await checkoutSession(
    c.env,
    c.get("kit"),
    c.get("orgId"),
    c.req.param("id"),
    body
  )
  if (refusal) return domainRefused(c, refusal)
  return c.body(null, 204)
})

ownerOnly.post("/domains/:id/stripe", async (c) => {
  const body = await c.req.json().catch(() => null)
  const refusal = await paymentEvent(
    c.env,
    c.get("kit"),
    c.get("orgId"),
    c.req.param("id"),
    body
  )
  if (refusal) return domainRefused(c, refusal)
  return c.body(null, 204)
})

ownerOnly.post("/domains/:name/check", async (c) => {
  const result = await checkNow(
    c.env,
    c.get("kit"),
    c.get("orgId"),
    c.req.param("name"),
    c.req.query("refresh") !== "0"
  )
  if ("refused" in result) return domainRefused(c, result)
  return c.json(result)
})

ownerOnly.get("/domains/:name/inspect", async (c) => {
  const result = await inspectDomain(c.req.param("name"))
  if ("refused" in result) return domainRefused(c, result)
  return c.json(result)
})

/**
 * Live Search Console reads for the Chief of Staff (search-read.ts): the
 * 90-day performance and one page's inspection. Both go to Google through
 * the org's own properties and answer a refusal as the envelope.
 */
ownerOnly.get("/search/performance", async (c) => {
  const input = GetSearchPerformanceInput.safeParse({
    days: Number(c.req.query("days")),
    by: c.req.query("by"),
  })
  if (!input.success) {
    return failure(c, 400, {
      class: "validation",
      code: "search.malformed",
      message: "days is 7, 28 or 90 and by is none, query or page.",
      detail: {},
    })
  }
  const result = await livePerformance(
    c.env,
    c.get("kit"),
    c.get("orgId"),
    input.data
  )
  if ("refused" in result) return domainRefused(c, result)
  return c.json(result)
})

ownerOnly.get("/search/inspect", async (c) => {
  const result = await liveInspect(
    c.env,
    c.get("kit"),
    c.get("orgId"),
    c.req.query("url") ?? ""
  )
  if ("refused" in result) return domainRefused(c, result)
  return c.json(result)
})

ownerOnly.delete("/domains/:name", async (c) => {
  const refusal = await remove(
    c.env,
    c.get("kit"),
    c.get("orgId"),
    c.req.param("name")
  )
  if (refusal) return domainRefused(c, refusal)
  return c.body(null, 204)
})

/**
 * §7.2, as the CoS would do it: the answer becomes a canonical fact with
 * `owner_stated` provenance, then an `information.answered` row, then the
 * Workflow is woken with the ids (architect ruling 8: fact, then event, then
 * signal). The Developer sees the fact record, never "the owner said".
 *
 * An owner's value is checked, never coerced, by `answers`: a `FactValue`
 * key's value in that key's shape, anything else text that fits the
 * question's schema and options (open item 70). The fact is verified by the
 * org's root owner, which is the caller only while an org has one member
 * (open item 71).
 *
 * All under the build's row lock, in this order: a question already
 * answered takes the same value again (its receipt, and a nudge only while
 * the build still waits on it) and refuses another with 409
 * `answer.already_given`; a build not blocked is 409
 * `assignment.not_waiting`; any question but the one it waits on
 * (`waitedOn`) is 404 `request.not_found`. The nudge only tells the
 * Workflow to look; it reads the answer from the database.
 */
bridge.post("/:id/answer", async (c) => {
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
  const owner = byOwner(c)
  // The console's text is read as JSON too, where that is what fits.
  const tried = owner ? [body.value] : [body.value, parseValue(body.value)]
  const result = await c.get("kit").withOrg({ orgId }, async (db) => {
    // Locked first, so two answers to one question queue here and the second
    // finds the first one's answer.
    const [row] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, id))
      .for("update")
    if (!row) return { missing: true as const }
    const blocked = row.state === "blocked_on_information"
    const [waited] = await waitedOn(db, id)
    const current = waited?.request.request_id === requestId
    // The waited-on question's answer came with it; any other question's is
    // looked up, latest first as `waitedOn` takes it.
    const [given] = current
      ? waited.answer
        ? [{ answer: waited.answer, value: waited.value }]
        : []
      : await db.execute<{ answer: Record<string, unknown>; value: unknown }>(
          sql`
          select e.payload as answer, f.value as value
          from ${events} e
          left join ${facts} f on f.id = (e.payload->>'fact_id')::uuid
          where e.assignment_id = ${id}
            and e.type = 'information.answered'
            and e.payload->>'request_id' = ${requestId}
          order by e.event_id desc
          limit 1`
        )
    if (given) {
      // The same answer again is a retry: its receipt, and the Workflow
      // nudged again only while it still waits on this question. A receipt
      // stored in an older shape cannot be given back, so it is refused.
      const same = tried.some((v) => canonical(v) === canonical(given.value))
      const receipt = InformationAnswer.safeParse(given.answer)
      if (!same || !receipt.success) return { given: true as const }
      return { answer: receipt.data, nudge: blocked && current }
    }
    if (!blocked) return { state: row.state }
    const field = waited?.request.field
    if (!current || typeof field !== "string") {
      return { no_request: true as const }
    }
    const question = { ...waited.request, field }
    const value = tried.find((v) => answers(question, v))
    if (value === undefined) return { invalid: field }
    const answer = await recordAnswer(db, {
      orgId,
      assignment: row,
      requestId,
      field,
      given: { value },
      verifier: owner ? "owner" : "maker",
    })
    return { answer, nudge: true }
  })
  if ("missing" in result) return notFound(c, id)
  if ("no_request" in result) {
    return failure(c, 404, {
      class: "resource",
      code: "request.not_found",
      message: "This build is not waiting on that question.",
      detail: { request_id: requestId },
    })
  }
  if ("given" in result) {
    return failure(c, 409, {
      class: "validation",
      code: "answer.already_given",
      message: "That question has been answered.",
      detail: { request_id: requestId },
    })
  }
  if ("invalid" in result) {
    return failure(c, 400, {
      class: "validation",
      code: "answer.invalid",
      message: "That answer is not a value this question accepts.",
      detail: { field: result.invalid },
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
  if (result.nudge) {
    // The answer is committed; a nudge that fails costs only time, since the
    // Workflow looks again within six hours. So it is logged, not surfaced.
    try {
      const instance = await c.env.ASSIGNMENTS.get(id)
      await instance.sendEvent({
        type: "answer",
        payload: { request_id: requestId, fact_id: result.answer.fact_id },
      })
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "answer.nudge_failed",
          assignment_id: id,
          request_id: requestId,
          error: error instanceof Error ? error.name : "unknown",
        })
      )
    }
  }
  return c.json(result.answer, 202)
})

const ENDED =
  "This build has ended and takes no more changes. Ask for the change again."
const ONE_CALL =
  "This quick change is made in one edit and takes no more details. Ask again once it is ready."

/**
 * A message into the running conversation; flue joins it at the next turn
 * boundary. An owner's message is their own words, tainted as a goal is.
 */
bridge.post("/:id/steer", async (c) => {
  const id = c.req.param("id")
  const orgId = c.get("orgId")
  const key = idempotencyKey(c.req.raw)
  if (!key) return keyMissing(c)
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
  // A steer reaches the Developer's conversation like a goal does.
  if (message.length > GOAL_MAX) {
    return failure(c, 400, {
      class: "validation",
      code: "steer.too_long",
      message: `A steer is at most ${GOAL_MAX} characters.`,
      detail: { length: message.length, max: GOAL_MAX },
    })
  }
  const taint: TaintLabel[] = byOwner(c) ? ["untrusted_input"] : []
  const reused = () =>
    failure(c, 409, {
      class: "validation",
      code: "steer.key_reused",
      message: "This Idempotency-Key already carried a different steer.",
      detail: {},
    })
  // Stored under its key's hash, so a retry after a timeout finds it
  // (ADR-034's amendment). The same build, words and caller log nothing new;
  // anything else under the key is another request, and refused.
  const result = await c.get("kit").withOrg({ orgId }, async (db) => {
    // Locked first, so two sends of one key queue here.
    let found: Awaited<ReturnType<typeof lockRow>>
    try {
      found = await lockRow(db, id)
    } catch (error) {
      if (
        error instanceof TransitionError &&
        error.code === "assignment.not_found"
      ) {
        return { missing: true as const }
      }
      throw error
    }
    if (TERMINAL_STATES.includes(found.state)) return { refused: ENDED }
    // Read under the row lock, which the admission's `earlySteers` also takes,
    // so a steer either finds the Developer or is logged before that read.
    const uid = (await getAgentInstance(Developer, id))?.uid
    const held = found.state === "blocked_on_information"
    // A steer never makes a Developer: one made with no brief failed at
    // render and was recovered again and again.
    let early = false
    if (!held && !uid) {
      const { lane, change_kind } = await creationChoices(db, {
        orgId,
        assignmentId: id,
      })
      if (lane === "quick" && change_kind !== "section") {
        return { refused: ONE_CALL }
      }
      early = true
    }
    const steered = await steerByKey(db, key)
    if (steered) {
      const same =
        steered.assignment_id === id &&
        steered.message === message &&
        canonical(steered.taint) === canonical(taint)
      return same
        ? { kept: held || early || steered.early, uid }
        : { reused: true as const }
    }
    await appendEvent(db, {
      orgId,
      assignmentId: id,
      staffId: found.createdByStaffId,
      type: "assignment.steered",
      payload: {
        message,
        key_sha256: steerKeyHash(key),
        ...(early ? { early: true } : {}),
      },
      taint,
    })
    return { kept: held || early, uid }
  })
  if ("missing" in result) return notFound(c, id)
  if ("reused" in result) return reused()
  if (result.refused) {
    return failure(c, 409, {
      class: "validation",
      code: "steer.not_running",
      message: result.refused,
      detail: {},
    })
  }
  // A build waiting on the owner's answer gets the steer with that answer
  // (cloudflare.ts `resume`), and one not yet admitted with its brief
  // (`admit`), so a steer never wakes or makes a Developer.
  const { uid } = result
  if (result.kept || !uid) {
    return c.json({ assignment_id: id, submission_id: null }, 202)
  }
  // An owner's words reach the model the way a change request does: as a
  // tainted signal, never as a user turn (§28.3). The console's stay a turn.
  // Delivered under the same key, so flue admits it once and a replay gets
  // the first receipt back without a second turn.
  let receipt: { submissionId: string }
  try {
    // Continues that incarnation only, so a Developer gone since is never made anew.
    receipt = await init(Developer, { id, uid }).dispatch({
      message: byOwner(c)
        ? {
            kind: "signal",
            type: "site.change_requested",
            body: message,
            attributes: { taint: "untrusted_input" },
          }
        : { kind: "user", body: message },
      idempotencyKey: key,
    })
  } catch (error) {
    // flue holds this key for another submission.
    if (error instanceof SubmissionConflictError) return reused()
    // Logged but not delivered: a retry under the key delivers it.
    console.error(
      JSON.stringify({
        code: "steer.undelivered",
        assignment_id: id,
        error: error instanceof Error ? error.name : "unknown",
      })
    )
    return failure(c, 503, {
      class: "transient",
      code: "steer.undelivered",
      message: "The steer is saved but did not reach the build. Try again.",
      detail: {},
    })
  }
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
 * `preview-v{n}-{slug}` under this environment's suffix (ADR-030), the slug's
 * base cut if the label would pass 63 characters (`previewHost`), good for
 * a day. A revision still `building`, or one the gates refused and so left
 * without a number, has nothing to show and is refused.
 */
bridge.get("/:id/preview", async (c) => {
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
      .orderBy(sql`${siteRevisions.createdAt} desc`)
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
  const { version } = found.revision
  if (found.revision.status === "building" || version === null) {
    return failure(c, 409, {
      class: "validation",
      code: "revision.building",
      message: "This revision has no artifact to preview yet.",
      detail: { revision_id: found.revision.id },
    })
  }
  const host = previewHost(found.slug, version, c.env.SITE_HOST_SUFFIX)
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_S
  // Two claims over the same revision: `site` opens the preview, and
  // `screenshots` rides on the three images so they show inline where no
  // preview cookie exists. The router never lets the second open a page.
  const sign = (scope: PreviewClaim["scope"]) =>
    signPreview(
      PreviewClaim.parse({
        org_id: orgId,
        site_id: found.revision.siteId,
        revision_id: found.revision.id,
        host,
        scope,
        exp,
      }),
      c.env.PREVIEW_KEY
    )
  const [token, shots] = await Promise.all([sign("site"), sign("screenshots")])
  const base = siteUrl(host, c.env.SITE_PORT)
  return c.json({
    revision_id: found.revision.id,
    url: `${base}/open?t=${token}`,
    screenshots: [...SCREENSHOTS].map((s) => `${base}/${s}?t=${shots}`),
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
consoleOnly.post("/:id/review", async (c) => {
  const key = idempotencyKey(c.req.raw)
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
 * `POST /:id/approve` (ADR-032): the owner deciding, recorded as their
 * session, or the console deciding as the owner would, which only a Worker
 * with `CONSOLE_APPROVALS=allow` accepts. The revision
 * named must be the one the review was requested for; the decision and the
 * move to `release_candidate` share a transaction, and the publish is its
 * own Workflow keyed by the approval id, so a second create is refused.
 */
bridge.post("/:id/approve", async (c) => {
  const key = idempotencyKey(c.req.raw)
  if (!key) return keyMissing(c)
  if (!byOwner(c) && c.env.CONSOLE_APPROVALS !== "allow") {
    return failure(c, 403, {
      class: "permission",
      code: "approval.console_forbidden",
      message: "This Worker does not accept approvals from the console.",
      detail: {},
    })
  }
  const revisionId = await namedRevision(c, "An approval")
  if (typeof revisionId !== "string") return revisionId
  const orgId = c.get("orgId")
  const ids = { orgId, assignmentId: c.req.param("id") }
  let decision: Awaited<ReturnType<typeof decideApproval>>
  try {
    decision = await decideApproval(c.get("kit"), ids, {
      revisionId,
      decidedBy: c.get("caller"),
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
  } catch (error) {
    // Already created: the approval id is the instance id (ADR-032). Any
    // other failure must reach the owner, not a 202 for a publish never started.
    if (!(await instanceExists(c.env.PUBLISHES, approvalId))) throw error
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
bridge.post("/:id/reject", async (c) => {
  const key = idempotencyKey(c.req.raw)
  if (!key) return keyMissing(c)
  const revisionId = await namedRevision(c, "A rejection")
  if (typeof revisionId !== "string") return revisionId
  const ids = { orgId: c.get("orgId"), assignmentId: c.req.param("id") }
  try {
    const { decision, replayed } = await rejectApproval(c.get("kit"), ids, {
      revisionId,
      decidedBy: c.get("caller"),
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
consoleOnly.post("/rollback", async (c) => {
  const key = idempotencyKey(c.req.raw)
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
  // The org in the id, so two orgs' keys never meet; 100 characters at most.
  const id = `rollback-${orgId}-${key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 54)}`
  let created = true
  try {
    await c.env.PUBLISHES.create({
      id,
      params: { org_id: orgId, site_id: orgId, rollback: { key, reason } },
    })
  } catch (error) {
    if (!(await instanceExists(c.env.PUBLISHES, id))) throw error
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

/** Whether a Workflow instance exists; `get` throws for one that does not. */
const instanceExists = (workflow: Workflow, id: string) =>
  workflow.get(id).then(
    () => true,
    () => false
  )

function notFound(c: Context, id: string) {
  return failure(c, 404, {
    class: "resource",
    code: "assignment.not_found",
    message: "No assignment with that id in this business.",
    detail: { assignment_id: id },
  })
}

/** A route tree behind one caller's middleware. */
function tree(
  auth: MiddlewareHandler<ConsoleEnv>,
  ...parts: Hono<ConsoleEnv>[]
) {
  const r = new Hono<ConsoleEnv>({ strict: false })
  r.use("*", openKit)
  r.use("*", auth)
  for (const part of parts) r.route("/", part)
  r.onError(onError)
  return r
}

/** Every route, behind the bearer and the slug. */
const consoleRoutes = () => tree(consoleAuth, bridge, consoleOnly)

/** The bridge and the owner's own route, so nothing else is there to reach. */
export const ownerRoutes = () => tree(ownerAuth, bridge, ownerOnly)

/**
 * §28.1 for a path nothing serves, on the console's app and the owner's.
 * Under `/assignments` the caller's middleware runs first, so an unknown
 * path answers 404 only after the bearer and the slug (console) or the owner
 * headers (owner) pass; a caller who fails them sees the 401. Any other path
 * answers 404 directly.
 */
export const noRoute: NotFoundHandler = (c) =>
  failure(c, 404, {
    class: "resource",
    code: "route.not_found",
    message: "Nothing is served at this path.",
    detail: {},
  })

const onError: ErrorHandler<ConsoleEnv> = (error, c) => {
  // `bearerAuth` refuses with an exception that carries its own typed 401.
  if (error instanceof HTTPException) return error.getResponse()
  logFailure({ at: new URL(c.req.url).pathname }, error)
  return failure(c, 503, REQUEST_FAILED)
}

// The default export is the console's only: the custom domain, workers.dev
// and version URLs all land here, and none of them can reach `ownerAuth`.
app.route("/assignments", consoleRoutes())
app.notFound(noRoute)
// The probe sits outside the trees. A sandbox reset by a deploy throws there,
// and this answers it as the trees do: a 503 the probe's caller retries.
app.onError(onError)

export default app
