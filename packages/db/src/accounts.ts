import { sql } from "drizzle-orm"
import { memberships, users } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

/**
 * What a deleted person's `users.email` becomes (ADR-035): unique by the
 * row's own id, and on `.invalid` (RFC 2606), so it never collides and never
 * receives mail.
 */
export const tombstone = (userId: string) => `deleted+${userId}@invalid`

/**
 * Whether anyone still holds the org in context: an active membership whose
 * person has not deleted their account (ADR-035). The tombstone is the first
 * thing `DELETE /account` writes, so the org is closed from then on while its
 * owner can still resolve it to finish the deletion. The router serves
 * nothing and the publisher points at nothing for a closed org.
 */
export async function orgOpen(db: OrgScopedDb): Promise<boolean> {
  const [row] = await db.execute<{ open: boolean }>(sql`
    select exists (
      select 1 from ${memberships}
      join ${users} on ${users.id} = ${memberships.userId}
      where ${memberships.status} = 'active'
        and ${users.email} <> 'deleted+' || ${users.id} || '@invalid'
    ) as open`)
  return row?.open === true
}
