import { ComponentManifest, SiteFields } from "@workspace/contracts"
import manifests from "@workspace/starter-site/manifests.json"
import { fields } from "@workspace/starter-site/site-config"
import { manifestDigest } from "./repo-map.ts"

/**
 * The seed (ruling 4): `packages/starter-site`'s config and `src`, with the
 * sandbox image's `package.json` so the site names exactly the dependencies
 * `/opt/astro/node_modules` holds. The package's tests, scripts and size
 * budget stay out, and so do the quote and booking pages, which a first
 * build does not ship. Bundled into the Worker as text; the model never
 * sees these paths, only the files in the sandbox.
 */
// The glob skips dotfiles unless named, and the starter has one.
const SEED = import.meta.glob(
  [
    "../../../packages/starter-site/astro.config.mjs",
    "../../../packages/starter-site/tsconfig.json",
    "../../../packages/starter-site/.gitignore",
    "../../../packages/starter-site/src/**/*",
    "!../../../packages/starter-site/src/pages/quote.astro",
    "!../../../packages/starter-site/src/pages/booking.astro",
    "../../../infra/sandbox/astro/package.json",
  ],
  { query: "?raw", import: "default", eager: true }
) as Record<string, string>

/** The seed's files by their path in the site. */
export const STARTER_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(SEED).map(([file, content]) => [
    file.endsWith("/infra/sandbox/astro/package.json")
      ? "package.json"
      : file.slice(file.indexOf("/starter-site/") + "/starter-site/".length),
    content,
  ])
)

/** The starter's fields, which say what a build asks for. Parsed here so a config the contract refuses fails the Worker at load. */
export const SEED_FIELDS = SiteFields.parse(fields)

/** One line per starter component for the stable prompt segment. */
export const SEED_DIGEST = manifestDigest(
  ComponentManifest.array().parse(manifests)
)

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SUFFIX = /^[-.][a-z0-9-]+(?:\.[a-z0-9-]+)+$/

/**
 * The host a site's canonical URLs, sitemap and robots name: the org's slug
 * joined to the environment's suffix (ADR-030: `.remeai.co.uk` in
 * production, `-stg.remeai.co.uk` on staging). Both halves are checked
 * because the result reaches a shell command in the sandbox.
 */
export function siteHost(slug: string, suffix: string): string {
  if (!SLUG.test(slug)) throw new Error(`not a slug: ${JSON.stringify(slug)}`)
  if (!SUFFIX.test(suffix))
    throw new Error(`not a host suffix: ${JSON.stringify(suffix)}`)
  return `${slug}${suffix}`
}

/** The longest DNS label a host may carry. */
const LABEL_MAX = 63

/** The org id's first 8 characters that `slugFor` in apps/api ends a slug with. */
const ID_TAIL = /-[0-9a-f]{8}$/

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
