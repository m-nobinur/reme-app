import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Every script runs from the repo root, whichever directory it was called from. */
export const repoRoot = fileURLToPath(new URL("..", import.meta.url))

export const ok = (message) => console.log(`\x1b[32m✓\x1b[0m ${message}`)
export const bad = (message) => console.log(`\x1b[31m✖\x1b[0m ${message}`)
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
