import { logFailure, resolveDomainClaim, type Tenancy } from "@workspace/db"
import { z } from "zod"
import { bridge } from "./changes.ts"
import { boundedBody, failure, tooLarge } from "./http.ts"
import { same } from "./stripe.ts"

/**
 * Cloudflare's custom hostname alert (SSL for SaaS: validation, issuance,
 * deployment, renewal), so a domain goes live when its certificate does and
 * not at the next look. The hostname is all that is read. Cloudflare's two
 * pages disagree on whether the alert's `data` sits at the top or inside the
 * notification's own `data`, so both are taken; an alert for a previous
 * certificate carries no hostname and is dropped.
 */
const Named = z.object({ hostname: z.string() })
const Alert = z.object({
  data: z.union([Named, z.object({ data: Named })]),
})

const received = () => Response.json({ received: true })

/**
 * `POST /webhooks/cloudflare`. Cloudflare sends the secret in
 * `cf-webhook-auth`; a missing or wrong one is refused before the body is
 * read. The alert is account-wide and staging and production share the zone,
 * so most hostnames are another environment's: those, and anything unreadable,
 * are a 200 with nothing logged, so Cloudflare never retries. The lookup and
 * the nudge run after the answer, because the Workflow looks again on its
 * own and the answer need not wait for it.
 */
export async function certificateWebhook(
  request: Request,
  env: Env,
  kit: Tenancy,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<Response> {
  if (!env.CF_WEBHOOK_SECRET) {
    return failure(404, {
      class: "validation",
      code: "route.not_found",
      message: "No route matches this path.",
      detail: { pathname: "/webhooks/cloudflare" },
    })
  }
  const sent = request.headers.get("cf-webhook-auth") ?? ""
  if (!same(sent, env.CF_WEBHOOK_SECRET)) {
    return failure(401, {
      class: "permission",
      code: "webhook.unauthorised",
      message: "This request does not carry the webhook secret.",
      detail: {},
    })
  }
  const bytes = await boundedBody(request)
  if (!bytes) return tooLarge()
  let body: unknown = null
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // Not JSON: read as an alert with no hostname below.
  }
  const read = Alert.safeParse(body)
  const alert = read.success ? read.data : null
  if (!alert) {
    // Nothing to nudge. Its keys are logged, never its values, so a shape
    // Cloudflare changes is seen rather than silently dropped.
    console.warn(
      JSON.stringify({
        code: "webhook.cloudflare_unread",
        keys: body && typeof body === "object" ? Object.keys(body) : [],
      })
    )
  }
  if (alert) {
    const { data } = alert
    const host = ("hostname" in data ? data.hostname : data.data.hostname)
      .trim()
      .toLowerCase()
    waitUntil(nudge(env, kit, host))
  }
  return received()
}

/** Asks the orchestrator to check the claim now, as the owner's own Check would. */
async function nudge(env: Env, kit: Tenancy, host: string) {
  try {
    const claim = await resolveDomainClaim(kit, host)
    if (!claim) return
    await bridge(
      env,
      {
        orgId: claim.orgId,
        session: {
          workosUserId: "cloudflare",
          sessionId: crypto.randomUUID(),
          impersonated: false,
          email: "",
          name: null,
        },
      },
      `/domains/${claim.name}/check`
    )
  } catch (error) {
    logFailure({ at: "/webhooks/cloudflare" }, error)
  }
}
