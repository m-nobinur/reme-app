import { GoogleConnectRequest, siteHost } from "@workspace/contracts"
import {
  activeDomainHost,
  appendEvent,
  eq,
  type OrgScopedDb,
  orgs,
  postAssistantMessage,
  searchConnections,
  searchProperties,
  setStep,
  sql,
  stepOf,
  syncTasks,
  type Tenancy,
  users,
} from "@workspace/db"
import {
  accessFor,
  addSite,
  exchangeCode,
  GoogleError,
  hasScopes,
  NeedsReauth,
  openToken,
  removeSite,
  revokeToken,
  sealToken,
  submitSitemap,
  verificationToken,
  verifyResource,
} from "./google.ts"
import { writeUpdate } from "./heartbeat-write.ts"
import {
  activeDeployment,
  dropVerification,
  writeVerification,
} from "./publish.ts"

/**
 * Search Console for the org's own Google account: the connect route, the
 * org's `site_url` guard every Google call goes through, the access token
 * from the sealed refresh token, and the step bodies of `SearchWorkflow`
 * (search-workflow.ts). google.ts holds the HTTP and the crypto; nothing here
 * logs a token, a code or a verification file name.
 */

/** R8: ids only, and the host the property is for. */
export type SearchParams = { org_id: string; host: string }

/**
 * `search-{org_id}-{host}`, cut to Workflows' id rules (letters, digits, `-`
 * and `_`, at most 100). shortcut: a host past ~55 characters is truncated,
 * so two such hosts of one org would share an instance; key by property id
 * if custom domains ever get that long.
 */
export const searchInstanceId = (orgId: string, host: string) =>
  `search-${orgId}-${host}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100)

export const siteUrlOf = (host: string) => `https://${host}/`

export type SearchRefusal = {
  refused: true
  status: 400 | 409 | 422 | 503
  class: "validation" | "transient"
  code: string
  message: string
}
const refuse = (
  status: SearchRefusal["status"],
  errorClass: SearchRefusal["class"],
  code: string,
  message: string
): SearchRefusal => ({
  refused: true,
  status,
  class: errorClass,
  code,
  message,
})

/**
 * The org's property for `siteUrl`, or a throw: a `site_url` that is not one
 * of the org's own `search_properties` rows never reaches Google, since the
 * owner's token can reach every property in their Google account.
 */
export async function ownProperty(
  kit: Tenancy,
  orgId: string,
  siteUrl: string
) {
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db
      .select()
      .from(searchProperties)
      .where(eq(searchProperties.siteUrl, siteUrl))
  )
  if (!row) throw new GoogleError("search.foreign_site", 403)
  return row
}

/**
 * An access token for the org's live connection, with the scopes it carries.
 * A refresh token Google rotated is sealed back; a revoked grant marks the
 * connection `needs_reauth` with its audit row, once, and throws `NeedsReauth`.
 */
export async function grant(
  env: Env,
  kit: Tenancy,
  orgId: string
): Promise<{ token: string; scopes: string[] }> {
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ token: searchConnections.refreshToken })
      .from(searchConnections)
      .where(eq(searchConnections.state, "active"))
  )
  if (!row?.token) throw new NeedsReauth()
  const stored = row.token
  try {
    const {
      accessToken: token,
      scopes,
      sealed,
    } = await accessFor(env, orgId, stored)
    if (sealed) {
      await kit.withOrg({ orgId }, (db) =>
        db
          .update(searchConnections)
          .set({ refreshToken: sealed, lastRefreshAt: new Date() })
          .where(eq(searchConnections.refreshToken, stored))
      )
    }
    return { token, scopes }
  } catch (error) {
    if (!(error instanceof NeedsReauth)) throw error
    await kit.withOrg({ orgId }, async (db) => {
      const flipped = await db
        .update(searchConnections)
        .set({ state: "needs_reauth" })
        .where(
          sql`${searchConnections.state} = 'active' and ${searchConnections.refreshToken} = ${stored}`
        )
        .returning({ orgId: searchConnections.orgId })
      if (flipped.length > 0) {
        await appendEvent(db, {
          orgId,
          assignmentId: null,
          staffId: null,
          type: "search.needs_reauth",
          payload: {},
        })
        await syncTasks(db, orgId)
      }
    })
    throw error
  }
}

export const accessToken = async (env: Env, kit: Tenancy, orgId: string) =>
  (await grant(env, kit, orgId)).token

/** What the `permissions` step says while the owner has to act, in chat, the panel and the Website page. */
export const NEEDS_PERMISSION = "Google needs one more permission"
export const NEEDS_SIGN_IN = "Google needs you to sign in again"

/**
 * Blocks the Google task's `permissions` step on the owner. `syncTasks` never
 * moves a done step back, so a grant that loses something after it was fine
 * has to be written to the step itself; the note keeps the wait there until
 * the rows say it is done again.
 */
export async function blockPermissions(
  db: OrgScopedDb,
  orgId: string,
  note: string
): Promise<void> {
  const { taskId } = await stepOf(db, orgId, "google", "permissions")
  await setStep(db, taskId, "permissions", {
    state: "blocked",
    blocked_on: "permission",
    note,
  })
}

/**
 * The hosts the org holds now: the free subdomain once the site is
 * published, and its live custom domain. Only these are ever verified: the
 * router serves a file on any host, and a property row can outlive the host
 * (a domain that expired, moved or was taken down), which may since be
 * another org's. With a domain live the slug host redirects to it.
 */
async function heldHosts(env: Env, kit: Tenancy, orgId: string) {
  return kit.withOrg({ orgId }, async (db) => {
    const [org] = await db
      .select({ slug: orgs.slug })
      .from(orgs)
      .where(eq(orgs.id, orgId))
    const live = org && (await activeDeployment(db, orgId))
    return {
      slug: live ? siteHost(org.slug, env.SITE_HOST_SUFFIX) : null,
      domain: await activeDomainHost(db),
    }
  })
}

/**
 * One `SearchWorkflow` per host. One already there is left running; a
 * finished one runs again. `fresh` (a reconnect) ends a live one and starts
 * it over, since its cached token step belongs to the old Google account.
 */
export async function startSearch(
  env: Env,
  orgId: string,
  host: string,
  fresh = false
) {
  const id = searchInstanceId(orgId, host)
  try {
    await env.SEARCHES.create({ id, params: { org_id: orgId, host } })
  } catch {
    const instance = await env.SEARCHES.get(id)
    const { status } = await instance.status()
    const settled = ["complete", "errored", "terminated"].includes(status)
    if (fresh && !settled) {
      await instance.terminate().catch(() => {
        // It settled after the status was read; the restart still runs.
      })
    }
    if (fresh || settled) await instance.restart()
  }
}

/**
 * Everything Search Console holds for one host of the org: its verification
 * stopped, its files no longer served, the property taken out of the owner's
 * Search Console, its property row gone (the child rows cascade). For a host
 * the org lets go of, so a file of this org's never proves the host for
 * whoever holds it next. The files go before the row, which is how a repeat
 * finds them. Only a property Reme added is taken out of Search Console, and
 * its row goes only once Google has let it go (2xx, or 404 when it is gone);
 * otherwise it stays for the hourly `forgetStrays` to try again, and this
 * answers false. `unlist` false leaves Google alone (a disconnect, whose
 * grant is already revoked). Safe to repeat.
 */
export async function forgetHost(
  env: Env,
  kit: Tenancy,
  orgId: string,
  host: string,
  unlist = true
): Promise<boolean> {
  try {
    const running = await env.SEARCHES.get(searchInstanceId(orgId, host))
    await running.terminate()
  } catch {
    // None, or one already settled.
  }
  const where = eq(searchProperties.host, host)
  const rows = await kit.withOrg({ orgId }, (db) =>
    db
      .select({
        siteUrl: searchProperties.siteUrl,
        token: searchProperties.token,
        method: searchProperties.method,
        verifiedAt: searchProperties.verifiedAt,
      })
      .from(searchProperties)
      .where(where)
  )
  if (rows.length === 0) return true
  for (const row of rows) {
    if (row.token && row.method === "file") {
      await dropVerification(env, host, row.token)
    }
  }
  // Only what Reme's `add` step may have put in the list (`verifiedAt` is
  // stamped before it); a property the owner added there themselves is theirs.
  const added = unlist ? rows.filter((r) => r.verifiedAt) : []
  if (added.length > 0) {
    try {
      const access = await accessToken(env, kit, orgId)
      for (const { siteUrl } of added) await removeSite(access, siteUrl)
    } catch (error) {
      console.warn(
        JSON.stringify({
          code: "search.unlist_failed",
          reason: error instanceof Error ? error.name : "unknown",
        })
      )
      return false
    }
  }
  await kit.withOrg({ orgId }, async (db) => {
    await db.delete(searchProperties).where(where)
    await syncTasks(db, orgId)
  })
  return true
}

/**
 * The hourly retry of `forgetHost`: of `orgIds` with a live connection, every
 * property row for a host the site is no longer served on (its live domain,
 * else its free host) is let go again. An org that throws is logged and
 * skipped. Returns how many hosts went.
 */
export async function forgetStrays(
  env: Env,
  kit: Tenancy,
  orgIds: string[]
): Promise<number> {
  let gone = 0
  for (const orgId of orgIds) {
    try {
      const strays = await kit.withOrg({ orgId }, async (db) => {
        const [connection] = await db
          .select({ state: searchConnections.state })
          .from(searchConnections)
        if (connection?.state !== "active") return []
        const [org] = await db
          .select({ slug: orgs.slug })
          .from(orgs)
          .where(eq(orgs.id, orgId))
        const served =
          (await activeDomainHost(db)) ??
          siteHost(org?.slug ?? "", env.SITE_HOST_SUFFIX)
        return db
          .selectDistinct({ host: searchProperties.host })
          .from(searchProperties)
          .where(sql`${searchProperties.host} <> ${served}`)
      })
      for (const { host } of strays) {
        if (await forgetHost(env, kit, orgId, host)) gone++
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "search.forget_failed",
          org_id: orgId,
          error: error instanceof Error ? error.name : "unknown",
        })
      )
    }
  }
  return gone
}

/**
 * `POST /search/connect`: trade the callback's code for tokens under the
 * org the bridge named, and save the sealed refresh token. A partial consent
 * is saved too, as `needs_permission` with the scopes Google granted, so the
 * panel and the daily check can see it; it answers 422 and starts no
 * Workflow, and the owner is asked to connect again. A connection to another Google account replaces the old
 * one, whose grant is revoked first; the same account's old token is not,
 * since Google revokes the whole grant and that would take the new token
 * with it. Then the `SearchWorkflow` of the host the site is served on, from
 * the start. A slug host's property from before a domain went live stays as
 * it is, and Google keeps re-checking its file.
 */
export async function connectGoogle(
  env: Env,
  kit: Tenancy,
  orgId: string,
  workosUserId: string,
  body: unknown
): Promise<SearchRefusal | { email: string | null }> {
  const input = GoogleConnectRequest.safeParse(body)
  if (!input.success) {
    return refuse(
      400,
      "validation",
      "search.invalid",
      "That is not a Google sign-in we can use."
    )
  }
  if (!env.GOOGLE_CLIENT_ID) {
    return refuse(
      409,
      "validation",
      "search.unavailable",
      "Connecting Google isn't available yet."
    )
  }
  let exchanged: Awaited<ReturnType<typeof exchangeCode>>
  try {
    exchanged = await exchangeCode(env, input.data)
  } catch (error) {
    const code = error instanceof GoogleError ? error.name : "google.failed"
    console.error(
      JSON.stringify({ code: "search.exchange_failed", error: code })
    )
    return code === "google.unavailable" || !(error instanceof GoogleError)
      ? refuse(
          503,
          "transient",
          "search.exchange_failed",
          "Google did not answer. Try again."
        )
      : refuse(
          400,
          "validation",
          "search.exchange_failed",
          "Google did not accept that sign-in. Try again."
        )
  }
  const complete = hasScopes(exchanged.scopes)

  const [old] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({
        token: searchConnections.refreshToken,
        email: searchConnections.googleEmail,
      })
      .from(searchConnections)
  )
  if (
    old?.token &&
    old.email &&
    exchanged.email &&
    old.email !== exchanged.email
  ) {
    try {
      await revokeToken(await openToken(env, orgId, old.token))
    } catch (error) {
      // The new connection stands; the old grant stays in the owner's Google account.
      console.error(
        JSON.stringify({
          code: "search.revoke_failed",
          error: (error as Error).name,
        })
      )
    }
  }

  const sealed = await sealToken(env, orgId, exchanged.refreshToken)
  await kit.withOrg({ orgId }, async (db) => {
    const [person] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.workosUserId, workosUserId))
    const now = new Date()
    const values = {
      connectedByUserId: person?.id ?? null,
      googleEmail: exchanged.email,
      refreshToken: sealed,
      scopes: exchanged.scopes,
      state: complete ? ("active" as const) : ("needs_permission" as const),
      connectedAt: now,
      lastRefreshAt: now,
      declined: false,
    }
    await db
      .insert(searchConnections)
      .values({ orgId, ...values })
      .onConflictDoUpdate({ target: searchConnections.orgId, set: values })
    await appendEvent(db, {
      orgId,
      assignmentId: null,
      staffId: null,
      type: complete ? "search.connected" : "search.needs_permission",
      payload: { google_email: exchanged.email },
    })
    await syncTasks(db, orgId)
    if (!complete) await blockPermissions(db, orgId, NEEDS_PERMISSION)
  })
  if (!complete) {
    return refuse(
      422,
      "validation",
      "search.scopes_missing",
      "Both Search Console boxes need to be ticked on Google's screen."
    )
  }
  // The token is saved, so the owner is connected whatever happens next.
  await startSearchRetried(env, kit, orgId)
  return { email: exchanged.email }
}

/** Pauses before the second and third tries of a search start. */
const START_PAUSES_MS = [300, 1_000] as const

/**
 * The `SearchWorkflow` of the host the site answers on, started after a
 * connect is saved, up to three tries. A failure is logged with its message
 * and never thrown: the connection stands, and a restart racing a terminate
 * (`startSearch`) usually goes through on the next try. A redirecting slug
 * host is one Google cannot fetch, so a live domain comes first.
 */
export async function startSearchRetried(
  env: Env,
  kit: Tenancy,
  orgId: string,
  pauses: readonly number[] = START_PAUSES_MS
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { slug, domain } = await heldHosts(env, kit, orgId)
      const canonical = domain ?? slug
      if (canonical) await startSearch(env, orgId, canonical, true)
      return true
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "search.start_failed",
          attempt: attempt + 1,
          error: error instanceof Error ? error.name : "unknown",
          message:
            error instanceof Error
              ? error.message.slice(0, 300)
              : String(error),
        })
      )
      const pause = pauses[attempt]
      if (pause === undefined) return false
      await new Promise((resolve) => setTimeout(resolve, pause))
    }
  }
}

// ---------------------------------------------------------------------------
// SearchWorkflow's step bodies
// ---------------------------------------------------------------------------

/** Google's FILE token is the file name the router serves, and nothing else. */
export const FILE = /^google[0-9a-f]{1,64}\.html$/

/** `token`: the verification file name, under the owner's account. */
export async function fileToken(
  env: Env,
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams
): Promise<string> {
  const file = await verificationToken(
    await accessToken(env, kit, orgId),
    siteUrlOf(host),
    "FILE"
  )
  if (!FILE.test(file)) throw new GoogleError("google.bad_file_token")
  return file
}

/**
 * `place`: the file where the router serves it, and the property row that is
 * its truth. A file another Google account was given before is no longer
 * served, so that account loses the host at Google's next check. A host
 * the org no longer holds gets no file, whatever started the instance.
 */
export async function placeToken(
  env: Env,
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams,
  file: string
): Promise<void> {
  const held = await heldHosts(env, kit, orgId)
  if (host !== held.slug && host !== held.domain) {
    throw new GoogleError("search.host_not_held")
  }
  const [old] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ token: searchProperties.token })
      .from(searchProperties)
      .where(eq(searchProperties.siteUrl, siteUrlOf(host)))
  )
  await writeVerification(env, host, file)
  if (old?.token && old.token !== file) {
    await dropVerification(env, host, old.token)
  }
  await kit.withOrg({ orgId }, async (db) => {
    await db
      .insert(searchProperties)
      .values({
        orgId,
        host,
        siteUrl: siteUrlOf(host),
        kind: host.endsWith(env.SITE_HOST_SUFFIX) ? "subdomain" : "url_prefix",
        method: "file",
        token: file,
        state: "pending",
      })
      .onConflictDoUpdate({
        target: [searchProperties.orgId, searchProperties.siteUrl],
        set: { token: file, state: "pending" },
      })
    await syncTasks(db, orgId)
  })
}

/** `verify`: whether Google found the file. Google answers 4xx while it cannot. */
export async function verifyOnce(
  env: Env,
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams
): Promise<boolean> {
  const property = await ownProperty(kit, orgId, siteUrlOf(host))
  try {
    await verifyResource(
      await accessToken(env, kit, orgId),
      property.siteUrl,
      "FILE"
    )
    return true
  } catch (error) {
    if (
      error instanceof GoogleError &&
      !(error instanceof NeedsReauth) &&
      error.name !== "google.unavailable" &&
      (error.status ?? 500) < 500
    ) {
      return false
    }
    throw error
  }
}

/** `add` and `sitemap`: the property in the owner's Search Console, and its page list. */
export async function addProperty(
  env: Env,
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams,
  sitemap = false
): Promise<void> {
  const property = await ownProperty(kit, orgId, siteUrlOf(host))
  const access = await accessToken(env, kit, orgId)
  if (sitemap) {
    await submitSitemap(access, property.siteUrl, `https://${host}/sitemap.xml`)
  } else {
    // Stamped before the add, so `forgetHost` unlists it even if the
    // Workflow stops before `verified`; Google has verified it by now.
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(searchProperties)
        .set({
          verifiedAt: sql`coalesce(${searchProperties.verifiedAt}, now())`,
        })
        .where(eq(searchProperties.siteUrl, property.siteUrl))
    )
    await addSite(access, property.siteUrl)
  }
}

/** `verified`: the row and its two audit rows, once. */
export async function markVerified(
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams
): Promise<void> {
  await kit.withOrg({ orgId }, async (db) => {
    const now = new Date()
    const [row] = await db
      .update(searchProperties)
      .set({
        state: "verified",
        verifiedAt: now,
        sitemap: {
          submitted_at: now.toISOString(),
          last_downloaded: null,
          errors: 0,
          warnings: 0,
        },
      })
      .where(
        sql`${searchProperties.siteUrl} = ${siteUrlOf(host)} and ${searchProperties.state} <> 'verified'`
      )
      .returning({ id: searchProperties.id })
    if (!row) return
    for (const type of ["search.property_added", "search.sitemap_submitted"]) {
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type,
        payload: { property_id: row.id, host },
      })
    }
    await syncTasks(db, orgId)
  })
}

/** `failed`: Google never found the file. Ours to look at, so an alert; the owner hears it from `sayVerifyFailed`. */
export async function markFailed(
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams
): Promise<void> {
  await kit.withOrg({ orgId }, async (db) => {
    const [row] = await db
      .update(searchProperties)
      .set({ state: "failed" })
      .where(
        sql`${searchProperties.siteUrl} = ${siteUrlOf(host)} and ${searchProperties.state} = 'pending'`
      )
      .returning({ id: searchProperties.id })
    if (!row) return
    await appendEvent(db, {
      orgId,
      assignmentId: null,
      staffId: null,
      type: "alert.raised",
      payload: { kind: "search.verify_failed", property_id: row.id, host },
    })
    await syncTasks(db, orgId)
  })
}

/** One message in the owner's chat. A busy chat or one holding a card throws, for the step's retries. */
export async function tell(
  kit: Tenancy,
  orgId: string,
  key: string,
  message: Parameters<typeof postAssistantMessage>[1]["message"]
): Promise<void> {
  const posted = await postAssistantMessage(kit, { orgId, key, message })
  if (posted === "busy" || posted === "waiting") {
    throw new GoogleError(`search.chat_${posted}`)
  }
}

/**
 * `announce`: one message, keyed by the instance, worded by the model from
 * the host or else the template (heartbeat-write.ts).
 */
export async function announce(
  env: { OPENROUTER_API_KEY?: string },
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams
): Promise<void> {
  const text = await writeUpdate(env, kit, orgId, {
    facts: { host },
    template: `${host} is now in your Google Search Console. I've sent Google your page list. New sites take days to a few weeks to show up.`,
  })
  await tell(kit, orgId, searchInstanceId(orgId, host), { text: [text] })
}

/**
 * `say failed`: Google never found the file, said once after `markFailed`,
 * with a button to start it over. Keyed apart from `announce`, which a
 * restarted instance may still post.
 */
export async function sayVerifyFailed(
  env: { OPENROUTER_API_KEY?: string },
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams
): Promise<void> {
  const text = await writeUpdate(env, kit, orgId, {
    facts: { host },
    template: `Google couldn't confirm that ${host} is yours, even after trying for several days, so it isn't in your Search Console yet. Say the word and I'll start it over.`,
  })
  await tell(kit, orgId, `${searchInstanceId(orgId, host)}:failed`, {
    text: [text],
    button: {
      label: "Try again",
      action: { kind: "ask", text: `Put ${host} on Google again.` },
    },
  })
}
