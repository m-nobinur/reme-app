import { sql } from "drizzle-orm"
import { newUlid } from "./events.ts"
import { events } from "./schema.ts"
import type { OrgScopedDb, Tenancy } from "./tenancy.ts"

/** The cap on an org's CoS and onboarding spend per UTC day: $100, the owner's call (2026-10-01), so testing never hits it. */
export const DAILY_CAP_USD = 100

/**
 * Whether the org's CoS spend today, with `amount` added, stays within the
 * cap. It takes the org's budget lock (key 3), always after the
 * conversation's (key 2), and holds it to the end of the transaction, so a
 * second turn in another conversation sums after this one has reserved.
 * Closed turns count their cost, open ones their reservation, and abandoned
 * ones the greater of their logged spend and their reservation, since their
 * last step's usage is lost. A
 * turn counts on the UTC day its `cos.context` was recorded, by the
 * database's clock, the same clock that decides when a turn lapses. A
 * wait on the lock past the statement limit ends in 57014, which the api
 * answers as 503 `transient`.
 */
export async function withinCap(
  db: OrgScopedDb,
  orgId: string,
  amount: number
): Promise<boolean> {
  await db.execute(
    sql`select pg_advisory_xact_lock(3, hashtext(${orgId}::text))`
  )
  const [row] = await db.execute<{ spent: number }>(sql`
    select coalesce(sum(case
        when t.payload is null then (c.payload->>'reserved_usd')::float8
        when t.payload->>'outcome' = 'abandoned' then greatest(
          (t.payload->>'logged_usd')::float8, (t.payload->>'reserved_usd')::float8)
        else (t.payload->>'cost_usd')::float8
      end), 0) as spent
    from ${events} c
    left join ${events} t on t.session_id = c.session_id and t.type = 'cos.turn'
      and t.payload->>'turn_id' = c.payload->>'turn_id'
    where c.org_id = ${orgId} and c.type = 'cos.context'
      and c.recorded_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)
  // Onboarding's background copy call: its cost once written, its
  // reservation until then (`onboarding-prepare.ts`). And the CoS's
  // background calls at their cost, or their reservation until a
  // `cos.background_step` settles it (`reserveSpend`).
  const [prepared] = await db.execute<{ spent: number }>(sql`
    select coalesce(sum(coalesce(
        (r.payload->>'cost_usd')::float8, (p.payload->>'reserved_usd')::float8)), 0) + (
      select coalesce(sum((b.payload->>'cost_usd')::float8), 0) from ${events} b
      where b.org_id = ${orgId} and b.type = 'cos.background_step'
        and b.recorded_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
    ) + (
      select coalesce(sum((v.payload->>'reserved_usd')::float8), 0) from ${events} v
      where v.org_id = ${orgId} and v.type = 'cos.background_reserve'
        and v.recorded_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
        and not exists (select 1 from ${events} s
          where s.org_id = v.org_id and s.type = 'cos.background_step'
            and s.payload->>'reservation_id' = v.event_id)
    ) as spent
    from ${events} p
    left join ${events} r on r.org_id = p.org_id and r.type = 'onboarding.prepared'
      and r.payload->>'conversation_id' = p.payload->>'conversation_id'
    where p.org_id = ${orgId} and p.type = 'onboarding.prepare'
      and p.recorded_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)
  return (
    Number(row?.spent ?? 0) + Number(prepared?.spent ?? 0) + amount <=
    DAILY_CAP_USD
  )
}

/**
 * A background model call's room in the day: when `withinCap` allows
 * `amount`, a `cos.background_reserve` row in the same transaction, so a
 * concurrent call sums after it. The id it returns is settled by the one
 * `settleSpend` row that names it; null means no room. A call never settled
 * (its Worker died) stays counted at `amount`, since it may still bill.
 */
export async function reserveSpend(
  db: OrgScopedDb,
  orgId: string,
  job: string,
  amount: number
): Promise<string | null> {
  if (!(await withinCap(db, orgId, amount))) return null
  const id = newUlid()
  await db.insert(events).values({
    eventId: id,
    orgId,
    staffId: null,
    assignmentId: null,
    type: "cos.background_reserve",
    occurredAt: new Date(),
    idempotencyKey: newUlid(),
    payload: { job, reserved_usd: amount },
  })
  return id
}

/**
 * A reserved call's `cos.background_step`: its billed cost replaces the
 * reservation in the cap. A failed call settles at what it may have billed.
 */
export async function settleSpend(
  kit: Tenancy,
  at: { orgId: string; staffId?: string | null },
  reservation: string,
  payload: { job: string; cost_usd: number } & Record<string, unknown>
): Promise<void> {
  await kit.withOrg({ orgId: at.orgId }, (db) =>
    db.insert(events).values({
      eventId: newUlid(),
      orgId: at.orgId,
      staffId: at.staffId ?? null,
      assignmentId: null,
      type: "cos.background_step",
      occurredAt: new Date(),
      idempotencyKey: newUlid(),
      payload: { ...payload, reservation_id: reservation },
    })
  )
}
