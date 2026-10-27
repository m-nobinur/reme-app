import {
  type ConnectGoogleOutput,
  GoogleConnectRequest,
  GoogleResultRequest,
  type ServerButton,
} from "@workspace/contracts"
import {
  postAssistantMessage,
  searchConnections,
  type Tenancy,
} from "@workspace/db"
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

const CONNECT: ServerButton = {
  label: "Connect Google",
  action: { kind: "connect", service: "google" },
}

const RESULT: Record<
  GoogleResultRequest["result"],
  { text: string; button?: ServerButton }
> = {
  connected: {
    text: "Google is connected. I'm adding your site to Search Console now and I'll tell you when it's in.",
  },
  // The owner's choice, not a fault: one quiet line and no button.
  cancelled: {
    text: "No problem, Google isn't connected. Say the word whenever you want to try again.",
  },
  failed: {
    text: "Google didn't connect, so your site isn't in Search Console yet. The sign-in link runs out if it sits for a while. Say the word and I'll send a fresh one.",
    button: CONNECT,
  },
  scopes_missing: {
    text: "Google needs one more permission before I can add your site. Connect again and leave both boxes ticked.",
    button: { ...CONNECT, label: "Reconnect Google" },
  },
}

/**
 * `POST /google/result`: how the callback ended. One message from the
 * assistant says so, keyed by the attempt so a reloaded callback says it once.
 *
 * shortcut: a chat in a turn drops the message; retry from a Workflow if
 * that ever matters.
 */
export async function googleResult(
  request: Request,
  kit: Tenancy,
  owner: Owner
): Promise<Response> {
  if (!(await isOrgOwner(kit, owner))) return notOwner()
  const parsed = GoogleResultRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const { attempt, result } = parsed.data
  const { text, button } = RESULT[result]
  await postAssistantMessage(kit, {
    orgId: owner.orgId,
    key: `google.result:${attempt}`,
    message: { text: [text], ...(button && { button }) },
  })
  return new Response(null, { status: 204 })
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
