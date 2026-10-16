import { asc, eq } from "drizzle-orm"
import { domains } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

/**
 * The host an org's site is served on when it has an active custom domain,
 * oldest first if it somehow has two. The router's Postgres fallback calls
 * this inside the `withOrg` it already holds for a slug host, so an evicted KV
 * key redirects to the custom domain instead of serving the old address. Null
 * when the org has none. Read under the org's own row security, so it needs no
 * definer.
 */
export async function activeDomainHost(
  db: OrgScopedDb
): Promise<string | null> {
  const [row] = await db
    .select({ primaryHost: domains.primaryHost })
    .from(domains)
    .where(eq(domains.state, "active"))
    .orderBy(asc(domains.createdAt))
    .limit(1)
  return row?.primaryHost ?? null
}
