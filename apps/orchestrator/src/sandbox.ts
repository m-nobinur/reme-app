import {
  ContainerUnavailableError,
  getSandbox,
  type Sandbox,
} from "@cloudflare/sandbox"
import { restore, SITE_ROOT } from "./revise.ts"

/**
 * The sandbox as the orchestrator uses it (ADR-031): one container per site,
 * keyed by the site id (the org id while an org has one site), a filesystem
 * and a shell and nothing else. The site lock (`assignments_site_writer_key`)
 * means one assignment at a time works in it; after `preview_ready` it stays
 * up, warm, for the next edit. The egress and sleep rules are class fields on `RemeSandbox`
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
 * Idle seconds before the container stops, which is also how long a site's
 * sandbox stays warm after its last edit. A stopped container's disk is gone
 * (Cloudflare's containers FAQ: "it uses a fresh disk from the container
 * image"), so a sleep is a cold start and a block checkpoints first. An idle
 * container still holds a pool slot and bills memory: this number is the
 * owner's cost call (index open item 1).
 */
export const SLEEP_AFTER = 30 * 60

/**
 * What a warm sandbox holds: the revision it built, written at
 * `preview_ready`. Outside the site, so no snapshot or build carries it, and
 * outside the Developer's tool root, so the model cannot write it.
 */
export const REVISION_FILE = "/workspace/.reme/revision"

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
 * The site's sandbox as the build tail reads it (`tail.ts`), for a step that
 * runs the tail outside the Developer's harness: the quick edit lane.
 */
export const tailSandbox = (sandbox: ReturnType<typeof sandboxFor>) => ({
  exec: (command: string, options?: { timeoutMs?: number }) =>
    sandbox.exec(command, { timeout: options?.timeoutMs }),
  readFile: (path: string) => sandbox.readFile(path),
  readFileBuffer: async (path: string) => {
    const file = await sandbox.readFile(path, { encoding: "base64" })
    return Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
  },
  writeFile: (path: string, content: string) =>
    sandbox.writeFile(path, content),
})

type Ids = { orgId: string; assignmentId: string }

/**
 * Which assignment holds a site's sandbox, and the revision it holds when it
 * is warm: execution state, in R2 because R2 lists and reads its own writes.
 * The object's `uploaded` time is the last edit, which eviction orders by.
 */
const holderKey = (siteId: string) => `sandboxes/${siteId}`

/**
 * Start the site's container for this assignment and run one command in it,
 * so the Workflow knows a slot exists before it admits the Developer. A warm
 * sandbox answers at once. A full pool evicts the least recently used warm
 * sandbox and tries once more before it refuses: builds beat warm edits.
 * Returns the cold start in milliseconds; throws `PoolExhaustedError` when no
 * slot comes free, and anything else as it came.
 */
export async function provision(
  env: Env,
  ids: Ids
): Promise<{ cold_start_ms: number; evicted: string | null }> {
  const started = Date.now()
  // Held before the container starts, so no eviction takes it from under us.
  await env.SITES.put(holderKey(ids.orgId), "", {
    customMetadata: { holder: ids.assignmentId },
  })
  const start = () => sandboxFor(env, ids.orgId).exec("true")
  let evicted: string | null = null
  try {
    await start()
  } catch (error) {
    if (
      !(error instanceof ContainerUnavailableError) ||
      !POOL_FULL.has(error.reason)
    ) {
      throw error
    }
    evicted = await evictWarm(env, ids.orgId)
    if (!evicted) throw new PoolExhaustedError(error.reason)
    try {
      await start()
    } catch (again) {
      if (
        again instanceof ContainerUnavailableError &&
        POOL_FULL.has(again.reason)
      ) {
        throw new PoolExhaustedError(again.reason)
      }
      throw again
    }
  }
  return { cold_start_ms: Date.now() - started, evicted }
}

/**
 * Destroy the least recently edited warm sandbox other than `siteId`'s, and
 * return its site, or null when none is warm. An entry older than the TTL is
 * a container that already slept: it holds no slot, so it is pruned, never
 * chosen. A sandbox mid-build has no revision and is never a candidate.
 *
 * Every act re-reads the entry first and skips it when its etag moved: the
 * site's own next build may have taken the sandbox since the listing. The
 * window left is that read to the destroy; a build caught in it finds a
 * fresh container and restores, as after any replacement.
 */
export async function evictWarm(
  env: Env,
  siteId: string,
  now = Date.now()
): Promise<string | null> {
  const warm: { site: string; at: number; etag: string }[] = []
  const unchanged = async (site: string, etag: string) =>
    (await env.SITES.head(holderKey(site)))?.etag === etag
  let cursor: string | undefined
  do {
    const page = await env.SITES.list({
      prefix: "sandboxes/",
      include: ["customMetadata"],
      cursor,
    })
    for (const entry of page.objects) {
      if (!entry.customMetadata?.revision) continue
      const site = entry.key.slice("sandboxes/".length)
      const at = entry.uploaded.getTime()
      if (now - at < SLEEP_AFTER * 1000) {
        if (site !== siteId) warm.push({ site, at, etag: entry.etag })
      } else if (await unchanged(site, entry.etag)) {
        await env.SITES.delete(entry.key)
      }
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  for (const candidate of warm.sort((a, b) => a.at - b.at)) {
    if (!(await unchanged(candidate.site, candidate.etag))) continue
    await endSite(env, candidate.site)
    return candidate.site
  }
  return null
}

/**
 * The site's sandbox and its holder entry, whoever holds it: eviction, and
 * the owner deleting their account while a published site is still warm.
 * Idempotent.
 */
export async function endSite(env: Env, siteId: string): Promise<void> {
  await sandboxFor(env, siteId).destroy()
  await env.SITES.delete(holderKey(siteId))
}

/**
 * Leave the site's sandbox up after `preview_ready`, naming the revision on
 * its disk, instead of destroying it. The TTL runs from this call, the last
 * request the container sees.
 */
export async function keepWarm(
  env: Env,
  ids: Ids,
  revisionId: string
): Promise<void> {
  const sandbox = sandboxFor(env, ids.orgId)
  // A container replaced since the build has the image's empty disk: no
  // marker may claim it holds the revision, so it ends as before.
  const kept = await sandbox.exec(
    `test -d ${SITE_ROOT}/.git && mkdir -p /workspace/.reme`
  )
  if (kept.exitCode !== 0) return endSandbox(env, ids)
  await sandbox.writeFile(REVISION_FILE, revisionId)
  await env.SITES.put(holderKey(ids.orgId), "", {
    customMetadata: { holder: ids.assignmentId, revision: revisionId },
  })
  await env.SITES.delete(checkpointKey(ids))
}

/**
 * The revision a warm sandbox holds, or null for a fresh or reused disk. The
 * marker goes either way: from here on the disk is the caller's to change,
 * and a build that ends without `preview_ready` must not leave it naming a
 * revision its disk no longer matches.
 */
export async function takeWarm(sandbox: {
  exec: (command: string) => Promise<{ stdout: string }>
}): Promise<string | null> {
  const read = await sandbox.exec(
    `cat ${REVISION_FILE} 2>/dev/null; rm -f ${REVISION_FILE}`
  )
  return read.stdout.trim() || null
}

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
): Promise<{ taken: boolean; key: string; bytes: number; ms: number }> {
  const started = Date.now()
  const sandbox = sandboxFor(env, ids.orgId)
  const key = checkpointKey(ids)
  // The container can sleep before this runs, and `exec` then starts a fresh
  // one from the image with no site on it. There is nothing left to save, so
  // say so: the caller fails the assignment, which releases the site lock,
  // where throwing here would error the instance and hold the lock for good.
  const present = await sandbox.exec(`test -d ${SITE_ROOT}/.git`)
  if (present.exitCode !== 0) {
    return { taken: false, key, bytes: 0, ms: Date.now() - started }
  }
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
  await env.SITES.put(key, body)
  return { taken: true, key, bytes: body.length, ms: Date.now() - started }
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
  const sandbox = sandboxFor(env, ids.orgId)
  const kept = await sandbox.exec(`test -d ${SITE_ROOT}/.git`)
  if (kept.exitCode === 0) return { restored: false, ms: Date.now() - started }
  await restore(sandbox, env.SITES, checkpointKey(ids))
  return { restored: true, ms: Date.now() - started }
}

/**
 * What a turn after the first finds where its site was (open item 56). The
 * Developer remembers having seeded the site and the disk does not remember
 * being seeded: the platform can replace a container under a running turn,
 * and the new one has the image's disk. So the disk is asked. `kept` is the
 * usual answer and reads nothing from R2; `restored` put the last checkpoint
 * back; `gone` means none was saved yet, and the caller seeds again.
 */
export async function recover(
  env: Env,
  ids: Ids
): Promise<{ site: "kept" | "restored" | "gone"; ms: number }> {
  const started = Date.now()
  const sandbox = sandboxFor(env, ids.orgId)
  const kept = await sandbox.exec(`test -d ${SITE_ROOT}/.git`)
  if (kept.exitCode === 0) return { site: "kept", ms: Date.now() - started }
  const key = checkpointKey(ids)
  if (!(await env.SITES.head(key))) {
    return { site: "gone", ms: Date.now() - started }
  }
  await restore(sandbox, env.SITES, key)
  return { site: "restored", ms: Date.now() - started }
}

/**
 * §13 rule 3: an assignment's container does not outlive it, and neither
 * does its checkpoint. The site's container goes only when this assignment
 * holds it: cancelling a queued build must not stop the one running. Both
 * calls are idempotent.
 */
export async function endSandbox(env: Env, ids: Ids): Promise<void> {
  const held = await env.SITES.head(holderKey(ids.orgId))
  const holder = held?.customMetadata?.holder
  if (!holder || holder === ids.assignmentId) {
    await sandboxFor(env, ids.orgId).destroy()
    await env.SITES.delete(holderKey(ids.orgId))
  }
  await env.SITES.delete(checkpointKey(ids))
}

/**
 * The live probe list, run by `pnpm --filter orchestrator test:probe` after
 * every deploy. The commands are a constant and the request
 * contributes nothing to them: the route runs exactly this list, in this
 * order, in a container of its own. It stays a route because a Durable
 * Object runs the deployed class only, so nothing but the deployed Worker
 * can show what its containers can reach.
 *
 * The egress pair proves §8.3: the public internet fails and the registry
 * answers. `env` proves no key, token or connection string reached the
 * container. The build is the number the sandbox story quotes.
 */
const PROBE_COMMANDS = [
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
 * id carries the caller's label and a prefix no assignment id has, and the
 * container is destroyed before this returns. The suffix gives every probe its own
 * Durable Object, because a probe whose container crashed leaves its object
 * retrying the control connection for three minutes, and the next probe on
 * the same id would be interrupted by that (measured 2026-09-15).
 */
export async function probe(env: Env, label: string): Promise<ProbeResult> {
  const id = `probe-${label}-${Date.now()}`
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

/** The widths the preview's screenshots are taken at; the router serves them by these names. */
const VIEWPORTS = [390, 768, 1440] as const

/**
 * The home page at three widths, from the build the sandbox still holds,
 * stored under the revision's prefix. Taken after the preview is ready: the
 * owner's preview does not wait for them, and the review card shows them as
 * they land. Never throws; a screenshot that was not taken is a 404 the card
 * handles, and the count says how many there were.
 */
export async function takeScreenshots(
  env: Env,
  ids: Ids,
  revisionId: string
): Promise<{ taken: number; ms: number }> {
  const started = Date.now()
  const prefix = `sites/${ids.orgId}/${revisionId}/`
  let taken = 0
  try {
    const sandbox = sandboxFor(env, ids.orgId)
    // `[a]stro` cannot match the shell running this very line, which `-f` reads.
    const script = [
      "pkill -f '[a]stro preview' || true",
      "(./node_modules/.bin/astro preview --host 127.0.0.1 --port 4321 > /tmp/preview.log 2>&1 &)",
      "for i in $(seq 1 20); do curl -sf -o /dev/null http://127.0.0.1:4321/ && break; sleep 1; done",
      ...VIEWPORTS.map(
        (w) =>
          `playwright screenshot --browser chromium --viewport-size=${w},900 --full-page http://127.0.0.1:4321/ /tmp/home-${w}.png`
      ),
      "pkill -f '[a]stro preview' || true",
    ].join("; ")
    await sandbox.exec(`cd ${SITE_ROOT} && rm -f /tmp/home-*.png; ${script}`, {
      timeout: 120_000,
    })
    for (const w of VIEWPORTS) {
      const file = await sandbox
        .readFile(`/tmp/home-${w}.png`, { encoding: "base64" })
        .catch(() => null)
      if (!file) continue
      await env.SITES.put(
        `${prefix}screenshots/home-${w}.png`,
        Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
      )
      taken++
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "screenshots.failed",
        assignment_id: ids.assignmentId,
        error: String(error),
      })
    )
  }
  return { taken, ms: Date.now() - started }
}
