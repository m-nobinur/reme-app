import {
  approvals,
  deliveries,
  events,
  facts,
  inQuiet,
  type OrgScopedDb,
  orgs,
  reminders,
  sql,
  waitedOn,
} from "@workspace/db"
import type { Handler } from "./jobs.ts"

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

export const SOURCES: Source[] = [
  reviews,
  questions,
  approvalsWaiting,
  remindersDue,
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

/**
 * The handler, over `sources`. Quiet hours are checked again here, since a
 * retry after a failure is timed by the backoff, not the rule. A digest that
 * throws rolls the run back, ledger included, and the run is recorded
 * failed: a source that could not be read is not a change.
 */
export function heartbeatWith(sources: Source[] = SOURCES): Handler {
  return async ({ db, job, now }) => {
    const [org] = await db
      .select({
        timeZone: orgs.timeZone,
        quietStart: orgs.quietStart,
        quietEnd: orgs.quietEnd,
      })
      .from(orgs)
    if (
      org &&
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
    return { outcome: "ok", detail: `new:${fresh.length}` }
  }
}

export const heartbeatJob = heartbeatWith()
