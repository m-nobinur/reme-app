import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"

/**
 * `SiteRevision` (ADR-031). `version` is the site's own counter, so the owner
 * reads it as `v3`; the tag is derived, never stored, so it cannot drift. A
 * revision takes its number when it passes the gates, so a report the gates
 * refused keeps `null` and the versions the owner sees have no gaps.
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
  version: z.int().positive().nullable(),
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

/**
 * A hostname: lower-case DNS labels, each 1 to 63 characters. No lookaround
 * in the pattern: it reaches model tool schemas, and OpenAI refuses one.
 */
export const Hostname = z
  .string()
  .max(253)
  .regex(
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
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
  /**
   * The owner's primary host, when the site has an active custom domain: the
   * router rewrites the slug host baked into the build to it. Absent before.
   */
  canonical_host: Hostname.optional(),
  /**
   * The slug host the build baked in (`astro build --site`), written beside
   * `canonical_host` so the router can rewrite it without opening Postgres.
   * The router rewrites only when both are present.
   */
  origin_host: Hostname.optional(),
})

/**
 * A pointer for a host that sends its visitors elsewhere, under
 * `host:{hostname}`: the other half of a custom domain and the slug host once
 * the domain is active. The router answers 301 and keeps the path and query.
 */
export const RedirectPointer = z.strictObject({ redirect_to: Hostname })

/**
 * The header the router puts on an HTML page it serves for a published host,
 * from the pointer it served by, so the publisher's probe can tell which
 * version answered before judging it. Sent only to a request carrying a valid
 * `SITE_PROBE_HEADER`, so a visitor cannot read revision ids or count
 * publishes. Written by `formatSiteRevision` and read by `parseSiteRevision`,
 * never by hand.
 */
export const SITE_REVISION_HEADER = "x-reme-revision"

/** The probe's proof that it is the probe, made by `probeProof` in `@workspace/gates/preview`. */
export const SITE_PROBE_HEADER = "x-reme-probe"

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
export type RedirectPointer = z.infer<typeof RedirectPointer>
export type SiteField = z.infer<typeof SiteField>
export type SiteFields = z.infer<typeof SiteFields>

/**
 * A slug, and what is left of a site host once its suffix is off: one DNS
 * label. `slugFor` makes only slugs that pass it.
 */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The org id's first 8 characters, which `slugFor` ends a slug with. */
const ID_TAIL = /-[0-9a-f]{8}$/

/**
 * A handle a person can be given for their org. Derived rather than accepted,
 * so a caller cannot probe which handles are taken, and suffixed with the
 * org's own id so it needs no uniqueness read to be unique. A slug the owner
 * chooses is a later story; this one only has to be stable and theirs.
 */
export function slugFor(name: string, orgId: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  // `preview-` opens a preview host (ADR-030), so a name whose slug would
  // start that way, "Preview" alone included, gets a `site-` in front. So
  // does "Domains": `domains` is the Cloudflare for SaaS fallback origin.
  const reserved = `${words}-`.startsWith("preview-") || words === "domains"
  const base = (reserved ? `site-${words}` : words).slice(0, 40)
  return [base, orgId.slice(0, 8)].filter(Boolean).join("-")
}

/** A host suffix: a `-` or a `.`, then at least two labels. */
const HOST_SUFFIX = /^[-.][a-z0-9-]+(?:\.[a-z0-9-]+)+$/

/**
 * The host a site's canonical URLs, sitemap and robots name: the org's slug
 * joined to the environment's suffix (ADR-030: `.remeai.co.uk` in
 * production, `-stg.remeai.co.uk` on staging). Both halves are checked
 * because the result reaches a shell command in the sandbox.
 */
export function siteHost(slug: string, suffix: string): string {
  if (!SLUG.test(slug)) throw new Error(`not a slug: ${JSON.stringify(slug)}`)
  if (!HOST_SUFFIX.test(suffix))
    throw new Error(`not a host suffix: ${JSON.stringify(suffix)}`)
  return `${slug}${suffix}`
}

/** The longest DNS label a host may carry. */
const LABEL_MAX = 63

/**
 * The host a revision's preview answers on, `preview-v{n}-{slug}` under the
 * same suffix (ADR-030), one level deep under the reserved `preview-`
 * prefix. The first label must fit 63 characters, and a slug can be 49
 * (`slugFor`'s 40-character base, a hyphen and 8 characters of the org id),
 * so a label that would pass 63 keeps the slug's id tail, which keeps hosts
 * apart, and cuts its base instead. A slug that fits is used whole, so
 * existing preview hosts do not move. The site's own host is `siteHost`,
 * never cut.
 */
export function previewHost(slug: string, version: number, suffix: string) {
  // A safe integer has at most 16 digits, which leaves room for the id tail.
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error(`not a version: ${JSON.stringify(version)}`)
  const site = siteHost(slug, suffix)
  const prefix = `preview-v${version}-`
  // The part of the suffix that joins the slug's label, `-stg` on staging.
  const joined = suffix.startsWith("-")
    ? suffix.slice(0, suffix.indexOf("."))
    : ""
  const room = LABEL_MAX - prefix.length - joined.length
  if (slug.length <= room) return `${prefix}${site}`
  const tail = ID_TAIL.exec(slug)?.[0] ?? ""
  const base = slug
    .slice(0, slug.length - tail.length)
    .slice(0, Math.max(0, room - tail.length))
    .replace(/-+$/, "")
  const cut = base ? `${base}${tail}` : tail.slice(1)
  return `${prefix}${siteHost(cut, suffix)}`
}

/**
 * A preview host, `preview-v{n}-{slug}` by ADR-030's reserved prefix. The
 * version's digits are part of the match: a business whose name starts
 * "Preview" has a slug starting `preview-`, and its live site is a site.
 */
export const isPreviewHost = (host: string) => /^preview-v\d+-/.test(host)

/** A TCP port, 1 to 65535, as config writes it. */
const PORT =
  /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/

/**
 * Where a site or preview host is opened, from the environment's config: its
 * suffix and `SITE_PORT`. A real host is https on the default port. A
 * `.localhost` host is local dev's router, which never leaves the machine
 * (RFC 6761) and serves plain http on `SITE_PORT`. Anything else throws, so
 * a misconfigured environment mints no link rather than an http one or one
 * on a stray port: a port on a real host, or a `.localhost` host without one.
 */
export function siteUrl(host: string, port: string | undefined): string {
  const local = host.endsWith(".localhost")
  if (!local && !port) return `https://${host}`
  if (local && port && PORT.test(port)) return `http://${host}:${port}`
  throw new Error(
    `no site link for ${JSON.stringify(host)} on port ${JSON.stringify(port)}`
  )
}

/**
 * A link to a site or a preview, as `siteUrl` mints it: https, or http for a
 * `.localhost` host alone. `meta` carries the same rule into the JSON Schema,
 * which `protocol` and a host check cannot.
 */
export const SiteLink = z
  .url({ protocol: /^https?$/ })
  .refine((link) => {
    // Zod runs this after a failed url check too, which has already refused it.
    if (!URL.canParse(link)) return true
    const { protocol, hostname } = new URL(link)
    return protocol === "https:" || hostname.endsWith(".localhost")
  }, "A link is https, or http on a .localhost host.")
  .meta({
    pattern: "^(https://|http://[^/?#@:]+\\.localhost(:[0-9]+)?([/?#]|$))",
  })
