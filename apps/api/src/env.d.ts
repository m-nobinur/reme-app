/**
 * The secrets this Worker reads, declared by hand rather than generated.
 *
 * `wrangler types` writes `worker-configuration.d.ts` from `wrangler.jsonc`,
 * and none of these appear there, because a secret in a committed config file
 * is a secret in the repo (R9). Local values live in `apps/api/.dev.vars`, which
 * is gitignored, and deployed values are wrangler secrets, so there is no file
 * typegen could read that CI would also have. Interface merging fills the gap:
 * a name added here is a name the code may read and a name a deploy has to set.
 */
interface Env {
  /** ADR-026: both workers hold it. The rule is that no client bundle does. */
  WORKOS_API_KEY: string
  WORKOS_CLIENT_ID: string
  /** The seal `apps/web` writes with and this worker reads with (ADR-024). */
  WORKOS_COOKIE_PASSWORD: string
  /**
   * Signs the `Reply-To` token on an owner's email and verifies it on the
   * reply (`@workspace/contracts` reply-token). The same value on the
   * orchestrator, which signs. Unset, no reply is accepted.
   */
  REPLY_TOKEN_KEY: string
  /**
   * The VAPID public key a browser subscribes to push with (`GET /push/config`).
   * The orchestrator holds the private half. Unset, push is not offered.
   */
  VAPID_PUBLIC_KEY?: string
  /** The Chief of Staff's key (ADR-034). Unset, every CoS turn takes the fallback. */
  OPENROUTER_API_KEY?: string
  /** The CoS's model id, when not `DEFAULT_MODEL`. It must be in the facade's price table. */
  COS_MODEL?: string
  /** The onboarding planner's model id, when not `DEFAULT_ONBOARDING_MODEL`. Same table. */
  ONBOARDING_MODEL?: string
  /**
   * The buy path's Stripe keys (test mode until live keys are made). With
   * either unset, `buy_domain` and checkout refuse `domain.buy_unavailable`
   * and `/webhooks/stripe` is not a route; `find_domain` still works.
   */
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  /** Search Console's Google client id. Unset, `connect_google` answers that Google is not available. */
  GOOGLE_CLIENT_ID?: string
  /**
   * Local dev only, from `.dev.vars` with `SITE_HOST_SUFFIX=.reme.localhost`:
   * the local router's port. Never in `wrangler.jsonc`; `siteUrl` refuses it
   * on a real host.
   */
  SITE_PORT?: string
}
