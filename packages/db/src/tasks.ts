import {
  ADDRESS_TASK_STEPS,
  type AddressDetail,
  GOOGLE_TASK_STEPS,
  type OwnerTask,
  type TaskBlockedOn,
  type TaskKind,
  type TaskState,
  type TaskStepName,
  type TaskStepState,
} from "@workspace/contracts"
import { and, eq, sql } from "drizzle-orm"
import { ownerTasks, taskSteps } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

// The owner task store. Plain writes for the probe engine and the call sites,
// one read for the panel and the assistant, and `syncTasks`, the one mapping
// from `domains` and `search_connections` rows to task state.

const STEPS: Record<TaskKind, readonly TaskStepName[]> = {
  address: ADDRESS_TASK_STEPS,
  google: GOOGLE_TASK_STEPS,
}

/**
 * The open task of `kind`, made with every step of its kind if there is
 * none. One put off for later becomes active again with its steps as they
 * were; `detail` is merged over what the task holds. Returns the task id.
 */
export async function openTask(
  db: OrgScopedDb,
  orgId: string,
  kind: TaskKind,
  detail: AddressDetail | Record<string, never> = {}
): Promise<string> {
  const [row] = await db
    .insert(ownerTasks)
    .values({ orgId, kind, detail })
    .onConflictDoUpdate({
      target: [ownerTasks.orgId, ownerTasks.kind],
      targetWhere: sql`state in ('active', 'later')`,
      set: {
        state: "active",
        laterUntil: null,
        detail: sql`${ownerTasks.detail} || excluded.detail`,
      },
    })
    .returning({ id: ownerTasks.id })
  const id = (row as { id: string }).id
  await addSteps(db, orgId, id, kind)
  return id
}

/**
 * Puts the open task off for `days`: `later` until then, the same row as
 * `openTask` finds when the owner is asked again.
 */
export async function putOff(
  db: OrgScopedDb,
  taskId: string,
  days: number
): Promise<void> {
  await db
    .update(ownerTasks)
    .set({
      state: "later",
      laterUntil: sql`now() + ${days} * interval '1 day'`,
    })
    .where(eq(ownerTasks.id, taskId))
}

const addSteps = (
  db: OrgScopedDb,
  orgId: string,
  taskId: string,
  kind: TaskKind
) =>
  db
    .insert(taskSteps)
    .values(STEPS[kind].map((step) => ({ taskId, orgId, step })))
    .onConflictDoNothing()

/** What a step write may change; a key left out is left as it is. */
export type StepWrite = {
  state?: TaskStepState
  note?: string | null
  blocked_on?: TaskBlockedOn | null
  deadline?: Date | null
  evidence?: unknown
  probe_hash?: string | null
  probed_at?: Date | null
  changed_at?: Date | null
}

/**
 * One step written. A new state moves `changed_at` to now unless the write
 * gives it, and a state other than `blocked` clears `blocked_on` and the note
 * unless the write gives them, since both say why a step waits.
 */
export async function setStep(
  db: OrgScopedDb,
  taskId: string,
  step: TaskStepName,
  write: StepWrite
): Promise<void> {
  const { state } = write
  const leaving = state !== undefined && state !== "blocked"
  const set = {
    ...(state !== undefined && { state }),
    ...(write.note !== undefined
      ? { note: write.note }
      : leaving && { note: null }),
    ...(write.blocked_on !== undefined
      ? { blockedOn: write.blocked_on }
      : leaving && { blockedOn: null }),
    ...(write.deadline !== undefined && { deadline: write.deadline }),
    ...(write.evidence !== undefined && { evidence: write.evidence }),
    ...(write.probe_hash !== undefined && { probeHash: write.probe_hash }),
    ...(write.probed_at !== undefined && { probedAt: write.probed_at }),
    ...(write.changed_at !== undefined
      ? { changedAt: write.changed_at }
      : state !== undefined && {
          changedAt: sql`case when ${taskSteps.state} is distinct from ${state}::task_step_state then now() else ${taskSteps.changedAt} end`,
        }),
  }
  if (Object.keys(set).length === 0) return
  await db
    .update(taskSteps)
    .set(set)
    .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.step, step)))
}

const iso = (at: string | null) => (at ? new Date(at).toISOString() : null)

type TaskRow = Omit<OwnerTask, "steps" | "detail"> & {
  detail: unknown
  steps: OwnerTask["steps"]
}

/**
 * The org's tasks, newest first, each with its steps in their order (the
 * enum's). Ten at most: one open per kind, and the rest finished.
 */
export async function readTasks(db: OrgScopedDb): Promise<OwnerTask[]> {
  const rows = await db.execute<TaskRow>(sql`
    select t.id, t.kind, t.state, t.later_until, t.detail, t.created_at, t.done_at,
      (select coalesce(json_agg(json_build_object('step', s.step, 'state', s.state,
        'note', s.note, 'blocked_on', s.blocked_on, 'deadline', s.deadline,
        'changed_at', s.changed_at) order by s.step), '[]'::json)
        from task_steps s where s.task_id = t.id) as steps
    from owner_tasks t order by t.created_at desc limit 10`)
  return rows.map(
    (t) =>
      ({
        ...t,
        later_until: iso(t.later_until),
        created_at: iso(t.created_at) as string,
        done_at: iso(t.done_at),
        steps: t.steps.map((s) => ({
          ...s,
          deadline: iso(s.deadline),
          changed_at: iso(s.changed_at),
        })),
      }) as OwnerTask
  )
}

// ---------------------------------------------------------------------------
// The mapping from the rows that already record the work

/**
 * How long an unpaid purchase holds its name: the purchase Workflow's four
 * payment rounds of 35 minutes (`PAYMENT_ROUNDS`, `PAYMENT_WAIT` in
 * `apps/orchestrator/src/domain-buy.ts`), after which the row is abandoned.
 */
export const PURCHASE_HOLD_MS = 4 * 35 * 60_000

/** A connect not live by then fails: `DEADLINE_MS` in `apps/orchestrator/src/domain-flow.ts`. */
export const CONNECT_DEADLINE_MS = 72 * 60 * 60 * 1000

/** The domain row a task follows, as `syncTasks` reads it. */
export type DomainFacts = {
  name: string
  origin: "connected" | "purchased"
  state: string
  needs_txt: boolean
  /** The last `DomainCheck`'s status. */
  check: string | null
  /** Cloudflare says the bought name is registered. */
  registered: boolean
  provider: string | null
  created_at: string
  activated_at: string | null
}

/** The Google connection and its newest property, as `syncTasks` reads them. */
export type GoogleFacts = {
  state: "active" | "needs_reauth" | "revoked" | "needs_permission"
  property: { state: string; sitemap: boolean } | null
  /** A day of data with impressions is stored. */
  data: boolean
}

type StepPlan = {
  state: TaskStepState
  blocked_on?: TaskBlockedOn
  deadline?: Date
}

export type TaskPlan = {
  /** `active` is done once every step is done or skipped, which `apply` decides. */
  state: Exclude<TaskState, "done">
  /** When it finished, if it does: a back-filled live domain's activation. */
  done_at: Date | null
  /** When the row the plan follows was made; a closed task older than it was another claim's. */
  since?: Date
  detail: AddressDetail | Record<string, never>
  /** Absent: the steps stay as they are. */
  steps?: Partial<Record<TaskStepName, StepPlan>>
}

const done: StepPlan = { state: "done" }
const pending: StepPlan = { state: "pending" }
const skipped: StepPlan = { state: "skipped" }
const working: StepPlan = { state: "in_progress" }
const owner = (deadline?: Date): StepPlan => ({
  state: "blocked",
  blocked_on: "owner_action",
  ...(deadline && { deadline }),
})
const after = (at: string, ms: number) => new Date(Date.parse(at) + ms)

/**
 * The address task a domain row implies. A removed domain ends the task as
 * declined and an unpaid Checkout that ran out puts it off, both with the
 * steps left as they were. A connect that stopped waits on the owner's DNS
 * change, and a bought name Cloudflare refused waits on a new choice. An
 * active row leaves the site loading on it to the probe, whose check of the
 * page and its `x-reme-site` header alone marks `loads` done.
 */
export function addressPlan(d: DomainFacts): TaskPlan {
  const bought = d.origin === "purchased"
  const detail: AddressDetail = {
    name: d.name,
    origin: bought ? "purchased" : "owned",
    ...(d.provider && { provider: d.provider }),
  }
  const base = {
    find_out: done,
    choose: bought ? done : skipped,
    purchase: bought ? done : skipped,
    records: pending,
    ownership: d.needs_txt ? pending : skipped,
    certificate: pending,
    loads: pending,
  }
  const active = {
    state: "active" as const,
    done_at: null,
    detail,
    since: new Date(d.created_at),
  }
  switch (d.state) {
    case "removed":
      return { ...active, state: "declined" }
    case "abandoned":
      return { ...active, state: "later" }
    case "active":
      return {
        ...active,
        done_at: new Date(d.activated_at ?? d.created_at),
        steps: {
          ...base,
          records: done,
          ownership: d.needs_txt ? done : skipped,
          certificate: done,
          loads: working,
        },
      }
    case "awaiting_payment":
      return {
        ...active,
        steps: {
          ...base,
          purchase: {
            state: "blocked",
            blocked_on: "purchase",
            deadline: after(d.created_at, PURCHASE_HOLD_MS),
          },
        },
      }
    case "failed":
      return {
        ...active,
        steps: bought
          ? { ...base, choose: owner(), purchase: pending }
          : { ...base, records: owner() },
      }
  }
  // Paid and registering: Reme sets the records itself once it is registered.
  if (bought && !d.registered)
    return { ...active, steps: { ...base, purchase: working } }
  if (d.state !== "verifying")
    return {
      ...active,
      steps: {
        ...base,
        records: bought
          ? working
          : owner(after(d.created_at, CONNECT_DEADLINE_MS)),
      },
    }
  // Records seen: Cloudflare proves the host, then issues the certificate.
  const valid = d.check === "valid"
  const host = valid || d.check === "pending_certificate"
  return {
    ...active,
    steps: {
      ...base,
      records: done,
      ownership: !d.needs_txt ? skipped : host ? done : working,
      certificate: valid ? done : d.needs_txt && !host ? pending : working,
      loads: valid ? working : pending,
    },
  }
}

/**
 * The Google task a connection implies. Ended or declined, the task is
 * declined with its steps as they were; first data is pending until Google
 * has some, so a site Google reads but nobody has seen yet is Coming up, and
 * the task is done once it has.
 */
export function googlePlan(g: GoogleFacts): TaskPlan {
  if (g.state === "revoked")
    return { state: "declined", done_at: null, detail: {} }
  const p = g.property
  const verified = p?.state === "verified" || p?.state === "stale"
  const steps = {
    sign_in: g.state === "needs_reauth" ? owner() : done,
    permissions:
      g.state === "needs_permission"
        ? { state: "blocked" as const, blocked_on: "permission" as const }
        : g.state === "needs_reauth"
          ? pending
          : done,
    verify: verified ? done : p?.state === "failed" ? owner() : working,
    sitemap: p?.sitemap ? done : verified ? working : pending,
    first_data: g.data ? done : pending,
  }
  return { state: "active", done_at: null, detail: {}, steps }
}

/**
 * Applies a plan to the newest task of its kind: the open one, or a closed
 * one that follows the same row (Google's one connection, or the same domain
 * claim), which opens again if the plan says so; otherwise a new task. Then
 * the steps, and last the task's state from them: an active plan whose steps
 * are all done or skipped is done, keeping its first `done_at`.
 */
async function apply(
  db: OrgScopedDb,
  orgId: string,
  kind: TaskKind,
  plan: TaskPlan
) {
  const [latest] = await db
    .select({
      id: ownerTasks.id,
      open: sql<boolean>`${ownerTasks.state} in ('active', 'later')`,
      name: sql<string | null>`${ownerTasks.detail}->>'name'`,
      createdAt: ownerTasks.createdAt,
    })
    .from(ownerTasks)
    .where(eq(ownerTasks.kind, kind))
    .orderBy(
      sql`${ownerTasks.state} in ('active', 'later') desc`,
      sql`${ownerTasks.createdAt} desc`
    )
    .limit(1)
  const name = "name" in plan.detail ? plan.detail.name : undefined
  const same =
    latest &&
    (latest.open ||
      kind === "google" ||
      (latest.name === name && (!plan.since || latest.createdAt >= plan.since)))
  let id: string
  if (same) id = latest.id
  else {
    const [row] = await db
      .insert(ownerTasks)
      .values({ orgId, kind, detail: plan.detail })
      .returning({ id: ownerTasks.id })
    id = (row as { id: string }).id
    await addSteps(db, orgId, id, kind)
  }
  const steps = Object.entries(plan.steps ?? {})
  if (steps.length > 0) {
    // Every step in one statement, since `look()` syncs on each change it
    // sees. The probe's fields are never written, a done step is never moved
    // back, and a step the probe blocked with a note keeps its wait until the
    // rows say the step is done or does not apply.
    const values = sql.join(
      steps.map(
        ([step, s]) =>
          sql`(${step}, ${s.state}, ${s.blocked_on ?? null}, ${s.deadline?.toISOString() ?? null})`
      ),
      sql`, `
    )
    await db.execute(sql`
      update task_steps s set
        state = v.state::task_step_state,
        blocked_on = v.blocked_on::task_blocked_on,
        deadline = v.deadline::timestamptz,
        note = case when v.state = 'blocked' then s.note end,
        changed_at = case when s.state::text <> v.state then now() else s.changed_at end
      from (values ${values}) as v(step, state, blocked_on, deadline)
      where s.task_id = ${id} and s.step::text = v.step and s.state <> 'done'
        and not (s.state = 'blocked' and s.note is not null
          and v.state not in ('done', 'skipped'))`)
  }
  await db.execute(sql`
    update owner_tasks t set
      state = x.state::task_state,
      later_until = case when x.state = 'later' then t.later_until end,
      detail = t.detail || ${JSON.stringify(plan.detail)}::jsonb,
      done_at = case when x.state = 'done' then
        coalesce(t.done_at, ${plan.done_at?.toISOString() ?? null}::timestamptz, now()) end
    from (select case
      when ${plan.state} <> 'active' then ${plan.state}
      when exists (select 1 from task_steps s where s.task_id = ${id}
        and s.state not in ('done', 'skipped')) then 'active'
      else 'done' end as state) x
    where t.id = ${id}`)
}

/**
 * The org's address and Google tasks brought in line with its `domains` and
 * `search_connections` rows: the back-fill, and the one call each site makes
 * after it writes either. The domain followed is the newest live claim, else
 * the newest row. Idempotent: the same rows write the same states, and
 * `changed_at` moves only when a state does. Run inside the writer's
 * `withOrg`, so the task changes with the row or not at all. A connect gives
 * the number of changes its card listed, which no row holds.
 */
export async function syncTasks(
  db: OrgScopedDb,
  orgId: string,
  address: Pick<AddressDetail, "changes"> = {}
) {
  // One sync per org at a time, so two connects at once cannot both make the
  // task. Key 6: 2 to 5 are taken (turns, assets, domain claims, facts).
  await db.execute(
    sql`select pg_advisory_xact_lock(6, hashtext(${orgId}::text))`
  )
  const [row] = await db.execute<{
    domain: DomainFacts | null
    google: GoogleFacts | null
  }>(sql`
    select
      (select json_build_object('name', d.name, 'origin', d.origin, 'state', d.state,
        'needs_txt', d.needs_txt, 'check', d.last_check->>'status',
        'registered', coalesce(d.registration->>'status' = 'registered'
          or d.registration->>'outcome' in ('registered', 'test_registered'), false),
        'provider', d.provider->>'name', 'created_at', d.created_at,
        'activated_at', d.activated_at)
        from domains d order by d.state < 'failed' desc, d.created_at desc
        limit 1) as domain,
      (select json_build_object('state', c.state,
        'property', (select json_build_object('state', p.state,
          'sitemap', p.sitemap->>'submitted_at' is not null)
          from search_properties p order by p.created_at desc limit 1),
        'data', exists (select 1 from search_daily s where s.impressions > 0))
        from search_connections c) as google`)
  if (row?.domain) {
    const plan = addressPlan(row.domain)
    await apply(db, orgId, "address", {
      ...plan,
      detail: { ...plan.detail, ...address },
    })
  }
  if (row?.google) await apply(db, orgId, "google", googlePlan(row.google))
}

/** The newest task of `kind` holding `step`, open first, made from the org's rows if missing. */
export async function stepOf(
  db: OrgScopedDb,
  orgId: string,
  kind: TaskKind,
  step: TaskStepName
) {
  const find = () =>
    db
      .select({ taskId: taskSteps.taskId, hash: taskSteps.probeHash })
      .from(taskSteps)
      .innerJoin(ownerTasks, eq(ownerTasks.id, taskSteps.taskId))
      .where(sql`${ownerTasks.kind} = ${kind} and ${taskSteps.step} = ${step}`)
      .orderBy(
        sql`${ownerTasks.state} in ('active', 'later') desc`,
        sql`${ownerTasks.createdAt} desc`
      )
      .limit(1)
  const [found] = await find()
  if (found) return found
  await syncTasks(db, orgId)
  const [made] = await find()
  if (!made) throw new Error(`task.missing:${kind}`)
  return made
}
