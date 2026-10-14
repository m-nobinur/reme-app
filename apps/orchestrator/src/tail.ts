import { DeploymentManifest } from "@workspace/contracts"
import { type OrgScopedDb, siteRevisions, sql } from "@workspace/db"
import { limit } from "@workspace/gates"
import { SITE_ROOT } from "./revise.ts"
import { since } from "./timing.ts"

/**
 * The upload at the end of a build (`report_complete`): the built site goes
 * to R2 under the revision's prefix, and the manifest that names every file
 * and its hash goes last, so a manifest in R2 means every file is there.
 */

/** Uploads in flight at once. */
const UPLOADS = 8

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
