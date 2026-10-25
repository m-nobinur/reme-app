import { Blueprint, type FactRecord } from "@workspace/contracts"
import {
  assignments,
  eq,
  events,
  type OrgScopedDb,
  siteRevisions,
  sql,
} from "@workspace/db"
import { ownerUploads } from "./developer-rules.ts"
import { photoFile, photoKey } from "./photo-files.ts"
import { activeDeployment } from "./publish.ts"
import { repoMap } from "./repo-map.ts"
import { type Ids, lockRow, transition } from "./state.ts"

/**
 * Revising a published site (ADR-032, open item 49): a new `site.revise`
 * assignment restored from the revision the site serves, never from a
 * preview, with the change request delivered to the Developer as a signal
 * rather than baked into its instructions. The Workflow restores the
 * snapshot into the container before it admits the Developer so the map in
 * the stable segment is the restored site's from the first turn, or maps the
 * warm sandbox's disk when it already holds that revision; the agent
 * restores again at its own start, which is idempotent and guards against
 * a container that slept in between.
 */

/** Where the site lives in the container. `/opt/astro` is the toolchain, read-only. */
export const SITE_ROOT = "/workspace/site"

type Source = {
  revision_id: string
  assignment_id: string
  source_key: string
}

/** The revision a revise starts from: what the site serves now, or null before the first publish. */
export async function publishedSource(
  db: OrgScopedDb,
  siteId: string
): Promise<Source | null> {
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

/** The states a draft waits on the owner in: its review, or the park a lapsed review moves it to. */
const DRAFT_STATES = ["awaiting_review", "blocked_on_approval"]

/**
 * A change to a site that is not live yet starts from the owner's draft, its
 * source and the photos drawn into it, not from nothing. The draft's build
 * is paused in the transaction that creates the change, which frees the
 * site for it, and stays the owner's until the change has a draft of its
 * own: `transition` brings it back if the change ends without one. Null
 * when the revision is not a draft waiting on the owner.
 */
export async function holdDraft(
  db: OrgScopedDb,
  orgId: string,
  revisionId: string
): Promise<Source | null> {
  const [revision] = await db
    .select({
      assignmentId: siteRevisions.assignmentId,
      sourceKey: siteRevisions.sourceKey,
      status: siteRevisions.status,
    })
    .from(siteRevisions)
    .where(eq(siteRevisions.id, revisionId))
  if (revision?.status !== "preview") return null
  const draft = await lockRow(db, revision.assignmentId)
  if (!DRAFT_STATES.includes(draft.state)) return null
  await transition(db, {
    orgId,
    assignmentId: draft.id,
    to: "paused",
    expectedVersion: draft.version,
    reason: "change.held",
  })
  return {
    revision_id: revisionId,
    assignment_id: draft.id,
    source_key: revision.sourceKey,
  }
}

/** The revision a `site.revise` starts from: the draft it was asked on, else what the site serves. */
export async function reviseSource(
  db: OrgScopedDb,
  ids: Ids
): Promise<Source | null> {
  const [created] = await db
    .select({
      draft: sql<string | null>`${events.payload}->>'draft_revision_id'`,
    })
    .from(events)
    .where(
      sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'assignment.created'`
    )
    .limit(1)
  if (!created?.draft) return publishedSource(db, ids.orgId)
  const [row] = await db
    .select({
      assignmentId: siteRevisions.assignmentId,
      sourceKey: siteRevisions.sourceKey,
    })
    .from(siteRevisions)
    .where(eq(siteRevisions.id, created.draft))
  return row
    ? {
        revision_id: created.draft,
        assignment_id: row.assignmentId,
        source_key: row.sourceKey,
      }
    : null
}

/**
 * The latest plan that built a revision (ADR-038), for a section change's
 * short prompt. A plan the owner never built, or a revise that did not plan,
 * is not the site's plan; null for a site built before planning.
 */
export async function latestBlueprint(
  db: OrgScopedDb
): Promise<Blueprint | null> {
  const [row] = await db
    .select({ blueprint: assignments.blueprint })
    .from(assignments)
    .innerJoin(siteRevisions, eq(siteRevisions.assignmentId, assignments.id))
    .where(sql`${assignments.blueprint} is not null`)
    .orderBy(sql`${assignments.createdAt} desc`)
    .limit(1)
  return Blueprint.safeParse(row?.blueprint).data ?? null
}

/** The slice of the Sandbox SDK the restore uses. */
type Restorable = {
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

type Sites = {
  get: (key: string) => Promise<{ body: ReadableStream } | null>
}

/**
 * Restore a snapshot into the container. The tarball carries `.git` and no
 * `node_modules`; the toolchain is linked in, as the seed does for a fresh
 * site. Whatever the disk held goes first: a warm sandbox's other revision
 * would otherwise leave its files behind.
 */
export async function restore(
  sandbox: Restorable,
  sites: Sites,
  sourceKey: string
): Promise<void> {
  const object = await sites.get(sourceKey)
  if (!object) throw new Error(`no source snapshot at ${sourceKey}`)
  await sandbox.writeFile("/tmp/source.tar.zst", object.body)
  const restored = await sandbox.exec(
    `rm -rf ${SITE_ROOT} && mkdir -p ${SITE_ROOT} && tar --zstd -xf /tmp/source.tar.zst -C ${SITE_ROOT} && cd ${SITE_ROOT} && ln -sfn /opt/astro/node_modules node_modules`,
    { timeout: 120_000 }
  )
  if (restored.exitCode !== 0)
    throw new Error(`restore failed: ${restored.stderr}`)
}

/** Restore the snapshot into the container and map what it holds. */
export async function restoreAndMap(
  sandbox: Restorable,
  sites: Sites,
  sourceKey: string
): Promise<string> {
  await restore(sandbox, sites, sourceKey)
  return mapSite(sandbox)
}

/** The map of the site on the container's disk, restored or warm. */
export async function mapSite(sandbox: Restorable): Promise<string> {
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

/**
 * Copies the owner's photos and logo from the bucket into the site's `src/assets/`,
 * where `astro:assets` resizes them and the source snapshot keeps them for a revise. The
 * sandbox reaches no network, so the bytes go in through the SDK. Returns
 * the ids it could not find, for the log.
 */
export async function placePhotos(
  sandbox: {
    exec: (command: string) => Promise<unknown>
    writeFile: (path: string, content: Uint8Array) => Promise<unknown>
  },
  sites: {
    get: (
      key: string
    ) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>
  },
  orgId: string,
  facts: readonly FactRecord[]
): Promise<string[]> {
  const photos = ownerUploads(facts)
  if (photos.length === 0) return []
  await sandbox.exec(`mkdir -p ${SITE_ROOT}/src/assets/uploads`)
  const missing: string[] = []
  for (const photo of photos) {
    const object = await sites.get(photoKey(orgId, photo.id))
    if (!object) {
      missing.push(photo.id)
      continue
    }
    await sandbox.writeFile(
      `${SITE_ROOT}/src/assets/${photoFile(photo)}`,
      new Uint8Array(await object.arrayBuffer())
    )
  }
  return missing
}
