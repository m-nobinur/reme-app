import {
  AnswerRequest,
  ApprovalDecision,
  Assignment,
  type AssignmentState,
  type BuildSummary,
  DecisionRequest,
  ErrorEnvelope,
  FactList,
  type FactRecord,
  type FactValue,
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
  type OrgScopedDb,
  steerByKey,
  supersedeFact,
  type Tenancy,
  toAssignment,
} from "@workspace/db"
import { chat } from "./chat.ts"
import { conversationRoute } from "./conversations.ts"
import {
  failure,
  idempotencyKey,
  invalid,
  issuePaths,
  keyMissing,
  readBody,
} from "./http.ts"
import { ownerStaffId } from "./org.ts"
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
  /^\/(workspace|facts|changes|activity|builds\/[^/]+\/(answer|cancel|preview)|approvals\/[^/]+\/decision|conversations(\/[^/]+(\/messages)?)?|chat)$/

type Bridged = { status: number; body: unknown }

/**
 * How long a change may take, reads and every call over the binding
 * together, and how long any other single call may take (ADR-034). A guess:
 * 7.5 times one measured staging `POST /changes` of 1,330 ms. The chat's
 * approval waits on it while it holds its turn's lock, so the 15 s
 * idle-in-transaction limit in `packages/db` is this plus 5 s.
 */
const BRIDGE_TIMEOUT_MS = 10_000

/**
 * `work`, or `late()` once `signal` aborts, whichever comes first. An
 * aborted signal starts no work; work already started is no longer waited
 * for, not stopped. The listener goes on before the work starts, so the
 * deadline wins a tie with the work's own abort, and comes off once either
 * settles, so a change's one signal does not collect a listener per call.
 */
export function within<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
  late: () => T
): Promise<T> {
  if (signal.aborted) return Promise.resolve(late())
  let onAbort: () => void = () => undefined
  const aborted = new Promise<T>((resolve) => {
    onAbort = () => resolve(late())
    signal.addEventListener("abort", onAbort, { once: true })
  })
  return Promise.race([work(), aborted]).finally(() =>
    signal.removeEventListener("abort", onAbort)
  )
}

/** The orchestrator answered in no shape at all, or not at all. */
const unreachable = (
  code: "orchestrator.timeout" | "orchestrator.unavailable"
) =>
  ({
    status: 503,
    body: {
      class: "transient",
      code,
      message: "The builder did not answer.",
      detail: {},
      occurred_at: new Date().toISOString(),
    },
  }) satisfies Bridged

/**
 * One call over the binding. The request is built here from nothing the
 * client sent except a body this file already validated and the
 * idempotency key: never the incoming request or its headers, which would
 * carry a client's `x-reme-*` and `Cloudflare-Workers-Version-Overrides`.
 *
 * It ends by `signal`, or by its own `BRIDGE_TIMEOUT_MS` when given none,
 * and a call cut off answers as a 503 `orchestrator.timeout`: the request
 * is aborted, and the answer is not waited for even if the binding ignores
 * the abort. A call the binding rejects (the orchestrator unreachable or
 * failing before it answers) is a 503 `orchestrator.unavailable`.
 */
export async function bridge(
  env: Env,
  owner: Owner,
  path: string,
  init: {
    method?: "GET" | "POST"
    body?: unknown
    key?: string | null
    signal?: AbortSignal
  } = {}
): Promise<Bridged> {
  const headers = new Headers({
    [OWNER_BRIDGE_HEADERS.orgId]: owner.orgId,
    [OWNER_BRIDGE_HEADERS.workosUserId]: owner.session.workosUserId,
    [OWNER_BRIDGE_HEADERS.sessionId]: owner.session.sessionId,
  })
  if (init.key) headers.set("idempotency-key", init.key)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  const signal = init.signal ?? AbortSignal.timeout(BRIDGE_TIMEOUT_MS)
  const result = await within(
    signal,
    async () => {
      const response = await env.ORCHESTRATOR.fetch(
        new Request(`https://orchestrator/assignments${path}`, {
          method: init.method ?? "POST",
          headers,
          body: init.body === undefined ? null : JSON.stringify(init.body),
          signal,
        })
      ).catch(() => null)
      if (!response) return unreachable("orchestrator.unavailable")
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      }
    },
    () => unreachable("orchestrator.timeout")
  )
  if (result.status >= 500) unknownOutcome(path, result)
  return result
}

/**
 * A call whose outcome nobody knows, logged by its code, the orchestrator
 * route and the build it named, and nothing else. ADR-034's triggers read
 * these, the first `orchestrator.timeout` on a replace among them.
 */
function unknownOutcome(path: string, result: Bridged) {
  const refusal = ErrorEnvelope.safeParse(result.body)
  const [, id, verb] = path.split("/")
  console.error(
    JSON.stringify({
      code: refusal.success ? refusal.data.code : "orchestrator.unavailable",
      route: verb ? `/assignments/:id/${verb}` : "/assignments/",
      assignment_id: id || null,
    })
  )
}

/**
 * The orchestrator's answer, checked against the contract on the way out. A
 * success passes when it parses, and a refusal when it is a 4xx carrying the
 * §28.1 envelope. A 4xx without one is a route or shape mismatch that
 * committed nothing and will fail the same way again: 502 `integrity`.
 * Anything else, a timeout, a 5xx or a success off the contract, leaves the
 * outcome unknown (ADR-034): the call may have committed. The owner gets 503
 * `transient`, and a retry under the same key finds what the call did.
 */
export function relay(
  result: Bridged,
  parse: (body: unknown) => unknown
): Response {
  if (result.status < 300) {
    try {
      return Response.json(parse(result.body), { status: result.status })
    } catch (error) {
      noted("orchestrator.off_contract", result.status, error)
      return unknown("orchestrator.off_contract")
    }
  }
  const refusal = ErrorEnvelope.safeParse(result.body)
  if (result.status < 500) {
    if (refusal.success) {
      return Response.json(refusal.data, { status: result.status })
    }
    noted("orchestrator.off_contract", result.status, refusal.error)
    return failure(502, {
      class: "integrity",
      code: "orchestrator.off_contract",
      message: "The builder answered in a shape we do not accept.",
      detail: {},
    })
  }
  // Logged by `bridge`, which knows the route.
  return unknown(
    refusal.success ? refusal.data.code : "orchestrator.unavailable"
  )
}

/** An outcome nobody can vouch for, under the code that says why. */
const unknown = (code: string) =>
  failure(503, {
    class: "transient",
    code,
    message: "We could not tell whether that went through. Try again.",
    detail: {},
  })

/** The log line for an answer that is not the contract's, paths only. */
function noted(code: string, status: number, error?: unknown) {
  const { issues } = (error ?? {}) as { issues?: { path: PropertyKey[] }[] }
  console.error(JSON.stringify({ code, status, issues: issuePaths(issues) }))
}

export const notFound = (noun: "assignment" | "approval") =>
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

export type ChangeInput = {
  live: boolean
  /** Every unfinished build, newest first. */
  builds: { assignment_id: string; state: AssignmentState }[]
  /** Revision approvals the orchestrator would take a decision on now. */
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
      /** Start the new build, then end the one holding the site. */
      route: "replace"
      via: "reject" | "cancel"
      assignment_id: string
      revision_id: string | null
      rebuild: "site.build" | "site.revise"
    }

type Replace = Extract<ChangeRoute, { route: "replace" }>

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
 * blocks everything, since the answer is what the build is waiting for. A
 * build waiting on a decision the orchestrator would take now (a review in
 * date, or one the sweep parked) is replaced: its review is turned down. A
 * build parked on its budget is replaced by cancelling it. A working build
 * takes the change as a steer. A build settling on its own (queued,
 * previewed, publishing, paused from the console, or a review that expired
 * and waits up to an hour for the sweep to park it) is refused until it
 * settles. With nothing running, a live site is revised and an unpublished
 * one built.
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
  const rebuild = site.live ? "site.revise" : "site.build"
  for (const build of site.builds) {
    const review = site.reviews.find(
      (r) => r.assignment_id === build.assignment_id
    )
    const parked = build.state === "blocked_on_approval"
    if (review && (parked || build.state === "awaiting_review")) {
      return {
        route: "replace",
        via: "reject",
        assignment_id: build.assignment_id,
        revision_id: review.revision_id,
        rebuild,
      }
    }
    if (parked) {
      return {
        route: "replace",
        via: "cancel",
        assignment_id: build.assignment_id,
        revision_id: null,
        rebuild,
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

/**
 * Writes each stated fact as the owner's (`owner_stated`), inside a `withOrg`
 * that carries the owner's WorkOS user. A repeat of what the owner already
 * said writes nothing, which is what makes a retry safe (R5). The same value
 * from another source is restated, so it becomes the owner's.
 */
export async function stateFacts(
  db: OrgScopedDb,
  owner: Owner,
  stated: FactValue[],
  current?: FactRecord[]
) {
  const { orgId, session } = owner
  const held = current ?? (await readFacts(db))
  const root = await ownerStaffId(db, {
    orgId,
    workosUserId: session.workosUserId,
    ownerName: session.name ?? session.email,
  })
  for (const fact of stated) {
    const was = held.find((f) => f.key === fact.key)
    if (
      was?.provenance.source === "owner_stated" &&
      canon(was.value) === canon(fact.value)
    ) {
      continue
    }
    await supersedeFact(db, {
      orgId,
      key: fact.key,
      factType: was?.fact_type ?? fact.key.split(".")[0] ?? "fact",
      value: fact.value,
      provenance: {
        source: "owner_stated",
        confidence: 1,
        verifiedByStaffId: root,
      },
    })
  }
}

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
  const list = await kit.withOrg(
    { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
    async (db) => {
      await stateFacts(db, owner, parsed.data.facts)
      return readFacts(db)
    }
  )
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
  return startChange(env, kit, owner, parsed.data.text, key)
}

/**
 * An owner's change, routed and started: the build it made or steered, or
 * the envelope saying why not. `/changes` and the chat's approval both come
 * here, and `key` makes a retry finish what the first attempt started,
 * read from the build the key made (ADR-034).
 */
export async function startChange(
  env: Env,
  kit: Tenancy,
  owner: Owner,
  text: string,
  key: string
): Promise<Response> {
  // One deadline for the whole change: its reads and every call it makes
  // share it, so a replace's three calls end within it too.
  const signal = AbortSignal.timeout(BRIDGE_TIMEOUT_MS)
  const { orgId, session } = owner
  const state = await within(
    signal,
    () =>
      kit.withOrg({ orgId, workosUserId: session.workosUserId }, async (db) => {
        // An org made before the starting team existed gets it here, so
        // its first build has a Developer to run it (ruling 2).
        await ownerStaffId(db, {
          orgId,
          workosUserId: session.workosUserId,
          ownerName: session.name ?? session.email,
        })
        const [found] = await db
          .select()
          .from(assignments)
          .where(eq(assignments.idempotencyKey, key))
        const made = found ? toAssignment(found) : null
        // Only a queued build can have steps left; any other answers alone.
        if (made && made.state !== "queued") {
          return { made, steered: null, builds: [], reviews: [], live: false }
        }
        // A steer makes no build, so a retried steer is found by its event
        // and replayed against the build it went to, whatever that build is
        // doing now: routing again could start or steer a different one.
        const steer = made ? null : await steerByKey(db, key)
        if (steer) {
          const [to] = await db
            .select()
            .from(assignments)
            .where(eq(assignments.id, steer.assignment_id))
          if (to) {
            return {
              made: null,
              steered: toAssignment(to),
              builds: [],
              reviews: [],
              live: false,
            }
          }
        }
        const [builds, reviews, site] = await Promise.all([
          readBuilds(db, null),
          readApprovals(db),
          readSite(db, env.SITE_HOST_SUFFIX),
        ])
        return {
          made,
          steered: null,
          builds,
          reviews,
          live: site.live !== null,
        }
      }),
    () => null
  )
  if (!state) return unknown("change.timeout")
  const { made, steered } = state
  if (steered) {
    const replayed = await bridge(
      env,
      owner,
      `/${steered.assignment_id}/steer`,
      {
        body: { message: text },
        key,
        signal,
      }
    )
    return relay(replayed, () => summary(steered))
  }
  // Routed on the org's other builds, so a retry sees what is left to do.
  const route = routeChange({
    live: state.live,
    builds: state.builds.filter((b) => b.assignment_id !== made?.assignment_id),
    reviews: state.reviews.map(({ request: r }) => ({
      assignment_id: r.assignment_id,
      revision_id: r.target.kind === "revision" ? r.target.revision_id : "",
    })),
  })
  const call = (path: string, body?: unknown) =>
    bridge(env, owner, path, { body, key, signal })
  // The old review turned down once the new build exists. Only a definite
  // no cancels the new build: an unknown outcome may have ended the review.
  const end = async (build: Assignment, status: number, old: Replace) => {
    const ended = relay(
      await call(
        `/${old.assignment_id}/${old.via}`,
        old.via === "reject" ? { revision_id: old.revision_id } : undefined
      ),
      () => null
    )
    if (ended.ok) return Response.json(summary(build), { status })
    if (ended.status >= 500) return ended
    // The old build keeps the site, so nothing would release the new one.
    // If the cancel's outcome is not known, a retry finds the build still
    // queued and runs these steps again.
    const cancelled = relay(
      await call(`/${build.assignment_id}/cancel`),
      () => null
    )
    if (cancelled.ok) return ended
    if (cancelled.status >= 500) return cancelled
    // Refused outright: both builds stay open and no retry will change
    // that, so it is a conflict someone has to look at, not a 503 to loop on.
    console.error(
      JSON.stringify({
        alert: "change.not_cancelled",
        new_assignment_id: build.assignment_id,
        old_assignment_id: old.assignment_id,
        status: cancelled.status,
      })
    )
    return failure(409, {
      class: "validation",
      code: "change.not_cancelled",
      message:
        "Your change could not replace the build waiting for review. We have flagged it.",
      detail: {
        assignment_id: build.assignment_id,
        replacing_assignment_id: old.assignment_id,
      },
    })
  }
  if (made) {
    if (made.state === "cancelled") {
      return failure(409, {
        class: "validation",
        code: "change.cancelled",
        message: "That change was cancelled. Ask for it again.",
        detail: { assignment_id: made.assignment_id },
      })
    }
    if (made.state === "queued" && route.route === "replace") {
      return end(made, 200, route)
    }
    return Response.json(summary(made))
  }
  const create = async (kind: "site.build" | "site.revise") =>
    relay(await call("/", { kind, goal: text }), summary)
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
      // The orchestrator stores the steer under this key and delivers it
      // once, so a retry after a timeout replays the first receipt.
      const result = await call(`/${route.assignment_id}/steer`, {
        message: text,
      })
      const build = state.builds.find(
        (b) => b.assignment_id === route.assignment_id
      )
      return relay(result, () => build)
    }
    case "replace": {
      // The new build first: while the old one holds the site it queues
      // behind the lock and claims it once the old one ends. A refused or
      // unknown create leaves the review standing.
      const created = await call("/", { kind: route.rebuild, goal: text })
      const build = Assignment.safeParse(created.body)
      if (created.status >= 300 || !build.success) {
        return relay(created, summary)
      }
      return end(build.data, created.status, route)
    }
    case "build":
      return create("site.build")
    case "revise":
      return create("site.revise")
  }
}

/**
 * Whether the org holds this row. RLS answers: another org's id finds
 * nothing.
 */
export async function holds(
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
  const key = idempotencyKey(request)
  if (method === "POST" && !key) return keyMissing()
  let body: AnswerRequest | undefined
  if (action === "answer") {
    const parsed = AnswerRequest.safeParse(await readBody(request))
    if (!parsed.success) return invalid(parsed.error.issues)
    body = parsed.data
  }
  // Which question an answer may reach, and whether it repeats one already
  // given, is the orchestrator's to say, under the build's row lock. Whether
  // the org holds the build is checked here, so another org's id never
  // reaches the binding (the tenancy gate holds that).
  const found = await holds(kit, owner.orgId, assignments, id)
  if (!found) return notFound("assignment")
  const result = await bridge(env, owner, `/${id}/${action}`, {
    method: method === "GET" ? "GET" : "POST",
    body,
    key,
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
  if (pathname === "/chat" && method === "POST") {
    return chat(request, env, kit, owner)
  }
  if (pathname === "/activity" && method === "GET") {
    return Response.json(await readActivity(kit, owner.orgId))
  }
  const [, noun, id = "", action = ""] = pathname.split("/")
  if (noun === "builds") {
    return buildAction(request, env, kit, owner, id, action)
  }
  if (noun === "conversations") {
    return conversationRoute(request, kit, owner, id, action)
  }
  if (noun === "approvals" && method === "POST") {
    return decide(request, env, kit, owner, id)
  }
  return null
}
