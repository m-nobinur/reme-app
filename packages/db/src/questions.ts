import { sql } from "drizzle-orm"
import { assignments, assignmentTransitions, events, facts } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

type Payload = Record<string, unknown>

export type Waited = {
  assignment_id: string
  /** The `information.requested` payload. */
  request: Payload
  /** Its `information.answered` payload, or null while unanswered. */
  answer: Payload | null
  /** The fact value that answer wrote, or null. */
  value: unknown
}

/**
 * The question a build waits on: the `information.requested` named by its
 * latest move into `blocked_on_information` whose event names a
 * `request_id`, with its answer and the fact value that answer wrote. A move
 * that names none, such as a resume from a pause, is passed over, and a build
 * that never named one waits on nothing.
 *
 * With `assignmentId`, that build whatever its state; without, every build
 * in `blocked_on_information`, in one query. The Workflow's wait, the
 * orchestrator's `/answer` and the owner's `/workspace` all read this, so
 * they agree on the question.
 */
export async function waitedOn(
  db: OrgScopedDb,
  assignmentId: string | null = null
): Promise<Waited[]> {
  return db.execute<Waited>(sql`
    select a.id as assignment_id, q.payload as request,
      answered.payload as answer, f.value as value
    from ${assignments} a
    cross join lateral (
      select b.payload->>'request_id' as request_id
      from ${assignmentTransitions} t
      join ${events} b on b.event_id = t.event_id
      where t.assignment_id = a.id
        and t.to_state = 'blocked_on_information'
        and b.payload->>'request_id' is not null
      order by t.version desc
      limit 1
    ) latest
    cross join lateral (
      select e.payload
      from ${events} e
      where e.assignment_id = a.id
        and e.type = 'information.requested'
        and e.payload->>'request_id' = latest.request_id
      order by e.event_id desc
      limit 1
    ) q
    left join lateral (
      select e.payload
      from ${events} e
      where e.assignment_id = a.id
        and e.type = 'information.answered'
        and e.payload->>'request_id' = latest.request_id
      order by e.event_id
      limit 1
    ) answered on true
    left join ${facts} f on f.id = (answered.payload->>'fact_id')::uuid
    where (${assignmentId}::uuid is null and a.state = 'blocked_on_information')
      or a.id = ${assignmentId}::uuid`)
}
