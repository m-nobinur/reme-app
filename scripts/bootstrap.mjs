// Clone to running stack. Safe to run again: every step is a no-op once done.
import { copyFileSync, existsSync } from "node:fs"
import {
  bad,
  loadLocalEnv,
  nodeMajor,
  note,
  ok,
  repoRoot,
  run,
} from "./lib.mjs"

process.chdir(repoRoot)

if (nodeMajor < 24) {
  bad(`node ${process.versions.node} is too old; this repo needs 24 or newer`)
  note("nvm use   (the version is pinned in .nvmrc)")
  process.exit(1)
}
ok(`node ${process.versions.node}`)

// Without this a fresh clone runs no hooks at all, so the commit conventions
// and the secret scan are unenforced until someone notices.
run("git", ["config", "core.hooksPath", ".githooks"])
ok("git hooks point at .githooks")

if (existsSync(".env.local")) {
  ok(".env.local exists, left as it is")
} else {
  copyFileSync(".env.example", ".env.local")
  ok(".env.local created from .env.example")
}

run("pnpm", ["install"])
ok("dependencies installed")

loadLocalEnv()
if (process.env.NEON_OFFLINE === "1") {
  run("docker", ["compose", "up", "-d", "--wait"])
  ok("offline postgres running on localhost:5432")
}

console.log("")
note(
  "Next: fill DATABASE_URL in .env.local, then `pnpm run doctor` and `pnpm dev`."
)
note(
  "No Neon branch? Set NEON_OFFLINE=1, take the offline DATABASE_URL from the"
)
note("comment in .env.example, and run this again.")
