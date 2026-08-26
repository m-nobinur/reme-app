// Diagnoses the usual local-setup breakages and names the command that fixes each.
import { existsSync } from "node:fs"
import {
  bad,
  capture,
  loadLocalEnv,
  nodeMajor,
  note,
  ok,
  repoRoot,
} from "./lib.mjs"

process.chdir(repoRoot)

/** @type {string[]} */
const fixes = []

/** Reports one check under whichever label fits the outcome. */
function check(passed, whenOk, whenBad, fix) {
  if (passed) {
    ok(whenOk)
    return true
  }
  bad(whenBad)
  fixes.push(fix)
  return false
}

check(
  nodeMajor >= 24,
  `node ${process.versions.node}`,
  `node ${process.versions.node} is too old, this repo needs 24 or newer`,
  "nvm use   (the version is pinned in .nvmrc)"
)

// A fresh clone runs no hooks until core.hooksPath is set, so nothing checks
// commit subjects or scans for secrets. This is the check most worth having.
check(
  capture("git", ["config", "core.hooksPath"]) === ".githooks",
  "git hooks point at .githooks",
  "git hooks are not wired up, so commits are unchecked and unscanned",
  "pnpm bootstrap   (or: git config core.hooksPath .githooks)"
)

check(
  existsSync("node_modules/.bin/biome"),
  "dependencies installed",
  "dependencies are not installed",
  "pnpm install"
)

const hasEnvFile = check(
  existsSync(".env.local"),
  ".env.local found",
  ".env.local is missing",
  "pnpm bootstrap   (it copies .env.example)"
)

if (hasEnvFile) {
  loadLocalEnv()
  try {
    const { parseEnv } = await import("@workspace/config")
    parseEnv()
    ok("environment parses")
  } catch (error) {
    bad("environment does not parse")
    note(String(error instanceof Error ? error.message : error))
    fixes.push("edit .env.local   (names and shapes are in .env.example)")
  }
}

if (process.env.NEON_OFFLINE === "1") {
  const available = capture("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "reme",
    "-d",
    "reme",
    "-tAc",
    "select count(*) from pg_available_extensions where name = 'vector'",
  ])
  check(
    available === "1",
    "offline postgres up, pgvector available",
    "offline postgres is not answering (NEON_OFFLINE=1)",
    "docker compose up -d --wait   (start Docker first if it is not running)"
  )
}

if (fixes.length === 0) {
  console.log("")
  ok("ready. `pnpm dev` should work.")
  process.exit(0)
}

console.log("")
bad(`${fixes.length} problem${fixes.length === 1 ? "" : "s"}. Fix with:`)
for (const fix of fixes) note(fix)
process.exit(1)
