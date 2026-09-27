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
  /** The Chief of Staff's key (ADR-034). Unset, every CoS turn takes the fallback. */
  OPENROUTER_API_KEY?: string
  /** The CoS's model id, when not `DEFAULT_MODEL`. It must be in the facade's price table. */
  COS_MODEL?: string
}
