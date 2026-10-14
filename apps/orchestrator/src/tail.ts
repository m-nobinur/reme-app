import {
  DeploymentManifest,
  type FactRecord,
  siteHost,
} from "@workspace/contracts"
import {
  type OrgScopedDb,
  orgs,
  siteRevisions,
  sql,
  type Tenancy,
} from "@workspace/db"
import { limit } from "@workspace/gates"
import { SITE_ROOT } from "./revise.ts"
import { QUOTE_FORM_FILE, quoteFormFile } from "./seed.ts"
import { since } from "./timing.ts"

/**
 * The upload at the end of a build (`report_complete`): the built site goes
 * to R2 under the revision's prefix, and the manifest that names every file
 * and its hash goes last, so a manifest in R2 means every file is there.
 */

/** Uploads in flight at once. */
const UPLOADS = 8

/** Where the sandbox's axe script leaves its JSON. */
const AXE_OUT = "/tmp/axe.json"

/** How many earlier revisions are tried for a manifest to reuse. */
const LOOKBACK = 3

/** The slice of the sandbox the upload uses; `exec` runs in the site's root. */
export type DistSandbox = {
  exec: (command: string) => Promise<{ exitCode: number; stdout: string }>
  readFileBuffer: (path: string) => Promise<Uint8Array>
}

/** The slice of the site bucket the upload uses. */
export type DistBucket = {
  get: (
    key: string
  ) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>
  put: (key: string, value: Uint8Array | ArrayBuffer) => Promise<unknown>
}

/** An earlier revision's artifact: where its files are and the hash of each. */
export type Previous = { base: string; files: Record<string, string> }

/**
 * The site's newest earlier revision whose manifest is still in R2, or null.
 * A revision's manifest is written after its files, so one that parses names
 * files that exist, unless retention swept them since (the copy checks).
 */
export async function previousArtifact(
  db: OrgScopedDb,
  sites: {
    get: (key: string) => Promise<{ json: () => Promise<unknown> } | null>
  },
  siteId: string,
  revisionId: string
): Promise<Previous | null> {
  const rows = await db
    .select({ manifestKey: siteRevisions.manifestKey })
    .from(siteRevisions)
    .where(
      sql`${siteRevisions.siteId} = ${siteId} and ${siteRevisions.id} <> ${revisionId}`
    )
    .orderBy(sql`${siteRevisions.createdAt} desc`)
    .limit(LOOKBACK)
  for (const { manifestKey } of rows) {
    const object = await sites.get(manifestKey)
    if (!object) continue
    // A manifest that does not parse is as good as none; try the one before.
    const parsed = DeploymentManifest.safeParse(
      await object.json().catch(() => null)
    )
    if (parsed.success)
      return {
        base: manifestKey.replace(/manifest\.json$/, ""),
        files: parsed.data.files,
      }
  }
  return null
}

const SHA256 = /^([0-9a-f]{64}) [ *](.+)$/

/**
 * Upload `dist/` to `prefix`: a file whose hash matches the previous
 * manifest's is copied inside R2 from the earlier revision, and only the
 * rest is read out of the sandbox. Eight at a time. The hashes come from
 * `sha256sum` in the sandbox, so an unchanged file is never read out, and a
 * file `sha256sum` did not report is hashed here from its bytes. Returns the
 * manifest's `files` and `routes` and what moved.
 */
export async function uploadDist(input: {
  sandbox: DistSandbox
  sites: DistBucket
  prefix: string
  previous: Previous | null
}) {
  const started = Date.now()
  const { sandbox, sites, prefix, previous } = input
  const [listing, sums] = await Promise.all([
    sandbox.exec("find dist -type f | sort"),
    sandbox.exec("find dist -type f -print0 | xargs -0 -r sha256sum"),
  ])
  const hashes = new Map<string, string>()
  if (sums.exitCode === 0)
    for (const line of sums.stdout.split("\n")) {
      const found = SHA256.exec(line)
      if (found?.[1] && found[2]) hashes.set(found[2], found[1])
    }
  const run = limit(UPLOADS)
  let sent = 0
  let reused = 0
  let bytes = 0
  const files: Record<string, string> = {}
  const routes: { path: string; file: string }[] = []
  const lines = listing.stdout.split("\n").filter(Boolean)
  await Promise.all(
    lines.map((line) =>
      run(async () => {
        const file = line.replace(/^dist\//, "")
        const known = hashes.get(line)
        const earlier = previous?.files[file]
        if (known && known === earlier) {
          const object = await sites.get(`${previous?.base}dist/${file}`)
          if (object) {
            await sites.put(`${prefix}dist/${file}`, await object.arrayBuffer())
            files[file] = known
            reused++
            return
          }
        }
        const body = await sandbox.readFileBuffer(`${SITE_ROOT}/${line}`)
        await sites.put(`${prefix}dist/${file}`, body)
        files[file] = known ?? (await sha256(body))
        bytes += body.byteLength
        sent++
      })
    )
  )
  for (const line of lines) {
    const file = line.replace(/^dist\//, "")
    if (file.endsWith("index.html"))
      routes.push({ path: `/${file.replace(/index\.html$/, "")}`, file })
  }
  return {
    // Sorted, so the manifest is the same whatever order the uploads finished in.
    files: Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))
    ),
    routes,
    sent,
    reused,
    bytes,
    ms: since(started),
  }
}

const sha256 = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0")
  ).join("")

export const GIT = "git -c user.name=reme -c user.email=developer@reme.invalid"

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
}

/** A durable step runner: flue's inside a tool, or a plain call inside one Workflow step. */
export type Steps = {
  do: <T>(name: string, fn: () => Promise<T>) => Promise<T>
}

/** The slice of the sandbox the tail uses. */
export type TailSandbox = {
  exec: (
    command: string,
    options?: { timeoutMs?: number }
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  readFileBuffer: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, content: string) => Promise<unknown>
}

type Check = { exit_code: number; output: string; ms: number }

/** The axe run: its exit code, where its JSON went, and how long it took. */
type Axe = { exit_code: number; key: string | null; ms: number }

/**
 * The end of every build, both lanes (§8.2 "Verify before claiming done"):
 * one `astro check` and one `astro build`, the revision row, the changed
 * files uploaded and the source snapshot. Throws when the build fails, with
 * its output, so the caller can hand it back to whoever wrote the code.
 * Check and build run one after the other: the sandbox has one vCPU and both
 * write `.astro`.
 */
export async function finishRevision(input: {
  steps: Steps
  sandbox: TailSandbox
  kit: Tenancy
  sites: R2Bucket
  hostSuffix: string
  orgId: string
  assignmentId: string
  facts: readonly FactRecord[]
}) {
  const { steps, sandbox, kit, sites, orgId, assignmentId } = input
  const run = (command: string) =>
    sandbox.exec(`cd ${SITE_ROOT} && ${command}`, { timeoutMs: 180_000 })

  // The quote questions are the owner's, never the Developer's: the
  // build renders the facts' list whatever happened to the file.
  await sandbox.writeFile(
    `${SITE_ROOT}/${QUOTE_FORM_FILE}`,
    quoteFormFile(input.facts)
  )
  const check = await steps.do("astro check", async (): Promise<Check> => {
    const started = Date.now()
    const r = await run("./node_modules/.bin/astro check 2>&1 | tail -20")
    return {
      exit_code: r.exitCode,
      output: r.stdout.slice(-2000),
      ms: since(started),
    }
  })
  // Canonical URLs, the sitemap and robots name the tenant host; without
  // --site the starter leaves them out rather than invent one.
  const host = await steps.do("site host", async () =>
    kit.withOrg({ orgId }, async (db) => {
      const [org] = await db
        .select({ slug: orgs.slug })
        .from(orgs)
        .where(sql`${orgs.id} = ${orgId}`)
      if (!org) throw new Error(`no org row for ${orgId}`)
      return siteHost(org.slug, input.hostSuffix)
    })
  )
  const build = await steps.do("astro build", async (): Promise<Check> => {
    const started = Date.now()
    const r = await run(
      `./node_modules/.bin/astro build --site https://${host} 2>&1 | tail -20`
    )
    return {
      exit_code: r.exitCode,
      output: r.stdout.slice(-2000),
      ms: since(started),
    }
  })
  if (build.exit_code !== 0) {
    throw new Error(
      `astro build failed, fix it before reporting:\n${build.output}`
    )
  }

  const revisionId = await steps.do("revision", async () =>
    kit.withOrg({ orgId }, async (db) => {
      // No version yet: the gates step numbers the revision if it passes.
      const id = crypto.randomUUID()
      const prefix = `sites/${orgId}/${id}/`
      await db.insert(siteRevisions).values({
        id,
        orgId,
        siteId: orgId,
        assignmentId,
        sourceKey: `${prefix}source.tar.zst`,
        artifactPrefix: `${prefix}dist/`,
        manifestKey: `${prefix}manifest.json`,
      })
      return id
    })
  )
  const prefix = `sites/${orgId}/${revisionId}/`

  const manifest = await steps.do("upload dist", async () => {
    const started = Date.now()
    const previous = await kit.withOrg({ orgId }, (db) =>
      previousArtifact(db, sites, orgId, revisionId)
    )
    const uploaded = await uploadDist({
      sandbox: {
        exec: run,
        readFileBuffer: (p) => sandbox.readFileBuffer(p),
      },
      sites,
      prefix,
      previous,
    })
    const parsed = DeploymentManifest.parse({
      revision_id: revisionId,
      site_id: orgId,
      org_id: orgId,
      routes: uploaded.routes,
      headers: SECURITY_HEADERS,
      files: uploaded.files,
      built_at: new Date().toISOString(),
    })
    await sites.put(`${prefix}manifest.json`, JSON.stringify(parsed))
    return {
      files: Object.keys(uploaded.files).length,
      reused: uploaded.reused,
      bytes: uploaded.bytes,
      ms: since(started),
    }
  })

  const axe = await steps.do("axe", () =>
    runAxe(
      { exec: run, readFileBuffer: (path) => sandbox.readFileBuffer(path) },
      sites,
      prefix
    )
  )

  const source = await steps.do("upload source", async () => {
    const started = Date.now()
    const r = await run(
      `${GIT} add -A && (${GIT} commit -qm "report_complete" || true) && tar --zstd -cf /tmp/source.tar.zst --exclude=./node_modules --exclude=./dist --exclude=./.vite -C ${SITE_ROOT} .`
    )
    if (r.exitCode !== 0) throw new Error(`source snapshot failed: ${r.stderr}`)
    await sites.put(
      `${prefix}source.tar.zst`,
      await sandbox.readFileBuffer("/tmp/source.tar.zst")
    )
    return { key: `${prefix}source.tar.zst`, ms: since(started) }
  })

  return { revisionId, check, build, manifest, axe, source }
}

/**
 * Axe over the built site, from the sandbox: three pages at one width, so
 * about two seconds a build. The JSON goes to R2 as the check's evidence. A run
 * that left no JSON is reported as exit 2 (or its own non-zero code), which
 * the gate fails closed on.
 */
export async function runAxe(
  sandbox: {
    exec: (command: string) => Promise<{ exitCode: number }>
    readFileBuffer: (path: string) => Promise<Uint8Array>
  },
  sites: Pick<DistBucket, "put">,
  prefix: string
): Promise<Axe> {
  const started = Date.now()
  // A stale file from the last build must not stand in for this run's.
  const r = await sandbox.exec(
    `rm -f ${AXE_OUT}; node /opt/astro/axe.mjs dist ${AXE_OUT}`
  )
  const json = await sandbox.readFileBuffer(AXE_OUT).catch(() => null)
  if (!json)
    return { exit_code: r.exitCode || 2, key: null, ms: since(started) }
  const key = `${prefix}axe.json`
  await sites.put(key, json)
  return { exit_code: r.exitCode, key, ms: since(started) }
}

/** The report's checks, from what `finishRevision` ran. */
export const checksOf = (tail: { check: Check; build: Check; axe: Axe }) => [
  { check: "astro check", exit_code: tail.check.exit_code, output_key: null },
  { check: "astro build", exit_code: tail.build.exit_code, output_key: null },
  { check: "axe", exit_code: tail.axe.exit_code, output_key: tail.axe.key },
]
