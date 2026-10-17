import { GoogleConnectRequest, siteHost } from "@workspace/contracts"
import {
  appendEvent,
  eq,
  orgs,
  postAssistantMessage,
  searchConnections,
  searchProperties,
  sql,
  type Tenancy,
  users,
} from "@workspace/db"
import {
  accessFor,
  addSite,
  exchangeCode,
  GoogleError,
  NeedsReauth,
  openToken,
  revokeToken,
  sealToken,
  submitSitemap,
  verificationToken,
  verifyResource,
} from "./google.ts"
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
 * An access token for the org's live connection. A refresh token Google
 * rotated is sealed back; a revoked grant marks the connection
 * `needs_reauth` with its audit row, once, and throws `NeedsReauth`.
 */
export async function accessToken(
  env: Env,
  kit: Tenancy,
  orgId: string
): Promise<string> {
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ token: searchConnections.refreshToken })
      .from(searchConnections)
      .where(eq(searchConnections.state, "active"))
  )
  if (!row?.token) throw new NeedsReauth()
  const stored = row.token
  try {
    const { accessToken: token, sealed } = await accessFor(env, orgId, stored)
    if (sealed) {
      await kit.withOrg({ orgId }, (db) =>
        db
          .update(searchConnections)
          .set({ refreshToken: sealed, lastRefreshAt: new Date() })
          .where(eq(searchConnections.refreshToken, stored))
      )
    }
    return token
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
      }
    })
    throw error
  }
}

/** The org's live hosts: the free subdomain once the site is published. */
async function liveHosts(env: Env, kit: Tenancy, orgId: string) {
  return kit.withOrg({ orgId }, async (db) => {
    const [org] = await db
      .select({ slug: orgs.slug })
      .from(orgs)
      .where(eq(orgs.id, orgId))
    if (!org || !(await activeDeployment(db, orgId))) return []
    return [siteHost(org.slug, env.SITE_HOST_SUFFIX)]
  })
}

/**
 * One `SearchWorkflow` per host. One already there is left running; a
 * finished one runs again, since a reconnect may be another Google account
 * that has to verify the host for itself.
 */
export async function startSearch(env: Env, orgId: string, host: string) {
  const id = searchInstanceId(orgId, host)
  try {
    await env.SEARCHES.create({ id, params: { org_id: orgId, host } })
  } catch {
    const instance = await env.SEARCHES.get(id)
    const { status } = await instance.status()
    if (["complete", "errored", "terminated"].includes(status)) {
      await instance.restart()
    }
  }
}

/**
 * `POST /search/connect`: trade the callback's code for tokens under the
 * org the bridge named, and save the sealed refresh token. A partial consent
 * saves nothing. A connection to another Google account replaces the old
 * one, whose grant is revoked first; the same account's old token is not,
 * since Google revokes the whole grant and that would take the new token
 * with it. Then one `SearchWorkflow` per live host.
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
  if ("error" in exchanged) {
    return refuse(
      422,
      "validation",
      "search.scopes_missing",
      "Both Search Console boxes need to be ticked on Google's screen."
    )
  }

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
      state: "active" as const,
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
      type: "search.connected",
      payload: { google_email: exchanged.email },
    })
  })
  for (const host of await liveHosts(env, kit, orgId)) {
    await startSearch(env, orgId, host)
  }
  return { email: exchanged.email }
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
 * served, so that account loses the host at Google's next check.
 */
export async function placeToken(
  env: Env,
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams,
  file: string
): Promise<void> {
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
  await kit.withOrg({ orgId }, (db) =>
    db
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
  )
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
  })
}

/** `failed`: Google never found the file. Ours to look at, so an alert and no owner message. */
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
  })
}

/**
 * `announce`: one message, keyed by the instance. A busy chat or one
 * holding a card throws, for the step's retries.
 */
export async function announce(
  kit: Tenancy,
  { org_id: orgId, host }: SearchParams
): Promise<void> {
  const posted = await postAssistantMessage(kit, {
    orgId,
    key: searchInstanceId(orgId, host),
    message: {
      text: [
        `${host} is now in your Google Search Console. I've sent Google your page list. New sites take days to a few weeks to show up.`,
      ],
    },
  })
  if (posted === "busy" || posted === "waiting") {
    throw new GoogleError(`search.chat_${posted}`)
  }
}
