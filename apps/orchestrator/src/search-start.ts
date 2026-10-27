import {
  domains,
  eq,
  searchConnections,
  searchProperties,
  syncTasks,
  type Tenancy,
} from "@workspace/db"
import { removeSite } from "./google.ts"
import { accessToken, searchInstanceId, startSearch } from "./search.ts"

/**
 * A domain going live starts the Search Console workflow for its new primary
 * host, when the org has a live Google connection. One instance per (org,
 * host), so a second start, a retried step or a host already registered is a
 * no-op. Nothing here may fail the activation: the daily sync and the next
 * publish pick up a host this missed.
 */

export async function startSearchForDomain(
  env: Env,
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
    await startSearch(env, orgId, host)
  } catch (error) {
    // Not startable now; either way the domain is live.
    console.warn(
      JSON.stringify({
        code: "search.start_skipped",
        reason: error instanceof Error ? error.name : "unknown",
      })
    )
  }
}

/**
 * A domain serving the site replaces `oldHost`, the free host Google may
 * already hold a property for. With Google connected, that property is let
 * go: its Workflow stopped, taken out of the owner's Search Console when Reme
 * verified and added it there, and its rows gone, so nothing syncs it again.
 * A property Reme never added at Google is not touched there. The new host's
 * own Workflow was started when the domain activated.
 *
 * Returns what to tell the owner: null when Google is not connected,
 * `added` when the new host went to Google, `moved` when an old property was
 * also let go. Safe to repeat. Never throws.
 */
export async function moveGoogle(
  env: Env,
  kit: Tenancy,
  orgId: string,
  oldHost: string
): Promise<"added" | "moved" | null> {
  try {
    const held = await kit.withOrg({ orgId }, async (db) => {
      const [connection] = await db
        .select({ state: searchConnections.state })
        .from(searchConnections)
      if (connection?.state !== "active") return null
      return db
        .select({
          siteUrl: searchProperties.siteUrl,
          state: searchProperties.state,
        })
        .from(searchProperties)
        .where(eq(searchProperties.host, oldHost))
    })
    if (held === null) return null
    if (held.length === 0) return "added"
    await env.SEARCHES.get(searchInstanceId(orgId, oldHost))
      .then((running) => running.terminate())
      // None, or one already settled.
      .catch(() => undefined)
    // Only `verified` proves Reme's `add` step put it in the owner's list.
    const added = held.filter((p) => p.state === "verified")
    if (added.length > 0) {
      try {
        const access = await accessToken(env, kit, orgId)
        for (const { siteUrl } of added) await removeSite(access, siteUrl)
      } catch (error) {
        // Left in the owner's Search Console; the move goes on.
        console.warn(
          JSON.stringify({
            code: "search.unlist_failed",
            reason: error instanceof Error ? error.name : "unknown",
          })
        )
      }
    }
    await kit.withOrg({ orgId }, async (db) => {
      await db
        .delete(searchProperties)
        .where(eq(searchProperties.host, oldHost))
      await syncTasks(db, orgId)
    })
    return "moved"
  } catch (error) {
    console.warn(
      JSON.stringify({
        code: "search.move_skipped",
        reason: error instanceof Error ? error.name : "unknown",
      })
    )
    return null
  }
}
