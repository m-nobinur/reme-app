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

/**
 * One prop of a starter component, as the component's own types declare it.
 * No fact key: a component is reusable, and which fact fills a string is the
 * site config's to say (`SiteField`), not the component's.
 */
export const ComponentProp = z.strictObject({
  name: z.string().min(1),
  /** The prop's TypeScript type as written, e.g. `string` or `"sm" | "lg"`. */
  type: z.string().min(1),
  required: z.boolean(),
  description: z.string().min(1),
})

/**
 * `ComponentManifest` (§11.2): what the Developer may know about one
 * starter component without reading it. Written as `manifest.yaml` beside
 * the component, validated by the starter's tooling into a committed
 * `manifests.json`, read by the orchestrator's context assembler. No
 * version field: the manifests and their one consumer ship in the same commit.
 * `source` says whether the prop list was generated from the component's
 * types or written by hand, because a hand-written list is the one that drifts.
 */
export const ComponentManifest = z.strictObject({
  component: z.string().min(1),
  /** Relative to the site root, e.g. `src/components/ServiceCard.astro`. */
  path: z.string().regex(/^(?!\/)(?!.*\.\.)[^\0]+$/),
  summary: z
    .string()
    .min(1)
    .regex(/^[^\n]+$/),
  props: z.array(ComponentProp),
  constraints: z.array(z.string().min(1)),
  examples: z.array(z.string().min(1)).min(1),
  forbidden: z.array(z.string().min(1)),
  source: z.enum(["generated", "hand-written"]),
})

/** A canonical fact key: dotted, lower case, e.g. `business.phone`. */
const FactKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)

/**
 * `SiteField`: what one string in the starter's `site` config needs. A
 * `fact` field renders a canonical fact and may be required; a `composed`
 * field is text the Developer writes whose claims must trace to listed facts,
 * and is always optional. A union, so "required with no fact" cannot be
 * written down. The declaration order of a site's fields is the order the
 * Developer asks for missing facts.
 *
 * `required` is about asking, never about rendering: the Developer must ask
 * for a required fact that is missing, unless the owner has asked for it to
 * be left off the site. A required field may end up empty (ADR-033).
 */
export const SiteField = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fact"),
    fact_key: FactKey,
    required: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("composed") }),
])

/** The starter's `fields` export: one `SiteField` per key of `site`. */
export const SiteFields = z.record(z.string().min(1), SiteField)

/** A hostname: lower-case DNS labels, each 1 to 63 characters. */
const Hostname = z
  .string()
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
  )

/**
 * `PreviewClaim` (ADR-032): what a preview link and its cookie carry, signed
 * by the orchestrator after it resolved the org, verified by whoever serves
 * the preview. `host` binds the claim to the one preview hostname it was
 * minted for, so a cookie cannot be replayed on another. `exp` is seconds
 * since the epoch.
 */
export const PreviewClaim = z.strictObject({
  org_id: Uuid,
  /** The R2 prefix is `sites/{site_id}/...`; the claim carries it rather than a key. */
  site_id: Uuid,
  revision_id: Uuid,
  host: Hostname,
  /**
   * `site` opens the page and sets the cookie. `screenshots` serves the
   * three screenshots and never a page.
   */
  scope: z.enum(["site", "screenshots"]),
  exp: z.int().positive(),
})

/**
 * `SitePointer` (ADR-032, §11.1.3): the routing cache's value under
 * `host:{hostname}`, written by the publisher and read by the router for a
 * published host. Postgres is the truth; `config_version` is the
 * `deployments` row it was written from, so a stale pointer is detectable.
 * The org travels in the value so a same-origin API call can take its tenant
 * from the mapping, never from the request.
 */
export const SitePointer = z.strictObject({
  org_id: Uuid,
  site_id: Uuid,
  revision_id: Uuid,
  config_version: z.int().positive(),
})

/**
 * The header the router puts on every HTML page it serves for a published
 * host, from the pointer it served by, so the publisher's probe can tell
 * which version answered before judging it. Written by `formatSiteRevision`
 * and read by `parseSiteRevision`, never by hand.
 */
export const SITE_REVISION_HEADER = "x-reme-revision"

const ServedRevision = SitePointer.pick({
  revision_id: true,
  config_version: true,
})
type ServedRevision = z.infer<typeof ServedRevision>

/** `<revision_id>@<config_version>`, the header's one wire format. */
export const formatSiteRevision = (served: ServedRevision) =>
  `${served.revision_id}@${served.config_version}`

/** The pair a header names, or null for a missing or malformed one. */
export function parseSiteRevision(
  value: string | null | undefined
): ServedRevision | null {
  const [revision_id, version, ...rest] = value?.split("@") ?? []
  if (rest.length > 0 || !version || !/^\d+$/.test(version)) return null
  const parsed = ServedRevision.safeParse({
    revision_id,
    config_version: Number(version),
  })
  return parsed.success ? parsed.data : null
}

export type ComponentManifest = z.infer<typeof ComponentManifest>
export type PreviewClaim = z.infer<typeof PreviewClaim>
export type SitePointer = z.infer<typeof SitePointer>
export type SiteField = z.infer<typeof SiteField>
export type SiteFields = z.infer<typeof SiteFields>
