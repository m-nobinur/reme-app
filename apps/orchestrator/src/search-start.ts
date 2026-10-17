import { domains, eq, searchConnections, type Tenancy } from "@workspace/db"

/**
 * A domain going live starts the Search Console workflow for its new primary
 * host, when the org has a live Google connection. One instance per (org,
 * host), so a second start, a retried step or a host already registered is a
 * no-op. Nothing here may fail the activation: the daily sync and the next
 * publish pick up a host this missed.
 */

/** `search-{org_id}-{host}` as a Workflow id: letters, digits, `-` and `_`, 100 characters at most. */
export const searchInstanceId = (orgId: string, host: string) =>
  `search-${orgId}-${host}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)

export async function startSearch(
  env: Pick<Env, "SEARCHES">,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<void> {
  try {
    const host = await kit.withOrg({ orgId }, async (db) => {
      const [connection] = await db
        .select({ state: searchConnections.state })
        .from(searchConnections)
      if (connection?.state !== "active") return null
      const [domain] = await db
        .select({ host: domains.primaryHost })
        .from(domains)
        .where(eq(domains.id, domainId))
      return domain?.host ?? null
    })
    if (!host) return
    await env.SEARCHES.create({
      id: searchInstanceId(orgId, host),
      params: { org_id: orgId, host },
    })
  } catch (error) {
    // Already created, or not startable now; either way the domain is live.
    console.warn(
      JSON.stringify({
        code: "search.start_skipped",
        reason: error instanceof Error ? error.name : "unknown",
      })
    )
  }
}
