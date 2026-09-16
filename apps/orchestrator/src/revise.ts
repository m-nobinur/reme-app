import { eq, type OrgScopedDb, siteRevisions } from "@workspace/db"
import { activeDeployment } from "./publish.ts"
import { repoMap } from "./repo-map.ts"

/**
 * Revising a published site (ADR-032, open item 49): a new `site.revise`
 * assignment restored from the revision the site serves, never from a
 * preview, with the change request delivered to the Developer as a signal
 * rather than baked into its instructions. The Workflow restores the
 * snapshot into the container before it admits the Developer so the map in
 * the stable segment is the restored site's from the first turn; the agent
 * restores again at its own start, which is idempotent and guards against
 * a container that slept in between.
 */

/** Where the site lives in the container; the agent's `SITE_ROOT`. */
const SITE_ROOT = "/workspace/site"

/** The revision a revise starts from: what the site serves now, or null before the first publish. */
export async function publishedSource(
  db: OrgScopedDb,
  siteId: string
): Promise<{
  revision_id: string
  assignment_id: string
  source_key: string
} | null> {
  const active = await activeDeployment(db, siteId)
  if (!active) return null
  const [row] = await db
    .select({
      assignmentId: siteRevisions.assignmentId,
      sourceKey: siteRevisions.sourceKey,
    })
    .from(siteRevisions)
    .where(eq(siteRevisions.id, active.revisionId))
  if (!row) return null
  return {
    revision_id: active.revisionId,
    assignment_id: row.assignmentId,
    source_key: row.sourceKey,
  }
}

/** The slice of the Sandbox SDK the restore uses. */
export type Restorable = {
  exec: (
    command: string,
    options?: { timeout?: number }
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  writeFile: (
    path: string,
    content: string | ReadableStream<Uint8Array>
  ) => Promise<unknown>
  readFile: (path: string) => Promise<{ content: string }>
}

/** The files the map describes: the site's source and its three config files. */
const MAPPED = String.raw`find . -type f \( -path './src/*' -o -name 'astro.config.mjs' -o -name 'tsconfig.json' -o -name 'package.json' \) -not -path './node_modules/*' -not -path './.git/*' | sort`

/**
 * Restore the snapshot into the container and map what it holds. The
 * tarball carries `.git` and no `node_modules`; the toolchain is linked in,
 * as the seed does for a fresh site.
 */
export async function restoreAndMap(
  sandbox: Restorable,
  sites: { get: (key: string) => Promise<{ body: ReadableStream } | null> },
  sourceKey: string
): Promise<string> {
  const object = await sites.get(sourceKey)
  if (!object) throw new Error(`no source snapshot at ${sourceKey}`)
  await sandbox.writeFile("/tmp/source.tar.zst", object.body)
  const restore = await sandbox.exec(
    `mkdir -p ${SITE_ROOT} && tar --zstd -xf /tmp/source.tar.zst -C ${SITE_ROOT} && cd ${SITE_ROOT} && ln -sfn /opt/astro/node_modules node_modules`,
    { timeout: 120_000 }
  )
  if (restore.exitCode !== 0)
    throw new Error(`restore failed: ${restore.stderr}`)
  const listing = await sandbox.exec(`cd ${SITE_ROOT} && ${MAPPED}`)
  const files: Record<string, string> = {}
  for (const line of listing.stdout.split("\n").filter(Boolean)) {
    const relative = line.replace(/^\.\//, "")
    files[relative] = (
      await sandbox.readFile(`${SITE_ROOT}/${relative}`)
    ).content
  }
  return repoMap(files)
}
