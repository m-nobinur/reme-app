import type { Proactivity } from "@workspace/contracts"
import {
  approvals,
  conversationMessages,
  deliveries,
  eq,
  events,
  facts,
  failureCode,
  inQuiet,
  jobRuns,
  newUlid,
  type OrgScopedDb,
  orgs,
  reminders,
  serverMessageId,
  sql,
  type Tenancy,
  waitedOn,
} from "@workspace/db"
import { scrub } from "@workspace/facade/tee"
import { deliverIn } from "./deliveries.ts"
import {
  askGate,
  GATE,
  overLimit,
  type Reply,
  readReply,
  type Spent,
  writerPrompt,
  writeText,
} from "./heartbeat-write.ts"
import type { Handler } from "./jobs.ts"
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
 */
export type DigestItem = {
  key: string
  since: string
  facts: Record<string, string>
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
    .select({ id: reminders.id, title: reminders.title, due: reminders.dueAt })
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

export const SOURCES: Source[] = [
  reviews,
  questions,
  approvalsWaiting,
  remindersDue,
  searchReport,
  alerts,
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

/** The ledger row that says an item was surfaced. */
export const surfacedKey = (orgId: string, key: string) =>
  `heartbeat-item:${orgId}:${key}`

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

/** The owner profile fact's text, if the org has one. */
async function ownerProfile(db: OrgScopedDb): Promise<string | null> {
  const [row] = await db
    .select({ value: facts.value })
    .from(facts)
    .where(sql`${facts.key} = 'owner.profile' and ${facts.validTo} is null`)
  if (!row) return null
  const value = row.value as { text?: unknown } | string
  return typeof value === "string"
    ? value
    : typeof value.text === "string"
      ? value.text
      : JSON.stringify(value)
}

/** The last heartbeat the owner was shown, for the writer's continuity. */
async function lastHeartbeat(
  db: OrgScopedDb,
  orgId: string
): Promise<{ text: string; at: Date } | null> {
  const [sent] = await db
    .select({ key: deliveries.key, at: deliveries.sentAt })
    .from(deliveries)
    .where(
      sql`starts_with(${deliveries.key}, ${`heartbeat:${orgId}:`}) and ${deliveries.channel} = 'in_app' and ${deliveries.state} = 'sent'`
    )
    .orderBy(sql`${deliveries.sentAt} desc`)
    .limit(1)
  if (!sent?.at) return null
  const [message] = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, serverMessageId(sent.key)))
  const content = message?.content as
    | { parts?: { type: string; text?: string }[] }
    | undefined
  const parts = content?.parts ?? []
  const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
  return text.length > 0 ? { text: text.join(" "), at: sent.at } : null
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

/** The two model calls, apart from the key, so a test can stand in for them. */
export type Models = {
  gate: (state: Parameters<typeof askGate>[1]) => ReturnType<typeof askGate>
  write: (system: string, data: unknown) => ReturnType<typeof writeText>
}

const liveModels = (env: Env): Models => ({
  gate: (state) => askGate(env.OPENROUTER_API_KEY, state),
  write: (system, data) => writeText(env.OPENROUTER_API_KEY, system, data),
})

/** What the model step needs, read inside the run's transaction. */
type Beat = Look & {
  orgId: string
  jobId: string
  /** The run's `run_at`: the `job_runs` row this beat updates, and its delivery's slot. */
  slot: Date
  level: Exclude<Proactivity, "off">
  /** The owner typed since the last heartbeat, so the app is enough. */
  typed: boolean
}

/**
 * The model step, after the run has committed its ledger rows. Jev looks
 * first and costs nothing to the day's cap; on a yes the beat takes the
 * day's one unprompted message (`unprompted:<org>:<local date>`) before the
 * writer runs, and gives it back when the writer stays quiet or fails, so a
 * later beat that day can still speak. Every model call is logged as a
 * `cos.background_step` so the CoS's daily cap counts it.
 */
async function speak(kit: Tenancy, env: Env, models: Models, beat: Beat) {
  const { orgId, jobId, slot } = beat
  const thisRun = sql`${jobRuns.jobId} = ${jobId} and ${jobRuns.runAt} = ${slot.toISOString()}::timestamptz`
  const record = (outcome: "ok" | "skipped" | "failed", detail: string) =>
    kit.withOrg({ orgId }, (db) =>
      db
        .update(jobRuns)
        .set({ outcome, detail: detail.slice(0, 500) })
        .where(thisRun)
    )
  const spend = (job: string, outcome: string, spent: Spent) =>
    kit.withOrg({ orgId }, (db) =>
      db.insert(events).values({
        eventId: newUlid(),
        orgId,
        staffId: null,
        assignmentId: null,
        type: "cos.background_step",
        occurredAt: new Date(),
        idempotencyKey: newUlid(),
        payload: { job, outcome, ...spent },
      })
    )

  const { state, data } = modelInput(beat)
  let gate: Awaited<ReturnType<Models["gate"]>>
  try {
    gate = await models.gate(state)
  } catch (error) {
    return record("failed", `gate_error:${failureCode(error)}`)
  }
  const pass = gate.probability >= GATE.threshold[beat.level]
  await spend("heartbeat_gate", pass ? "pass" : "stop", gate.spent)
  if (!pass) return record("skipped", `gate:${gate.probability.toFixed(2)}`)

  const cap = `unprompted:${orgId}:${localDate(beat.now, beat.zone)}`
  const took = await kit.withOrg({ orgId }, (db) =>
    db
      .insert(deliveries)
      .values({ orgId, key: cap, channel: "in_app", state: "sent" })
      .onConflictDoNothing()
      .returning({ key: deliveries.key })
  )
  if (took.length === 0) return record("skipped", "capped")

  let reply: Reply
  try {
    const written = await models.write(writerPrompt(beat.level), data)
    reply = replyOf(written.text)
    await spend("heartbeat_writer", reply.kind, written.spent)
  } catch (error) {
    reply = { kind: "error", detail: `writer_error:${failureCode(error)}` }
  }
  if (reply.kind !== "message") {
    await kit.withOrg({ orgId }, (db) =>
      db.delete(deliveries).where(eq(deliveries.key, cap))
    )
    return reply.kind === "quiet"
      ? record("skipped", `quiet: ${reply.reason}`)
      : record("failed", reply.detail)
  }

  const { text } = reply
  const chip = beat.items.find((item) => item.facts.chip)?.facts.chip
  const key = `heartbeat:${orgId}:${jobId}:${slot.toISOString()}`
  const sends = await kit.withOrg({ orgId }, async (db) => {
    const out = [
      await deliverIn(db, env, {
        orgId,
        key,
        channel: "in_app",
        message: {
          text: [text],
          ...(chip && {
            button: { label: chip, action: { kind: "ask", text: chip } },
          }),
        },
      }),
    ]
    // At most one a day, since the cap above holds the day's one message.
    if (!beat.typed)
      out.push(
        await deliverIn(db, env, {
          orgId,
          key: `${key}:email`,
          channel: "email",
          subject: "An update from Reme",
          text,
        })
      )
    await db
      .update(jobRuns)
      .set({
        outcome: "ok",
        detail: out.length > 1 ? "sent:in_app,email" : "sent:in_app",
      })
      .where(thisRun)
    return out
  })
  await Promise.all(sends.map((send) => send?.()))
}

/**
 * The handler, over `sources`. Quiet hours are checked again here, since a
 * retry after a failure is timed by the backoff, not the rule. A digest that
 * throws rolls the run back, ledger included, and the run is recorded
 * failed: a source that could not be read is not a change. The models run in
 * `after`, once the ledger has committed; what they decide is written to the
 * run's `job_runs` row then.
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
      return { outcome: "skipped", detail: "off" }
    if (
      inQuiet(now, org.timeZone, { start: org.quietStart, end: org.quietEnd })
    )
      return { outcome: "skipped", detail: "quiet_hours" }
    if (await ownerActive(db, job.orgId, now))
      return { outcome: "skipped", detail: "owner_active" }
    const items = await digest(db, now, sources)
    if (items.length === 0) return { outcome: "skipped", detail: "empty" }
    const fresh = await unsurfaced(db, job.orgId, items)
    if (fresh.length === 0) return { outcome: "skipped", detail: "unchanged" }
    // Detection time is the state boundary: the keys are surfaced before any
    // model looks, so a model that fails does not raise them again.
    await surface(db, job.orgId, fresh, now)
    const last = await lastHeartbeat(db, job.orgId)
    const beat: Beat = {
      orgId: job.orgId,
      jobId: job.id,
      slot: job.nextRunAt,
      level: org.proactivity,
      zone: org.timeZone,
      now,
      items: fresh,
      profile: await ownerProfile(db),
      last,
      typed: await typedSince(db, last?.at ?? job.createdAt),
    }
    return {
      outcome: "ok",
      detail: `new:${fresh.length}`,
      after: async () => {
        await speak(kit, env, models(env), beat)
      },
    }
  }
}

export const heartbeatJob = heartbeatWith()
