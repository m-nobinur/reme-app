/**
 * The secrets this Worker reads, declared by hand for the reason apps/api
 * gives: a secret in a committed config is a secret in the repo (R9), so
 * `wrangler types` never sees it. Local values live in
 * `apps/orchestrator/.dev.vars`, and `cf-typegen` passes `--env-file
 * /dev/null` so that file never reaches the generated types. Every name here
 * is one `infra/bootstrap.ts` sets on each deploy.
 *
 * Merged into the generated base that both `Env` and `Cloudflare.Env` extend,
 * since the Developer reads its bindings through `cloudflare:workers`, which
 * types them as the latter.
 */
interface __BaseEnv_Env {
  /** The console's bearer. */
  ORCHESTRATOR_TOKEN: string
  /** Signs the RuntimeSpec the Developer verifies. */
  RUNTIME_SPEC_KEY: string
  /**
   * Signs the Reply-To token on an owner email (`@workspace/contracts`
   * reply-token). The same value on the api, which verifies the reply.
   */
  REPLY_TOKEN_KEY: string
  /** Signs preview claims here; the router verifies them (ADR-032). */
  PREVIEW_KEY: string
  /**
   * Local dev only, from `.dev.vars` with `SITE_HOST_SUFFIX=.reme.localhost`:
   * the local router's port, for preview links and the publish probe. Never
   * in `wrangler.jsonc`; `siteUrl` refuses it on a real host.
   */
  SITE_PORT?: string
  /**
   * Cloudflare for SaaS custom hostnames on `CF_DOMAINS_ZONE_ID`
   * (src/domains.ts). Optional until the owner's one-time setup (D0) creates
   * the token; without it a connect fails as `domains.not_configured`.
   */
  CF_DOMAINS_TOKEN?: string
  /**
   * Stripe's secret key, for a bought domain's hold (capture or release) and
   * its renewal Subscription (src/stripe.ts). Unset, `buy_domain` refuses
   * with `domain.buy_unavailable` and finding a domain still works.
   */
  STRIPE_SECRET_KEY?: string
  /**
   * Google Search Console (src/google.ts). The client id is public and the
   * other two never leave this Worker; `GOOGLE_TOKEN_KEY` is base64 of 32
   * random bytes sealing stored refresh tokens. Unset, `connect_google`
   * answers that Google is not available.
   */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_TOKEN_KEY?: string
  OPENROUTER_API_KEY: string
  /** The model plane's settings, set as secrets so one list says what the Worker reads. */
  REME_MODEL_PRIMARY: string
  REME_MODEL_DEFAULT: string
  REME_MODEL_FALLBACK: string
  /**
   * Where the uptime check emails, production only. Put by hand with
   * `wrangler secret put`, not by bootstrap, so the address stays out of the
   * repo and out of `.env.local`.
   */
  ALERT_TO?: string
  /**
   * The `send_email` binding the uptime check sends through. Not in
   * wrangler.jsonc until Email Routing is enabled on the zone; see
   * docs/runbook-production.md.
   */
  ALERTS?: SendEmail
}
