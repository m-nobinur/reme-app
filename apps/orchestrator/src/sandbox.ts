import {
  ContainerUnavailableError,
  getSandbox,
  type Sandbox,
} from "@cloudflare/sandbox"

/**
 * The sandbox as the orchestrator uses it (ADR-031): one container per
 * assignment, keyed by the assignment id, a filesystem and a shell and
 * nothing else. The egress and sleep rules are class fields on `RemeSandbox`
 * in cloudflare.ts; this module is the two things the Workflow and the
 * console do with a container before the Developer attaches to it.
 */

/**
 * The one host the container may reach (§8.3 as amended by ADR-031). The
 * public registry rather than a caching mirror: no mirror exists, and the
 * image carries the Astro toolchain so a build reaches even this rarely.
 */
export const NPM_REGISTRY_HOST = "registry.npmjs.org"

/**
 * Idle time before the container stops. The Developer's loop spends most of
 * its wall time waiting on tokens, and containers bill active CPU, so a short
 * window keeps an idle container off the bill; Q3 releases on a block.
 */
export const SLEEP_AFTER = "5m"

/** The reasons of `ContainerUnavailableError` that mean the pool is full. */
const POOL_FULL = new Set([
  "no_container_instance_available",
  "max_container_instances_exceeded",
])

/** §8.3: the pool is full. The caller waits; nothing else is wrong. */
export class PoolExhaustedError extends Error {
  constructor(readonly reason: string) {
    super(`the container pool is full: ${reason}`)
    this.name = "PoolExhaustedError"
  }
}

// `wrangler types` cannot see the class behind the binding, so the namespace
// arrives untyped and is narrowed here, once.
export const sandboxFor = (env: Env, id: string) =>
  getSandbox(env.SANDBOX as DurableObjectNamespace<Sandbox<Env>>, id, {
    sleepAfter: SLEEP_AFTER,
  })

/**
 * Start the assignment's container and run one command in it, so the
 * Workflow knows a slot exists before it admits the Developer. Returns the
 * cold start in milliseconds; throws `PoolExhaustedError` when the platform
 * cannot allocate an instance, and anything else as it came.
 */
export async function provision(
  env: Env,
  assignmentId: string
): Promise<{ cold_start_ms: number }> {
  const started = Date.now()
  try {
    await sandboxFor(env, assignmentId).exec("true")
  } catch (error) {
    if (
      error instanceof ContainerUnavailableError &&
      POOL_FULL.has(error.reason)
    ) {
      throw new PoolExhaustedError(error.reason)
    }
    throw error
  }
  return { cold_start_ms: Date.now() - started }
}

/**
 * FIXME: a test surface, like console.html. The commands are a constant and
 * the request contributes nothing to them: the route runs exactly this list,
 * in this order, in a container of its own. Q4 moves the two probes into CI
 * and deletes this with the route.
 *
 * The egress pair proves §8.3: the public internet fails and the registry
 * answers. `env` proves no key, token or connection string reached the
 * container. The build is the number the sandbox story quotes.
 */
export const PROBE_COMMANDS = [
  {
    name: "egress.denied",
    command: `curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com/`,
  },
  {
    name: "egress.registry",
    command: `curl -sS -m 20 -o /dev/null -w '%{http_code}' https://${NPM_REGISTRY_HOST}/astro/latest`,
  },
  { name: "credentials", command: "env" },
  {
    name: "astro.build",
    command:
      "mkdir -p /workspace/bench && cp -r /opt/astro/src /opt/astro/package.json /opt/astro/astro.config.mjs /opt/astro/tsconfig.json /workspace/bench/ && ln -sfn /opt/astro/node_modules /workspace/bench/node_modules && cd /workspace/bench && ./node_modules/.bin/astro build 2>&1 | tail -3",
  },
] as const

export type ProbeResult = {
  sandbox_id: string
  cold_start_ms: number
  checks: {
    name: (typeof PROBE_COMMANDS)[number]["name"]
    exit_code: number
    duration_ms: number
    output: string
  }[]
}

/**
 * Run the probe list in a container that can never be an assignment's: the
 * id carries the org and a prefix no assignment id has, and the container is
 * destroyed before this returns.
 */
export async function probe(env: Env, orgId: string): Promise<ProbeResult> {
  const id = `probe-${orgId}`
  const sandbox = sandboxFor(env, id)
  const started = Date.now()
  try {
    await sandbox.exec("true")
    const cold_start_ms = Date.now() - started
    const checks: ProbeResult["checks"] = []
    for (const { name, command } of PROBE_COMMANDS) {
      const at = Date.now()
      const result = await sandbox.exec(command, { timeout: 180_000 })
      checks.push({
        name,
        exit_code: result.exitCode,
        duration_ms: Date.now() - at,
        // The tail: errors and totals live there, and `env` is short.
        output: `${result.stdout}${result.stderr}`.slice(-2000),
      })
    }
    return { sandbox_id: id, cold_start_ms, checks }
  } finally {
    await sandbox.destroy()
  }
}
