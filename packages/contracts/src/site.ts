import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"

/**
 * `SiteRevision` (ADR-031). `version` is the site's own counter, so the owner
 * reads it as `v3`; the tag is derived, never stored, so it cannot drift.
 * `status: "published"` means the revision was activated at least once. It
 * never means "live now": liveness is `deployments.active_revision` and
 * nothing else (§11.1.3). `retired` revisions keep their row after the sweep
 * deletes their files, so every version's summary stays readable.
 */
export const SiteRevision = z.strictObject({
  revision_id: Uuid,
  org_id: Uuid,
  /** One site per org today, seeded equal to `org_id`; baked into R2 keys. */
  site_id: Uuid,
  assignment_id: Uuid,
  version: z.int().positive(),
  /** Written at publish from `CompletionReport.changes[]`. */
  summary: z.string().min(1).nullable(),
  /** `sites/{site_id}/{revision_id}/source.tar.zst` */
  source_key: z.string().min(1),
  /** `sites/{site_id}/{revision_id}/dist/` */
  artifact_prefix: z.string().min(1),
  /** `sites/{site_id}/{revision_id}/manifest.json` */
  manifest_key: z.string().min(1),
  status: z.enum(["building", "preview", "published", "retired"]),
  /** Set when retired; the daily sweep deletes the files after it. */
  retire_after: Timestamp.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
})

/**
 * `DeploymentManifest` (§19, §11.1.1): written once beside the artifact,
 * verified by the publisher before activation, read by the router on every
 * request. `headers` is the security set applied to every response;
 * cache-control is the router's and is set by asset class (§11.1.6), so it is
 * not here. `files` is the integrity table: the publisher refuses a partial
 * upload and the router serves only files the manifest names.
 */
export const DeploymentManifest = z.strictObject({
  revision_id: Uuid,
  site_id: Uuid,
  org_id: Uuid,
  routes: z.array(
    z.strictObject({
      /** Request path, e.g. `/services/`. */
      path: z.string().regex(/^\/.*$/),
      /** File under the artifact prefix, e.g. `services/index.html`. */
      file: z.string().min(1),
    })
  ),
  headers: z.record(z.string().min(1), z.string()),
  /** File under the artifact prefix to its sha256, hex. */
  files: z.record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/)),
  /** Stamped by the orchestrator, never by the sandbox clock (§13). */
  built_at: Timestamp,
})

export type SiteRevision = z.infer<typeof SiteRevision>
export type DeploymentManifest = z.infer<typeof DeploymentManifest>
