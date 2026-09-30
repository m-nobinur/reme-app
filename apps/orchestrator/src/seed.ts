import {
  ComponentManifest,
  type FactRecord,
  FactValue,
  SiteFields,
} from "@workspace/contracts"
import manifests from "@workspace/starter-site/manifests.json"
import { fields } from "@workspace/starter-site/site-config"
import { manifestDigest } from "./repo-map.ts"

/**
 * The seed (ruling 4): `packages/starter-site`'s config and `src`, with the
 * sandbox image's `package.json` so the site names exactly the dependencies
 * `/opt/astro/node_modules` holds. The package's tests, scripts and size
 * budget stay out, and so does the booking page, which a first build does
 * not ship. The quote page ships: it is where every call to action points. Bundled into the Worker as text; the model never
 * sees these paths, only the files in the sandbox.
 */
// The glob skips dotfiles unless named, and the starter has one.
const SEED = import.meta.glob(
  [
    "../../../packages/starter-site/astro.config.mjs",
    "../../../packages/starter-site/tsconfig.json",
    "../../../packages/starter-site/.gitignore",
    "../../../packages/starter-site/src/**/*",
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

/** The quote form's questions in a site, which the Developer never edits. */
export const QUOTE_FORM_FILE = "src/quote-form.json"

/**
 * `src/quote-form.json` for these facts: the questions the owner approved as
 * `quote.form`, or the starter's own set when they approved none. Written by
 * the platform at the seed, after a restore and before every build, so the
 * site asks exactly what the owner confirmed with no model in between. A
 * stored value the contract no longer takes counts as none.
 */
export function quoteFormFile(facts: readonly FactRecord[]): string {
  const held = facts.find((fact) => fact.key === "quote.form")
  const parsed =
    held && FactValue.safeParse({ key: "quote.form", value: held.value })
  if (!parsed?.success) return STARTER_FILES[QUOTE_FORM_FILE] as string
  return `${JSON.stringify(parsed.data.value, null, 2)}\n`
}

/** The seed for one org: the starter, with the owner's quote questions. */
export const seedFiles = (
  facts: readonly FactRecord[]
): Record<string, string> => ({
  ...STARTER_FILES,
  [QUOTE_FORM_FILE]: quoteFormFile(facts),
})

/** The starter's fields, which say what a build asks for. Parsed here so a config the contract refuses fails the Worker at load. */
export const SEED_FIELDS = SiteFields.parse(fields)

/** One line per starter component for the stable prompt segment. */
export const SEED_DIGEST = manifestDigest(
  ComponentManifest.array().parse(manifests)
)
