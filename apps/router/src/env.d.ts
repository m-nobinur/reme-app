/**
 * The secret this Worker reads, declared by hand for the reason apps/api gives:
 * a secret in a committed config is a secret in the repo (R9), so `wrangler
 * types` never sees it. Local values live in `apps/router/.dev.vars`.
 */
interface Env {
  /** Signs preview claims on the orchestrator and verifies them here (ADR-032). */
  PREVIEW_KEY: string
}
