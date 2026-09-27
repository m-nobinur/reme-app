import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { events } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

/**
 * How a steer's Idempotency-Key is kept in its `assignment.steered` event: a
 * SHA-256, never the key itself, since the console and activity read
 * payloads and the key is the caller's.
 */
export const steerKeyHash = (key: string) =>
  createHash("sha256").update(key).digest("hex")

/**
 * The steer an Idempotency-Key already made in the org, or null: the build it
 * went to, its words and its taint (which says who sent it). The api reads it
 * to replay a retried change against the same build; the orchestrator, to
 * replay one steer. RLS keeps it to the org.
 *
 * ponytail: the org's steered events are filtered, not indexed by key; an
 * expression index on the hash if an org's event log makes this slow.
 */
export async function steerByKey(
  db: OrgScopedDb,
  key: string
): Promise<{
  assignment_id: string
  message: unknown
  taint: string[]
} | null> {
  const [row] = await db.execute<{
    assignment_id: string
    message: unknown
    taint: string[]
  }>(sql`
    select e.assignment_id, e.payload->'message' as message, e.taint
    from ${events} e
    where e.type = 'assignment.steered'
      and e.payload->>'key_sha256' = ${steerKeyHash(key)}
    order by e.event_id
    limit 1`)
  return row ?? null
}
