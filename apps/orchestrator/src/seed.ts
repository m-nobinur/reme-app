/**
 * The seed (ruling 4): `packages/starter-site`'s config and `src`, with the
 * sandbox image's `package.json` so the site names exactly the dependencies
 * `/opt/astro/node_modules` holds. The package's tests, scripts and size
 * budget stay out. Bundled into the Worker as text; the model never sees
 * these paths, only the files in the sandbox.
 */
// The glob skips dotfiles unless named, and the starter has one.
const SEED = import.meta.glob(
  [
    "../../../packages/starter-site/astro.config.mjs",
    "../../../packages/starter-site/tsconfig.json",
    "../../../packages/starter-site/.gitignore",
    "../../../packages/starter-site/src/**/*",
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
