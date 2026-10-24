import { type AssignmentState, TERMINAL_STATES } from "@workspace/contracts"
import {
  appendEvent,
  assignments,
  assignmentTransitions,
  eq,
  events,
  type OrgScopedDb,
  siteRevisions,
  sql,
  type Tenancy,
} from "@workspace/db"

/**
 * The §8.4 state machine, as data. State truth is the `assignments` row and
 * the Workflow is only the executor: every step here runs one transaction
 * that bumps `version`, appends the event and writes the transition row, or
 * does nothing at all.
 */

/** Repairing is entered at most this many times per assignment (§8.4). */
export const REPAIR_LIMIT = 3

/** How long a retired revision's files stay before the sweep deletes them (ADR-031). */
export const RETENTION_DAYS = 7

export const retireAfter = (now: Date) =>
  new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)

/**
 * Where each state may be entered from. §8.4's direct `Validating →
 * Implementing` edge is not here: this track routes a gate failure through
 * `repairing`, so the bound on repairs counts gate failures too. `paused` and
 * `cancelled` are legal from every non-terminal state and are handled below,
 * as is resuming from `paused`, which returns to the state the pause left.
 * `blocked_on_approval` is entered from two places (§13 "Budget exhaustion"
 * as well as review) and leaves only to the state that entered it, gated
 * below the same way a pause is, so a budget park can never open a path to
 * ReleaseCandidate that skips review (architect ruling, N2).
 */
const ENTERED_FROM: Record<AssignmentState, readonly AssignmentState[]> = {
  queued: [],
  briefing: ["queued"],
  planning: ["briefing"],
  implementing: [
    "planning",
    "blocked_on_information",
    "blocked_on_approval",
    "repairing",
  ],
  validating: ["implementing", "revising"],
  preview_ready: ["validating"],
  awaiting_review: ["preview_ready"],
  revising: ["awaiting_review"],
  release_candidate: ["awaiting_review", "blocked_on_approval"],
  published: ["release_candidate"],
  blocked_on_information: ["implementing"],
  blocked_on_approval: ["awaiting_review", "implementing"],
  // A preview goes back when the accessibility gate, which runs after the
  // preview exists, fails.
  repairing: ["implementing", "validating", "preview_ready"],
  paused: [],
  // A fourth gate failure cannot enter `repairing`, so it ends here directly.
  // A question that goes unanswered, or whose site was lost before its
  // checkpoint, ends the build from where it waits.
  failed: [
    "planning",
    "repairing",
    "validating",
    "implementing",
    "preview_ready",
    "blocked_on_information",
  ],
  cancelled: [],
}

type TransitionErrorClass = "transient" | "validation" | "resource"

/** R4: the code and class travel; the message is for a log, never a model. */
export class TransitionError extends Error {
  constructor(
    readonly code: string,
    readonly errorClass: TransitionErrorClass,
    message: string
  ) {
    super(message)
    this.name = "TransitionError"
  }
}

export type Ids = { orgId: string; assignmentId: string }

type Row = typeof assignments.$inferSelect

export async function lockRow(
  db: OrgScopedDb,
  assignmentId: string
): Promise<Row> {
  const [row] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.id, assignmentId))
    .for("update")
  if (!row) {
    throw new TransitionError(
      "assignment.not_found",
      "resource",
      `no assignment ${assignmentId} in this org`
    )
  }
  return row
}

/** How many times the assignment entered `repairing`. */
export async function repairsSoFar(
  db: OrgScopedDb,
  assignmentId: string
): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(assignmentTransitions)
    .where(
      sql`${assignmentTransitions.assignmentId} = ${assignmentId} and ${assignmentTransitions.toState} = 'repairing'`
    )
  return Number(row?.n ?? 0)
}

/** The state a stop left, read from the latest transition that entered `state`. */
export async function enteredFrom(
  db: OrgScopedDb,
  assignmentId: string,
  state: AssignmentState
): Promise<AssignmentState | null> {
  const [row] = await db
    .select({ from: assignmentTransitions.fromState })
    .from(assignmentTransitions)
    .where(
      sql`${assignmentTransitions.assignmentId} = ${assignmentId} and ${assignmentTransitions.toState} = ${state}`
    )
    .orderBy(sql`${assignmentTransitions.version} desc`)
    .limit(1)
  return row?.from ?? null
}

/** Where a `blocked_on_approval` entered from a given state may leave to. */
const APPROVAL_EXIT: Partial<Record<AssignmentState, AssignmentState>> = {
  awaiting_review: "release_candidate",
  implementing: "implementing",
}

/**
 * Model spend in USD from the log (§29.2): the sum of every `runtime.turn`'s
 * reported cost, which is the leaf level, so nothing counts twice. The
 * provider's own records are reconciliation, never the figure.
 */
export async function assignmentCost(
  db: OrgScopedDb,
  assignmentId: string
): Promise<number> {
  const [row] = await db
    .select({
      usd: sql<string>`coalesce(sum((${events.payload} #>> '{response,usage,cost,total}')::float8), 0)`,
    })
    .from(events)
    .where(
      sql`${events.assignmentId} = ${assignmentId} and ${events.type} = 'runtime.turn'`
    )
  return Number(row?.usd ?? 0)
}

/** How many model turns the assignment's log holds, for the timing line. */
export async function turnCount(
  db: OrgScopedDb,
  assignmentId: string
): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(events)
    .where(
      sql`${events.assignmentId} = ${assignmentId} and ${events.type} = 'runtime.turn'`
    )
  return Number(row?.n ?? 0)
}

/** Epoch ms of the assignment's newest event, or 0 with none: the Workflow's stall check. */
export async function lastEventAt(
  db: OrgScopedDb,
  assignmentId: string
): Promise<number> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${events.occurredAt})` })
    .from(events)
    .where(sql`${events.assignmentId} = ${assignmentId}`)
  return row?.at ? new Date(row.at).getTime() : 0
}

type TransitionInput = Ids & {
  to: AssignmentState
  expectedVersion: number
  reason?: string
  payload?: Record<string, unknown>
}

type Transition = {
  from: AssignmentState
  to: AssignmentState
  version: number
  eventId: string
}

/**
 * The one way a state changes. Inside the caller's transaction: lock the row,
 * check the version the caller saw, check the edge is legal, bump, append the
 * event, write the transition row. Any refusal is typed (§28.1): a stale
 * version is `transient` because it is a race the caller re-reads through, an
 * illegal edge is `validation` because retrying cannot make it legal.
 */
export async function transition(
  db: OrgScopedDb,
  input: TransitionInput
): Promise<Transition> {
  const row = await lockRow(db, input.assignmentId)
  if (row.version !== input.expectedVersion) {
    throw new TransitionError(
      "assignment.stale_version",
      "transient",
      `expected version ${input.expectedVersion}, row is at ${row.version}`
    )
  }
  const from = row.state
  const to = input.to
  const illegal = (why: string) =>
    new TransitionError(
      "assignment.illegal_transition",
      "validation",
      `${from} -> ${to}: ${why}`
    )

  if (TERMINAL_STATES.includes(from))
    throw illegal("the assignment is finished")
  if (to === "paused" || to === "cancelled") {
    if (from === to) throw illegal("already there")
  } else if (from === "paused") {
    const origin = await enteredFrom(db, row.id, "paused")
    if (to !== origin) throw illegal(`a pause resumes to ${origin}`)
  } else if (from === "blocked_on_approval") {
    const origin = await enteredFrom(db, row.id, "blocked_on_approval")
    const exit = origin ? APPROVAL_EXIT[origin] : undefined
    if (to !== exit) {
      throw illegal(
        `an approval block entered from ${origin} leaves to ${exit}`
      )
    }
  } else if (!ENTERED_FROM[to].includes(from)) {
    throw illegal("not an edge of the state machine")
  }
  if (to === "repairing" && (await repairsSoFar(db, row.id)) >= REPAIR_LIMIT) {
    throw new TransitionError(
      "assignment.repair_budget_exhausted",
      "validation",
      `repairing was entered ${REPAIR_LIMIT} times already`
    )
  }

  const version = row.version + 1
  // Frozen at close, in the transaction that closes it.
  const costUsd = TERMINAL_STATES.includes(to)
    ? await assignmentCost(db, row.id)
    : undefined
  try {
    await db
      .update(assignments)
      .set({ state: to, version, costUsd, updatedAt: new Date() })
      .where(eq(assignments.id, row.id))
  } catch (error) {
    // The site lock (§13): another site assignment in this org is between
    // claim and a terminal state. The caller decides whether to wait. Drizzle
    // wraps the driver's error, so the constraint name is on the cause.
    const cause = (error as { cause?: unknown }).cause ?? error
    if (
      (cause as { constraint_name?: string }).constraint_name ===
      "assignments_site_writer_key"
    ) {
      throw new TransitionError(
        "site.locked",
        "resource",
        "another assignment is writing this site"
      )
    }
    throw error
  }
  // A build that ends without publishing takes its unpublished revisions
  // into the seven-day window (ADR-032). Named by status, so a `published`
  // revision is unreachable from here by construction; every caller that
  // cancels or fails passes through this one function (architect ruling).
  let retired: string[] = []
  if ((to === "cancelled" || to === "failed") && row.kind.startsWith("site.")) {
    const now = new Date()
    retired = (
      await db
        .update(siteRevisions)
        .set({
          status: "retired",
          retireAfter: retireAfter(now),
          updatedAt: now,
        })
        .where(
          sql`${siteRevisions.assignmentId} = ${row.id} and ${siteRevisions.status} in ('building', 'preview') and ${siteRevisions.retireAfter} is null`
        )
        .returning({ id: siteRevisions.id })
    ).map((r) => r.id)
  }
  const eventId = await appendEvent(db, {
    orgId: row.orgId,
    assignmentId: row.id,
    staffId: row.staffId,
    type: "assignment.state_changed",
    payload: {
      from,
      to,
      version,
      ...input.payload,
      ...(costUsd === undefined ? {} : { cost_usd: costUsd }),
      ...(retired.length > 0 ? { retired_revisions: retired } : {}),
    },
  })
  await db.insert(assignmentTransitions).values({
    orgId: row.orgId,
    assignmentId: row.id,
    fromState: from,
    toState: to,
    version,
    eventId,
    reason: input.reason ?? null,
  })
  return { from, to, version, eventId }
}

/**
 * Move to `to` from whatever the row is at now. For the Workflow, which is
 * the row's single writer between claim and settlement: the version it reads
 * under the lock is the version it expects. `apply` runs in the same
 * transaction, for a step that writes more than the transition. A row already
 * at `to` is a step retried after its commit, so it returns that transition
 * rather than refusing the edge and jamming the site lock.
 */
export function advance(
  kit: Tenancy,
  ids: Ids,
  to: AssignmentState,
  options: {
    reason?: string
    payload?: Record<string, unknown>
    apply?: (db: OrgScopedDb, row: Row) => Promise<Record<string, unknown>>
  } = {}
): Promise<Transition> {
  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const row = await lockRow(db, ids.assignmentId)
    if (row.state === to) {
      const [last] = await db
        .select()
        .from(assignmentTransitions)
        .where(
          sql`${assignmentTransitions.assignmentId} = ${row.id} and ${assignmentTransitions.version} = ${row.version}`
        )
      if (last) {
        return {
          from: last.fromState,
          to,
          version: row.version,
          eventId: last.eventId,
        }
      }
    }
    const extra = options.apply ? await options.apply(db, row) : {}
    return transition(db, {
      ...ids,
      to,
      expectedVersion: row.version,
      reason: options.reason,
      payload: { ...options.payload, ...extra },
    })
  })
}

/**
 * §13 "Budget exhaustion": the facade's pre-call guard refused the next
 * model call, so the assignment parks where an owner can top it up. The
 * `budget.exhausted` audit row lands in the same transaction as the
 * transition. Resuming is `advance(kit, ids, "implementing")` after
 * `budget_usd` has been raised; the exit gate above allows nothing else.
 */
export function parkForBudget(
  kit: Tenancy,
  ids: Ids,
  budget: { cap_usd: number; spent_usd: number }
): Promise<Transition> {
  return advance(kit, ids, "blocked_on_approval", {
    reason: "budget.exhausted",
    apply: async (db, row) => {
      await appendEvent(db, {
        orgId: row.orgId,
        assignmentId: row.id,
        staffId: row.staffId,
        type: "budget.exhausted",
        payload: budget,
      })
      return budget
    },
  })
}

/**
 * Cancel is legal from every non-terminal state and idempotent (§13 rule 3).
 * Returns the row's state afterwards, `cancelled` or the terminal state it was
 * already in.
 */
export function cancel(
  kit: Tenancy,
  ids: Ids,
  reason = "cancelled from the console"
): Promise<AssignmentState> {
  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const row = await lockRow(db, ids.assignmentId)
    if (TERMINAL_STATES.includes(row.state)) return row.state
    await transition(db, {
      ...ids,
      to: "cancelled",
      expectedVersion: row.version,
      reason,
    })
    return "cancelled"
  })
}

export type Claim = {
  claimed: boolean
  /** The `preview_ready` assignment this claim cancelled, whose sandbox the caller destroys. */
  superseded: string | null
}

/**
 * Take the site lock by entering `briefing`. Not claimed when another
 * assignment holds it, in which case the row stays `queued` and one
 * `site.locked` event is appended on the first refusal only, so a long wait
 * is one line in the log rather than one per poll.
 *
 * A site assignment supersedes one that is exactly `preview_ready`: built,
 * and not yet in front of an owner (§13, architect ruling on the preview).
 * The cancel and the claim share one transaction, so a claim that still
 * loses the lock supersedes nothing, and the unique index decides a race.
 * `awaiting_review` and everything after it are never superseded.
 */
export async function claim(
  kit: Tenancy,
  ids: Ids,
  firstAttempt: boolean
): Promise<Claim> {
  try {
    const superseded = await kit.withOrg({ orgId: ids.orgId }, async (db) => {
      const row = await lockRow(db, ids.assignmentId)
      const [stale] = row.kind.startsWith("site.")
        ? await db
            .select()
            .from(assignments)
            .where(
              sql`${assignments.kind} like 'site.%' and ${assignments.state} = 'preview_ready' and ${assignments.id} <> ${row.id}`
            )
            .for("update")
        : []
      if (stale) {
        await transition(db, {
          orgId: ids.orgId,
          assignmentId: stale.id,
          to: "cancelled",
          expectedVersion: stale.version,
          reason: "superseded",
          payload: { superseded_by: row.id },
        })
      }
      await transition(db, {
        ...ids,
        to: "briefing",
        expectedVersion: row.version,
      })
      return stale?.id ?? null
    })
    return { claimed: true, superseded }
  } catch (error) {
    if (!(error instanceof TransitionError) || error.code !== "site.locked") {
      throw error
    }
  }
  if (firstAttempt) {
    await kit.withOrg({ orgId: ids.orgId }, async (db) => {
      const row = await lockRow(db, ids.assignmentId)
      await appendEvent(db, {
        orgId: row.orgId,
        assignmentId: row.id,
        staffId: row.staffId,
        type: "site.locked",
        payload: { waiting_in: row.state },
      })
    })
  }
  return { claimed: false, superseded: null }
}
