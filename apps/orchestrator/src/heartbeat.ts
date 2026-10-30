import {
  CosEvent,
  OwnerProfile,
  profileText,
  type TaskBlockedOn,
  type TaskStepName,
} from "@workspace/contracts"
import {
  approvals,
  conversationMessages,
  deliveries,
  eq,
  events,
  facts,
  failureCode,
  inQuiet,
  logEvent,
  type OrgScopedDb,
  orgs,
  readTasks,
  reminders,
  sql,
  surfacedKey,
  type Tenancy,
  taskFollowups,
  unpromptedKey,
  waitedOn,
} from "@workspace/db"
import {
  askGate,
  GATE,
  type Look,
  logSpend,
  modelInput,
  reserve,
  trustedContacts,
  worstGate,
} from "./heartbeat-write.ts"
import type { Handler, Settled } from "./jobs.ts"
import { weeklyItem } from "./search-sync.ts"

/**
 * The `heartbeat` job (ADR-043): on the org's proactivity rule and never in
 * its quiet hours, look at what needs the owner and decide whether it is
 * worth a message. The look is code. Each item is keyed by its cause and
 * carries absolute times only, so a digest read an hour later is the same
 * digest, and an item already surfaced is dropped by its key. A beat with
 * nothing new costs no model call.
 */

/**
 * One thing that may need the owner. `key` is `<kind>:<entity id>:<seq>`,
 * where the sequence moves when the entity changes in a way worth hearing
 * about again; `since` is when it began. No relative text anywhere.
 * `trusted` names the facts that code or the owner wrote, whose links and
 * numbers a message may repeat; everything else is someone else's text.
 */
export type DigestItem = {
  key: string
  since: string
  facts: Record<string, string>
  trusted?: string[]
}

export type Source = (db: OrgScopedDb, now: Date) => Promise<DigestItem[]>

const DAY = 86_400_000
/** How far back a review or an alert is still news on an org's first beat; after it, the ledger decides. */
const LOOKBACK_MS = 7 * DAY
/** A CoS turn this recent means the owner is in the chat, where the CoS can raise anything itself. */
export const ACTIVE_MS = 15 * 60_000

const iso = (at: Date) => at.toISOString()
const ago = (now: Date, ms: number) => iso(new Date(now.getTime() - ms))

/** Customer reviews the owner had recorded for the site. */
const reviews: Source = async (db, now) => {
  const rows = await db
    .select({
      id: facts.id,
      version: facts.version,
      value: facts.value,
      at: facts.createdAt,
    })
    .from(facts)
    .where(
      sql`starts_with(${facts.key}, 'testimonials.review_') and ${facts.validTo} is null and ${facts.createdAt} > ${ago(now, LOOKBACK_MS)}::timestamptz`
    )
  return rows.map((row) => ({
    key: `review:${row.id}:${row.version}`,
    since: iso(row.at),
    facts: { name: String((row.value as { name?: unknown }).name ?? "") },
  }))
}

/** What the Developer is waiting on the owner to answer. */
const questions: Source = async (db) =>
  (await waitedOn(db, undefined, { unanswered: true })).map((waited) => {
    const request = waited.request as {
      request_id: string
      requested_at: string
      field: string
      why: string
    }
    return {
      key: `question:${request.request_id}:1`,
      since: request.requested_at,
      facts: { field: request.field, why: request.why },
    }
  })

/** Reviews of the site that have waited on the owner for more than a day. */
const approvalsWaiting: Source = async (db, now) => {
  const rows = await db
    .select({
      id: approvals.id,
      action: approvals.actionKind,
      at: approvals.requestedAt,
      expires: approvals.expiresAt,
    })
    .from(approvals)
    .where(
      sql`${approvals.decision} is null and ${approvals.requestedAt} <= ${ago(now, DAY)}::timestamptz and ${approvals.expiresAt} > ${iso(now)}::timestamptz`
    )
  return rows.map((row) => ({
    key: `approval:${row.id}:1`,
    since: iso(row.at),
    facts: { action: row.action, expires_at: iso(row.expires) },
  }))
}

/** Reminders coming due in the next day. The reminder job says each one at its time. */
const remindersDue: Source = async (db, now) => {
  const rows = await db
    .select({
      id: reminders.id,
      title: reminders.title,
      due: reminders.dueAt,
      source: reminders.source,
    })
    .from(reminders)
    .where(
      sql`${reminders.doneAt} is null and ${reminders.dueAt} > ${iso(now)}::timestamptz and ${reminders.dueAt} <= ${ago(now, -DAY)}::timestamptz`
    )
  return rows.flatMap((row) =>
    row.due
      ? [
          {
            key: `reminder:${row.id}:${iso(row.due)}`,
            since: iso(row.due),
            facts: { title: row.title },
            // One the assistant made may carry words it read somewhere.
            trusted: row.source === "owner" ? ["title"] : [],
          },
        ]
      : []
  )
}

/** Site, domain and search alerts: one item per `alert.raised`. */
const alerts: Source = async (db, now) => {
  const rows = await db
    .select({
      id: events.eventId,
      at: events.occurredAt,
      payload: events.payload,
    })
    .from(events)
    .where(
      sql`${events.type} = 'alert.raised' and ${events.occurredAt} > ${ago(now, LOOKBACK_MS)}::timestamptz`
    )
  return rows.map((row) => {
    const payload = row.payload as { kind?: unknown; primary_host?: unknown }
    const kind = String(payload.kind ?? "unknown")
    return {
      key: `${kind.startsWith("search.") ? "search_alert" : "alert"}:${row.id}:1`,
      since: iso(row.at),
      facts: {
        alert: kind,
        ...(typeof payload.primary_host === "string" && {
          host: payload.primary_host,
        }),
      },
      trusted: ["host"],
    }
  })
}

/**
 * The weekly search report (search-sync.ts), on the org's own Monday. It
 * reads before `alerts`, since reading it can raise a search alert.
 */
const searchReport: Source = async (db, now) => {
  const [org] = await db.select({ id: orgs.id, zone: orgs.timeZone }).from(orgs)
  if (!org) return []
  const day = new Date(`${localDate(now, org.zone)}T00:00:00Z`)
  if (day.getUTCDay() !== 1) return []
  const item = await weeklyItem(db, org.id, now, day)
  return item ? [item] : []
}

/**
 * How long a step waits on the owner before one follow-up asks about it, by
 * what it waits for. A purchase gets none: the Checkout holds the name for
 * 140 minutes (`PURCHASE_HOLD_MS`) and then the task is put off, all inside
 * the gap between two beats.
 */
const FOLLOW_UP_AFTER: Partial<Record<TaskBlockedOn, number>> = {
  // A day to act unprompted; a DNS change still has two of its three days left.
  owner_action: DAY,
  approval: DAY,
  // Search sync said it the day it was seen, so asking again sooner nags.
  permission: 2 * DAY,
}

/** Each step in the owner's words, since the writer must never say a step name. */
const STEP_WORDS: Record<TaskStepName, string> = {
  find_out: "whether you already have a web address",
  choose: "choosing a name",
  purchase: "buying the name",
  records: "your DNS change",
  ownership: "proving the address is yours",
  certificate: "the security certificate",
  loads: "the site loading on its new address",
  sign_in: "signing in to Google",
  permissions: "giving Google permission",
  verify: "Google checking the site is yours",
  sitemap: "sending your pages to Google",
  first_data: "your first search numbers",
}

/** `task:{id}:{step}:{state}`: a follow-up's ledger key and its `task_followups` row. */
const isFollowUp = (item: DigestItem) => item.key.startsWith("task:")

/**
 * Follow-ups: each step of an active task that has waited on the owner longer
 * than `FOLLOW_UP_AFTER`, unless one was sent for it before, with its note
 * and the task's steps done in the last day (longer than any gap between
 * beats, quiet hours included).
 */
const followUps: Source = async (db, now) => {
  const sent = new Set(
    (
      await db
        .select({ fingerprint: taskFollowups.fingerprint })
        .from(taskFollowups)
    ).map((row) => row.fingerprint)
  )
  return (await readTasks(db)).flatMap((task) => {
    if (task.state !== "active") return []
    const name = task.kind === "address" ? task.detail.name : undefined
    const done = task.steps
      .filter((s) => s.state === "done" && (s.changed_at ?? "") > ago(now, DAY))
      .map((s) => STEP_WORDS[s.step])
    return task.steps.flatMap((s) => {
      const wait = s.blocked_on && FOLLOW_UP_AFTER[s.blocked_on]
      const key = `task:${task.id}:${s.step}:${s.state}`
      if (s.state !== "blocked" || !wait || !s.changed_at || sent.has(key))
        return []
      if (s.changed_at > ago(now, wait)) return []
      return [
        {
          key,
          since: s.changed_at,
          facts: {
            waiting_for: STEP_WORDS[s.step],
            ...(s.note && { note: s.note }),
            ...(s.deadline && { deadline: s.deadline }),
            ...(name && { name }),
            ...(done.length > 0 && { done_lately: done.join(", ") }),
          },
          // Code wrote both: the note from a fixed string, the name from the domain row.
          trusted: ["note", "name"],
        },
      ]
    })
  })
}

export const SOURCES: Source[] = [
  reviews,
  questions,
  approvalsWaiting,
  remindersDue,
  searchReport,
  alerts,
  followUps,
]

/** Every source's items, sorted by key. A source that fails fails the digest. */
export async function digest(
  db: OrgScopedDb,
  now: Date,
  sources: Source[] = SOURCES
): Promise<DigestItem[]> {
  const items: DigestItem[] = []
  for (const source of sources) items.push(...(await source(db, now)))
  return items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** The items the ledger has not seen. */
async function unsurfaced(
  db: OrgScopedDb,
  orgId: string,
  items: DigestItem[]
): Promise<DigestItem[]> {
  const seen = new Set(
    (
      await db
        .select({ key: deliveries.key })
        .from(deliveries)
        .where(
          sql`${deliveries.key} in (${sql.join(
            items.map((item) => sql`${surfacedKey(orgId, item.key)}`),
            sql`, `
          )})`
        )
    ).map((row) => row.key)
  )
  return items.filter((item) => !seen.has(surfacedKey(orgId, item.key)))
}

/**
 * Writes the ledger rows. They are `deliveries` rows that send nothing: no
 * payload, so the sweep never queues them, and settled from the start.
 */
async function surface(
  db: OrgScopedDb,
  orgId: string,
  items: DigestItem[],
  now: Date
) {
  await db
    .insert(deliveries)
    .values(
      items.map((item) => ({
        orgId,
        key: surfacedKey(orgId, item.key),
        channel: "in_app" as const,
        state: "sent" as const,
        sentAt: now,
      }))
    )
    .onConflictDoNothing()
}

/** Whether the org had a CoS turn in the last `ACTIVE_MS`. */
async function ownerActive(db: OrgScopedDb, orgId: string, now: Date) {
  const [row] = await db.execute<{ active: boolean }>(sql`
    select exists (
      select 1 from ${events}
      where org_id = ${orgId} and type = 'cos.context'
        and occurred_at > ${ago(now, ACTIVE_MS)}::timestamptz
    ) as active`)
  return row?.active === true
}

const bySince = (a: DigestItem, b: DigestItem) =>
  a.since < b.since ? -1 : a.since > b.since ? 1 : 0

/**
 * The owner answering a follow-up dismisses it: whatever they typed next, a
 * reply or a "not now", closes it for good. The row stays, so its
 * fingerprint is never sent again.
 */
const dismissAnswered = (db: OrgScopedDb) =>
  db.execute(sql`
    with answered as (
      select f.fingerprint, (
        select min(m.created_at) from ${conversationMessages} m
        where m.content->>'role' = 'user' and m.created_at > f.sent_at
      ) as at
      from ${taskFollowups} f where f.dismissed_at is null)
    update ${taskFollowups} f set dismissed_at = a.at
    from answered a where f.fingerprint = a.fingerprint and a.at is not null`)

/** Puts this beat's follow-ups back, when what stopped them was not a decision about them. */
async function giveBack(db: OrgScopedDb, orgId: string, items: DigestItem[]) {
  const keys = items.filter(isFollowUp).map((i) => surfacedKey(orgId, i.key))
  if (keys.length === 0) return
  await db.delete(deliveries).where(
    sql`${deliveries.key} in (${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `
    )})`
  )
}

/** The owner profile fact's text, if the org has one. */
async function ownerProfile(db: OrgScopedDb): Promise<string | null> {
  const [row] = await db
    .select({ value: facts.value })
    .from(facts)
    .where(sql`${facts.key} = 'owner.profile' and ${facts.validTo} is null`)
  if (!row) return null
  // The lines only: never ids or sources, and nothing when the value does not parse.
  const parsed = OwnerProfile.safeParse(row.value)
  return parsed.success && parsed.data.lines.length > 0
    ? profileText(parsed.data.lines)
    : null
}

/** When the owner was last shown a heartbeat. */
async function lastHeartbeat(
  db: OrgScopedDb,
  orgId: string
): Promise<Date | null> {
  const [sent] = await db
    .select({ at: deliveries.sentAt })
    .from(deliveries)
    .where(
      sql`starts_with(${deliveries.key}, ${`heartbeat:${orgId}:`}) and ${deliveries.channel} = 'in_app' and ${deliveries.state} = 'sent'`
    )
    .orderBy(sql`${deliveries.sentAt} desc`)
    .limit(1)
  return sent?.at ?? null
}

/** Whether the owner typed in any conversation at or after `since`. */
async function typedSince(db: OrgScopedDb, since: Date) {
  const [row] = await db.execute<{ typed: boolean }>(sql`
    select exists (
      select 1 from ${conversationMessages}
      where content->>'role' = 'user'
        and created_at >= ${since.toISOString()}::timestamptz
    ) as typed`)
  return row?.typed === true
}

/** `2026-10-19`, the date at `at` in `zone`. */
const localDate = (at: Date, zone: string | null) =>
  at.toLocaleDateString("en-CA", { timeZone: zone ?? "UTC" })

/** Jev's call, apart from the key, so a test can stand in for it. */
export type Models = {
  gate: (state: Parameters<typeof askGate>[1]) => ReturnType<typeof askGate>
}

const liveModels = (env: Env): Models => ({
  gate: (state) => askGate(env.OPENROUTER_API_KEY, state),
})

/** What the model step needs, read inside the run's transaction. */
type Beat = Look & {
  orgId: string
  jobId: string
  /** The run's `run_at`, the slot its delivery is keyed on. */
  slot: Date
  /** The owner typed since the last heartbeat, so the app is enough. */
  typed: boolean
}

/**
 * The model step, after the run has committed its ledger rows. Jev looks
 * first. On a yes, while the day's one unprompted message is still free and
 * the owner is not in the chat, the items go in the CoS log as a `schedule`
 * event and a proactive CoS turn is handed to the api (`wake.ts` there). The
 * turn may stay `[quiet]`; it takes the day's message
 * (`unprompted:<org>:<local date>`) only when it posts. Jev's call is
 * reserved against the CoS's daily cap first, and is not made without room.
 */
async function speak(
  kit: Tenancy,
  env: Env,
  models: Models,
  beat: Beat
): Promise<Settled> {
  const { orgId, jobId, slot } = beat
  const record = (outcome: Settled["outcome"], detail: string): Settled => ({
    outcome,
    detail,
  })
  // A follow-up that a failure, the cap or a turn kept back is asked about on
  // a later beat; one Jev or the turn turned down is not.
  const putBack = () =>
    kit.withOrg({ orgId }, (db) => giveBack(db, orgId, beat.items))

  const { state, summary } = modelInput(beat)
  let gate: Awaited<ReturnType<Models["gate"]>>
  let reservation: string | null
  try {
    reservation = await reserve(kit, orgId, "heartbeat_gate", worstGate(state))
    if (!reservation) {
      await putBack()
      return record("no_change", "over_cap")
    }
    gate = await models.gate(state)
  } catch (error) {
    await putBack()
    return record("failed", `gate_error:${failureCode(error)}`)
  }
  const pass = gate.probability >= GATE.floor
  await logSpend(
    kit,
    orgId,
    reservation,
    "heartbeat_gate",
    pass ? "pass" : "stop",
    gate.spent
  )
  if (!pass) return record("no_change", `gate:${gate.probability.toFixed(2)}`)

  const handed = await kit.withOrg({ orgId }, async (db) => {
    const cap = unpromptedKey(orgId, localDate(beat.now, beat.zone))
    const [taken] = await db
      .select({ key: deliveries.key })
      .from(deliveries)
      .where(eq(deliveries.key, cap))
    if (taken) return "capped"
    // A turn may have begun while Jev looked; then the chat is the place.
    if (await ownerActive(db, orgId, beat.now)) return "owner_active"
    const logged = await logEvent(
      db,
      { orgId, staffId: null, assignmentId: null },
      {
        type: "cos.event",
        payload: CosEvent.parse({
          source: "schedule",
          summary,
          evidence: [],
          wake: false,
        }),
        taint: ["inferred", "untrusted_input"],
      }
    )
    if (logged !== "logged") return logged
    return "handed"
  })
  if (handed !== "handed") {
    await putBack()
    return record("no_change", handed)
  }
  const chip = beat.items.find((item) => item.facts.chip)?.facts.chip
  await env.AFTER_TURN.send({
    kind: "cos_wake",
    orgId,
    jobId,
    slot: slot.toISOString(),
    beat: {
      // At most one a day, since the turn posts only while the day's message is free.
      email: !beat.typed,
      trusted: trustedContacts(beat.items),
      ...(chip && { chip }),
      follow_ups: beat.items.filter(isFollowUp).map((item) => item.key),
    },
  })
  return record("done", "handed")
}

/**
 * The handler, over `sources`. Quiet hours are checked again here, since a
 * retry after a failure is timed by the backoff, not the rule. A digest that
 * throws rolls the run back, ledger included, and the run is recorded
 * failed: a source that could not be read is not a change. The models run in
 * `after`, once the ledger has committed; what they decide is returned for
 * the runner to write to the run's `job_runs` row.
 */
export function heartbeatWith(
  sources: Source[] = SOURCES,
  models: (env: Env) => Models = liveModels
): Handler {
  return async ({ db, kit, env, job, now }) => {
    const [org] = await db
      .select({
        proactivity: orgs.proactivity,
        timeZone: orgs.timeZone,
        quietStart: orgs.quietStart,
        quietEnd: orgs.quietEnd,
      })
      .from(orgs)
    if (!org || org.proactivity === "off")
      return { outcome: "no_change", detail: "off" }
    if (
      inQuiet(now, org.timeZone, { start: org.quietStart, end: org.quietEnd })
    )
      return { outcome: "no_change", detail: "quiet_hours" }
    if (await ownerActive(db, job.orgId, now))
      return { outcome: "no_change", detail: "owner_active" }
    await dismissAnswered(db)
    const items = await digest(db, now, sources)
    if (items.length === 0) return { outcome: "no_change", detail: "empty" }
    const unseen = await unsurfaced(db, job.orgId, items)
    // One thing per message: the news as before, else the longest wait. The
    // other follow-ups stay unsurfaced for a later day's message.
    const news = unseen.filter((item) => !isFollowUp(item))
    const fresh =
      news.length > 0
        ? news
        : unseen.filter(isFollowUp).sort(bySince).slice(0, 1)
    if (fresh.length === 0) return { outcome: "no_change", detail: "unchanged" }
    // Detection time is the state boundary: the keys are surfaced before any
    // model looks, so a model that fails does not raise them again.
    await surface(db, job.orgId, fresh, now)
    const beat: Beat = {
      orgId: job.orgId,
      jobId: job.id,
      slot: job.nextRunAt,
      zone: org.timeZone,
      now,
      items: fresh,
      profile: await ownerProfile(db),
      typed: await typedSince(
        db,
        (await lastHeartbeat(db, job.orgId)) ?? job.createdAt
      ),
    }
    return {
      outcome: "done",
      detail: `new:${fresh.length}`,
      after: () => speak(kit, env, models(env), beat),
    }
  }
}

export const heartbeatJob = heartbeatWith()
