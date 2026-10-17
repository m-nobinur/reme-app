import {
  type ConnectGoogleOutput,
  GoogleConnectRequest,
} from "@workspace/contracts"
import { searchConnections, type Tenancy } from "@workspace/db"
import { bridge, type Owner, relay } from "./changes.ts"
import { isOrgOwner } from "./domain-buy.ts"
import { failure, invalid, readBody } from "./http.ts"

/**
 * Search Console's api half: the web callback's code handed to the
 * orchestrator, which holds the Google secret and the sealed token, and the
 * `connect_google` tool. The org is the session's; the owner only.
 */

/**
 * The connect's own bridge timeout: the orchestrator makes up to two Google
 * calls of 15 s each (the exchange, a revoke), so the default 10 s would
 * answer a timeout for a connect that went on to succeed.
 */
export const CONNECT_TIMEOUT_MS = 30_000

const notOwner = () =>
  failure(403, {
    class: "permission",
    code: "search.not_owner",
    message: "Only the owner can connect Google.",
    detail: {},
  })

/**
 * `POST /google/connect`: `{code, verifier, redirect_uri}` from the web
 * callback, to the orchestrator's `POST /search/connect`, which answers 204,
 * or 422 `search.scopes_missing` when a box was unticked.
 */
export async function googleConnect(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner
): Promise<Response> {
  if (!(await isOrgOwner(kit, owner))) return notOwner()
  const parsed = GoogleConnectRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const result = await bridge(env, owner, "/search/connect", {
    body: parsed.data,
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  })
  if (result.status === 204) return new Response(null, { status: 204 })
  return relay(result, () => {
    throw new Error("a connect answers 204 and no body")
  })
}

/**
 * `connect_google`: the link to Google's consent screen, or the account
 * already connected, or that Google is off here. Google's screen is the
 * approval, so this is a read.
 */
export async function connectGoogle(
  { env, kit, owner }: { env: Env; kit: Tenancy; owner: Owner },
  _input: Record<string, never>
): Promise<ConnectGoogleOutput> {
  if (!env.GOOGLE_CLIENT_ID) return { available: false }
  if (!(await isOrgOwner(kit, owner))) {
    return {
      outcome: "refused",
      error: {
        class: "permission",
        code: "search.not_owner",
        message: "Only the owner can connect Google.",
      },
    }
  }
  const [row] = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    db
      .select({
        state: searchConnections.state,
        email: searchConnections.googleEmail,
      })
      .from(searchConnections)
  )
  if (row?.state === "active" && row.email) {
    return { connected: true, email: row.email }
  }
  return { url: new URL("/api/google/start", env.WEB_ORIGIN).href }
}
