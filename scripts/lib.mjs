import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Every script runs from the repo root, whichever directory it was called from. */
export const repoRoot = fileURLToPath(new URL("..", import.meta.url))

export const ok = (message) => console.log(`\x1b[32m✓\x1b[0m ${message}`)
export const bad = (message) => console.log(`\x1b[31m✖\x1b[0m ${message}`)
export const warn = (message) => console.log(`\x1b[33m⚠\x1b[0m ${message}`)
/** Indents every line, so a multi-line message stays under its heading. */
export const note = (message) =>
  console.log(
    String(message)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")
  )

/**
 * Runs a command with its output attached to this terminal. On failure the
 * child has already said why, so stop there rather than adding a stack trace.
 */
export function run(file, args) {
  try {
    execFileSync(file, args, { stdio: "inherit" })
  } catch {
    bad(`\`${[file, ...args].join(" ")}\` failed, see its output above`)
    process.exit(1)
  }
}

/** Runs a command quietly, returning trimmed stdout, or null if it failed. */
export function capture(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

/** Loads .env.local if it is there. Its absence is a doctor problem, not a crash. */
export function loadLocalEnv() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local")
}

export const nodeMajor = Number(process.versions.node.split(".")[0])

/**
 * Local site links: previews and the live site open on the local router
 * (`pnpm --filter router dev`, port 3004). A Worker whose `.dev.vars` lacks
 * these keys falls back to `wrangler.jsonc`'s staging suffix, so its preview
 * link points at `-stg.remeai.co.uk`. Tops up the files that exist, and makes
 * the router's own with the orchestrator's signing key, since a preview opens
 * only when both sides hold the same `PREVIEW_KEY`. Returns the files it changed.
 */
export function ensureLocalSites(root = repoRoot) {
  const file = (app) => join(root, "apps", app, ".dev.vars")
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "")
  const previewKey = read(file("orchestrator"))
    .split("\n")
    .find((line) => line.startsWith("PREVIEW_KEY="))
  const site = ["SITE_HOST_SUFFIX=.reme.localhost", "SITE_PORT=3004"]
  const wanted = {
    api: site,
    orchestrator: site,
    router: [site[0], ...(previewKey ? [previewKey] : [])],
  }
  const changed = []
  for (const [app, want] of Object.entries(wanted)) {
    const path = file(app)
    if (app !== "router" && !existsSync(path)) continue
    const held = read(path)
    const keys = new Set(held.split("\n").map((line) => line.split("=")[0]))
    const missing = want.filter((line) => !keys.has(line.split("=")[0]))
    if (!missing.length) continue
    const joiner = held === "" || held.endsWith("\n") ? "" : "\n"
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${held}${joiner}${missing.join("\n")}\n`)
    changed.push(path)
  }
  return changed
}
