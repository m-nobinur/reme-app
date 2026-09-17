import {
  ContainerUnavailableError,
  getSandbox,
  type Sandbox,
} from "@cloudflare/sandbox"
import { restore, SITE_ROOT } from "./revise.ts"

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
 * window keeps an idle container off the bill. A stopped container's disk is
 * gone (Cloudflare's containers FAQ), which is why a block checkpoints first.
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

type Ids = { orgId: string; assignmentId: string }

/** Where a blocked build's site waits for its answer, one object per assignment. */
export const checkpointKey = (ids: Ids) =>
  `sites/${ids.orgId}/checkpoints/${ids.assignmentId}.tar.zst`

/**
 * The site as the Developer left it when it asked, in R2, so the container
 * can stop while the question waits: a sleeping container comes back with
 * the image's disk, and a question can wait days. Taken at the block, before
 * `SLEEP_AFTER` can run out. Uncommitted edits and `.git` both travel.
 */
export async function checkpoint(
  env: Env,
  ids: Ids
): Promise<{ key: string; bytes: number; ms: number }> {
  const started = Date.now()
  const sandbox = sandboxFor(env, ids.assignmentId)
  const packed = await sandbox.exec(
    `tar --zstd -cf /tmp/checkpoint.tar.zst --exclude=./node_modules --exclude=./dist --exclude=./.vite -C ${SITE_ROOT} .`,
    { timeout: 120_000 }
  )
  if (packed.exitCode !== 0) {
    throw new Error(`checkpoint failed: ${packed.stderr}`)
  }
  const file = await sandbox.readFile("/tmp/checkpoint.tar.zst", {
    encoding: "base64",
  })
  const body = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
  const key = checkpointKey(ids)
  await env.SITES.put(key, body)
  return { key, bytes: body.length, ms: Date.now() - started }
}

/**
 * Put the checkpoint back before the Developer resumes, when the container
 * lost it: slept, or replaced. A container that kept its disk is left as it
 * is. The check itself starts a stopped container, so `ms` is the cold
 * start plus the restore.
 */
export async function rehydrate(
  env: Env,
  ids: Ids
): Promise<{ restored: boolean; ms: number }> {
  const started = Date.now()
  const sandbox = sandboxFor(env, ids.assignmentId)
  const kept = await sandbox.exec(`test -d ${SITE_ROOT}/.git`)
  if (kept.exitCode === 0) return { restored: false, ms: Date.now() - started }
  await restore(sandbox, env.SITES, checkpointKey(ids))
  return { restored: true, ms: Date.now() - started }
}

/**
 * §13 rule 3: an assignment's container does not outlive it, and neither
 * does its checkpoint. Both calls are idempotent.
 */
export async function endSandbox(env: Env, ids: Ids): Promise<void> {
  await sandboxFor(env, ids.assignmentId).destroy()
  await env.SITES.delete(checkpointKey(ids))
}

/**
 * The live probe list, run by `pnpm --filter orchestrator test:probe` after
 * every staging deploy. The commands are a constant and the request
 * contributes nothing to them: the route runs exactly this list, in this
 * order, in a container of its own. It stays a route because a Durable
 * Object runs the deployed class only, so nothing but the deployed Worker
 * can show what its containers can reach.
 *
 * The egress pair proves §8.3: the public internet fails and the registry
 * answers. `env` proves no key, token or connection string reached the
 * container. The build is the number the sandbox story quotes.
 */
export const PROBE_COMMANDS = [
  // `-f`, so a refusal at the proxy (a 520) is a non-zero exit and not a
  // 200-shaped success.
  {
    name: "egress.denied",
    command: `curl -fsS -m 10 -o /dev/null -w '%{http_code}' https://example.com/`,
  },
  {
    name: "egress.registry",
    command: `curl -fsS -m 20 -o /dev/null -w '%{http_code}' https://${NPM_REGISTRY_HOST}/astro/latest`,
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
 * destroyed before this returns. The suffix gives every probe its own
 * Durable Object, because a probe whose container crashed leaves its object
 * retrying the control connection for three minutes, and the next probe on
 * the same id would be interrupted by that (measured 2026-09-15).
 */
export async function probe(env: Env, orgId: string): Promise<ProbeResult> {
  const id = `probe-${orgId}-${Date.now()}`
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
