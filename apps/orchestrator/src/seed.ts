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

/**
 * The host a revision's preview answers on, `preview-v{n}-{slug}` under the
 * same suffix (ADR-030). One level deep, under the reserved `preview-`
 * prefix, and inside a 63-character label while the slug is at most 44.
 */
export function previewHost(slug: string, version: number, suffix: string) {
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`not a version: ${JSON.stringify(version)}`)
  return `preview-v${version}-${siteHost(slug, suffix)}`
}
