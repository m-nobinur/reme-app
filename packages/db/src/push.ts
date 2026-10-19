import { sql } from "drizzle-orm"
import { pushSubscriptions } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

/** How many browsers one staff member keeps; the oldest go first. */
export const PUSH_SUBSCRIPTION_CAP = 20

/**
 * Keeps a browser's subscription for a staff member. The same endpoint again
 * moves to this staff member with fresh keys and counts as the newest. Past
 * the cap the oldest are deleted, so an old phone drops out before a new
 * laptop is refused.
 */
export async function addPushSubscription(
  db: OrgScopedDb,
  sub: {
    orgId: string
    staffId: string
    endpoint: string
    p256dh: string
    auth: string
  }
): Promise<string> {
  const [row] = await db
    .insert(pushSubscriptions)
    .values(sub)
    .onConflictDoUpdate({
      target: [pushSubscriptions.orgId, pushSubscriptions.endpoint],
      set: {
        staffId: sub.staffId,
        p256dh: sub.p256dh,
        auth: sub.auth,
        createdAt: sql`now()`,
      },
    })
    .returning({ id: pushSubscriptions.id })
  await db.execute(sql`
    delete from ${pushSubscriptions} where id in (
      select id from ${pushSubscriptions} where staff_id = ${sub.staffId}
      order by created_at desc, id offset ${PUSH_SUBSCRIPTION_CAP})`)
  return (row as { id: string }).id
}
