import {
  AnswerRequest,
  ApprovalDecision,
  Assignment,
  type AssignmentState,
  type BuildSummary,
  DecisionRequest,
  ErrorEnvelope,
  FactList,
  InformationAnswer,
  OWNER_BRIDGE_HEADERS,
  OwnerChangeRequest,
  PreviewLink,
  SetFactsRequest,
  Uuid,
} from "@workspace/contracts"
import {
  approvals,
  assignments,
  eq,
  sql,
  staff,
  supersedeFact,
  type Tenancy,
  toAssignment,
  users,
} from "@workspace/db"
import { failure, idempotencyKey, invalid, keyMissing } from "./http.ts"
import { ensureStartingTeam } from "./org.ts"
import type { Session } from "./session.ts"
import {
  etag,
  readActivity,
  readApprovals,
  readBuilds,
  readFacts,
  readSite,
  readWorkspace,
  unchanged,
} from "./workspace.ts"

/**
 * The owner's routes. The org is the one `index.ts` resolved from the sealed
 * session, and nothing here reads an org, a user or a session from the
 * request. Reads and fact writes run here under `withOrg`; anything that
 * touches a Workflow, the sandbox or a preview key crosses the ORCHESTRATOR
 * binding to `OwnerApi` (architect ruling 3).
 */

export type Owner = { orgId: string; session: NonNullable<Session> }

/** The routes `ownerRoute` answers, for `index.ts` to resolve an org before. */
export const OWNER_PATH =
  /^\/(workspace|facts|changes|activity|builds\/[^/]+\/(answer|cancel|preview)|approvals\/[^/]+\/decision)$/

type Bridged = { status: number; body: unknown }

/**
 * One call over the binding. The request is built here from nothing the
 * client sent except a body this file already validated and the
 * idempotency key: never the incoming request or its headers, which would
 * carry a client's `x-reme-*` and `Cloudflare-Workers-Version-Overrides`.
 */
async function bridge(
  env: Env,
  owner: Owner,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; key?: string | null } = {}
): Promise<Bridged> {
  const headers = new Headers({
    [OWNER_BRIDGE_HEADERS.orgId]: owner.orgId,
    [OWNER_BRIDGE_HEADERS.workosUserId]: owner.session.workosUserId,
    [OWNER_BRIDGE_HEADERS.sessionId]: owner.session.sessionId,
  })
  if (init.key) headers.set("idempotency-key", init.key)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  const response = await env.ORCHESTRATOR.fetch(
    new Request(`https://orchestrator/assignments${path}`, {
      method: init.method ?? "POST",
      headers,
      body: init.body === undefined ? null : JSON.stringify(init.body),
    })
  )
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  }
}

/**
 * The orchestrator's answer, checked against the contract on the way out. A
 * refusal is passed on when it is the §28.1 envelope; anything else is a bug
 * on one side of the binding and fails as one.
 */
function relay(result: Bridged, parse: (body: unknown) => unknown): Response {
  if (result.status < 300) {
    return Response.json(parse(result.body), { status: result.status })
  }
  const refusal = ErrorEnvelope.safeParse(result.body)
  if (refusal.success) {
    return Response.json(refusal.data, { status: result.status })
  }
  throw new Error(`the orchestrator answered ${result.status} off contract`)
}

const notFound = (noun: "assignment" | "approval") =>
  failure(404, {
    class: "resource",
    code: `${noun}.not_found`,
    message: `No ${noun} with that id in this business.`,
    detail: {},
  })

/** The build as the panel shows it, from the row the orchestrator returned. */
const summary = (body: unknown): BuildSummary => {
  const row = Assignment.parse(body)
  return {
    assignment_id: row.assignment_id,
    kind: row.kind as BuildSummary["kind"],
    state: row.state,
    goal: row.goal,
    revision: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const readBody = (request: Request) => request.json().catch(() => null)

export type ChangeInput = {
  live: boolean
  /** Unfinished builds, newest first. */
  builds: { assignment_id: string; state: AssignmentState }[]
  /** Open revision approvals. */
  reviews: { assignment_id: string | null; revision_id: string }[]
}

export type ChangeRoute =
  | { route: "build" | "revise" }
  | { route: "steer"; assignment_id: string }
  | {
      route: "refuse"
      reason: "question_open" | "build_busy"
      assignment_id: string
    }
  | {
      route: "reject_then_rebuild"
      assignment_id: string
      revision_id: string
      rebuild: "site.build" | "site.revise"
    }

/** States whose Developer is still working, so a message reaches it. */
const STEERABLE: readonly AssignmentState[] = [
  "briefing",
  "planning",
  "implementing",
  "validating",
  "repairing",
  "revising",
]

/**
 * Where an owner's change goes, from the site's state alone. A question
 * blocks everything, since the answer is what the build is waiting for. An
 * open review is turned down so the change becomes the next build rather
 * than sitting behind the site lock. A working build takes the change as a
 * steer. A build that is past working (queued, previewed, publishing,
 * parked) is refused until it settles. With nothing running, a live site is
 * revised and an unpublished one built.
 */
export function routeChange(site: ChangeInput): ChangeRoute {
  const asking = site.builds.find((b) => b.state === "blocked_on_information")
  if (asking) {
    return {
      route: "refuse",
      reason: "question_open",
      assignment_id: asking.assignment_id,
    }
  }
  for (const review of site.reviews) {
    const build = site.builds.find(
      (b) =>
        b.assignment_id === review.assignment_id &&
        b.state === "awaiting_review"
    )
    if (build) {
      return {
        route: "reject_then_rebuild",
        assignment_id: build.assignment_id,
        revision_id: review.revision_id,
        rebuild: site.live ? "site.revise" : "site.build",
      }
    }
  }
  const working = site.builds.find((b) => STEERABLE.includes(b.state))
  if (working) return { route: "steer", assignment_id: working.assignment_id }
  const [busy] = site.builds
  if (busy) {
    return {
      route: "refuse",
      reason: "build_busy",
      assignment_id: busy.assignment_id,
    }
  }
  return { route: site.live ? "revise" : "build" }
}

/** Two fact values with the same keys and values, whatever the key order. */
const canon = (value: unknown) =>
  JSON.stringify(
    value && typeof value === "object"
      ? Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))
      : value
  )

async function setFacts(request: Request, kit: Tenancy, owner: Owner) {
  if (!idempotencyKey(request)) return keyMissing()
  const parsed = SetFactsRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const keys = parsed.data.facts.map((fact) => fact.key)
  if (new Set(keys).size !== keys.length) {
    return failure(400, {
      class: "validation",
      code: "facts.duplicate_key",
      message: "Each fact key appears once in a request.",
      detail: { keys },
    })
  }
  const { orgId } = owner
  const list = await kit.withOrg({ orgId }, async (db) => {
    const current = await readFacts(db)
    const [root] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(sql`${staff.kind} = 'human' and ${staff.managerId} is null`)
    for (const fact of parsed.data.facts) {
      const held = current.find((f) => f.key === fact.key)
      // A repeat of what the owner already said writes nothing, which is
      // what makes a retry safe (R5). The same value from another source
      // is restated, so it becomes the owner's.
      if (
        held?.provenance.source === "owner_stated" &&
        canon(held.value) === canon(fact.value)
      ) {
        continue
      }
      await supersedeFact(db, {
        orgId,
        key: fact.key,
        factType: held?.fact_type ?? fact.key.split(".")[0] ?? "fact",
        value: fact.value,
        provenance: {
          source: "owner_stated",
          confidence: 1,
          verifiedByStaffId: root?.id ?? null,
        },
      })
    }
    return readFacts(db)
  })
  return Response.json(FactList.parse({ facts: list }))
}

async function requestChange(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner
) {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const parsed = OwnerChangeRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const text = parsed.data.text
  const { orgId, session } = owner
  const state = await kit.withOrg(
    { orgId, workosUserId: session.workosUserId },
    async (db) => {
      // An org made before the starting team existed gets it here, so its
      // first build has a Developer to run it (ruling 2).
      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, session.workosUserId))
      if (person) {
        await ensureStartingTeam(db, {
          orgId,
          userId: person.id,
          ownerName: session.name ?? session.email,
        })
      }
      // The build this key already made: a retry replays it rather than
      // routing again against the state the first attempt changed.
      const [made] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.idempotencyKey, key))
      if (made) return { made: toAssignment(made) }
      const [builds, reviews, site] = await Promise.all([
        readBuilds(db),
        readApprovals(db),
        readSite(db, env.SITE_HOST_SUFFIX),
      ])
      return { builds, reviews, live: site.live !== null }
    }
  )
  if ("made" in state) return Response.json(summary(state.made))
  const route = routeChange({
    live: state.live,
    builds: state.builds,
    reviews: state.reviews.map((item) => ({
      assignment_id: item.request.assignment_id,
      revision_id:
        item.request.target.kind === "revision"
          ? item.request.target.revision_id
          : "",
    })),
  })
  const create = (kind: "site.build" | "site.revise") =>
    bridge(env, owner, "/", { body: { kind, goal: text }, key }).then(
      (result) => relay(result, summary)
    )
  switch (route.route) {
    case "refuse":
      return failure(409, {
        class: "validation",
        code: `change.${route.reason}`,
        message:
          route.reason === "question_open"
            ? "A build is waiting on your answer. Answer it first."
            : "A build is finishing. Try again once it settles.",
        detail: { assignment_id: route.assignment_id },
      })
    case "steer": {
      // ponytail: a steer makes no row the key could find, so a retried
      // steer delivers the message twice. A keyed-results table (R5) if an
      // owner ever sees it.
      const result = await bridge(env, owner, `/${route.assignment_id}/steer`, {
        body: { message: text },
        key,
      })
      const build = state.builds.find(
        (b) => b.assignment_id === route.assignment_id
      )
      return relay(result, () => build)
    }
    case "reject_then_rebuild": {
      const rejected = await bridge(
        env,
        owner,
        `/${route.assignment_id}/reject`,
        { body: { revision_id: route.revision_id }, key }
      )
      if (rejected.status >= 300) return relay(rejected, () => null)
      return create(route.rebuild)
    }
    case "build":
      return create("site.build")
    case "revise":
      return create("site.revise")
  }
}

/** Whether the org holds this row. RLS answers: another org's id finds nothing. */
async function holds(
  kit: Tenancy,
  orgId: string,
  table: typeof assignments | typeof approvals,
  id: string
): Promise<{ assignmentId: string | null } | null> {
  if (!Uuid.safeParse(id).success) return null
  const [row] = await kit.withOrg({ orgId }, (db) =>
    table === assignments
      ? db
          .select({ assignmentId: assignments.id })
          .from(assignments)
          .where(eq(assignments.id, id))
      : db
          .select({ assignmentId: approvals.assignmentId })
          .from(approvals)
          .where(eq(approvals.id, id))
  )
  return row ?? null
}

async function buildAction(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  id: string,
  action: string
) {
  const method = request.method
  if ((action === "preview") !== (method === "GET")) return null
  let body: unknown
  if (action === "answer") {
    const parsed = AnswerRequest.safeParse(await readBody(request))
    if (!parsed.success) return invalid(parsed.error.issues)
    body = parsed.data
  }
  if (!(await holds(kit, owner.orgId, assignments, id))) {
    return notFound("assignment")
  }
  const result = await bridge(env, owner, `/${id}/${action}`, {
    method: method === "GET" ? "GET" : "POST",
    body,
    key: idempotencyKey(request),
  })
  if (action === "answer") return relay(result, InformationAnswer.parse)
  if (action === "preview") return relay(result, PreviewLink.parse)
  // `/cancel` answers the id and the state it settled in.
  return relay(result, (b) =>
    Assignment.pick({ assignment_id: true, state: true }).parse(b)
  )
}

async function decide(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  id: string
) {
  // An admin signed in as the owner can look, never decide: a publish is
  // the owner's own act (§7.3).
  if (owner.session.impersonated) {
    return failure(403, {
      class: "permission",
      code: "approval.impersonated",
      message: "An impersonated session cannot approve or reject.",
      detail: {},
    })
  }
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const parsed = DecisionRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const approval = await holds(kit, owner.orgId, approvals, id)
  if (!approval?.assignmentId) return notFound("approval")
  const verb = parsed.data.decision === "approved" ? "approve" : "reject"
  const result = await bridge(env, owner, `/${approval.assignmentId}/${verb}`, {
    body: { revision_id: parsed.data.revision_id },
    key,
  })
  // The console's publish handle stays on the console's side of the binding.
  return relay(result, (b) => {
    const { workflow_instance_id: _, ...decision } = b as Record<
      string,
      unknown
    >
    return ApprovalDecision.parse(decision)
  })
}

export async function ownerRoute(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner
): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  const method = request.method
  if (pathname === "/workspace" && method === "GET") {
    const status = await readWorkspace(kit, owner.orgId, env.SITE_HOST_SUFFIX)
    const body = JSON.stringify(status)
    const headers = {
      etag: await etag(body),
      "cache-control": "private, no-cache",
    }
    if (unchanged(request.headers.get("if-none-match"), headers.etag)) {
      return new Response(null, { status: 304, headers })
    }
    return new Response(body, {
      headers: { ...headers, "content-type": "application/json" },
    })
  }
  if (pathname === "/facts" && method === "GET") {
    const facts = await kit.withOrg({ orgId: owner.orgId }, readFacts)
    return Response.json(FactList.parse({ facts }))
  }
  if (pathname === "/facts" && method === "POST") {
    return setFacts(request, kit, owner)
  }
  if (pathname === "/changes" && method === "POST") {
    return requestChange(request, env, kit, owner)
  }
  if (pathname === "/activity" && method === "GET") {
    return Response.json(await readActivity(kit, owner.orgId))
  }
  const [, noun, id = "", action = ""] = pathname.split("/")
  if (noun === "builds") {
    return buildAction(request, env, kit, owner, id, action)
  }
  if (noun === "approvals" && method === "POST") {
    return decide(request, env, kit, owner, id)
  }
  return null
}
