// Clone to running stack. Safe to run again: every step is a no-op once done.
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
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

// The design system suite drives a real browser, and it is the only place that
// gate runs now that CI skips it. Without this the trap is a fresh clone
// failing at pre-push, which is the worst moment to learn a browser is missing.
// Playwright's own installer is the no-op when the binary is already there.
run("pnpm", [
  "--filter",
  "@workspace/ui",
  "exec",
  "playwright",
  "install",
  "chromium",
])
ok("chromium installed for the design system suite")

loadLocalEnv()

// The Worker reads its configuration from its own bindings, not from
// .env.local, so a clone with a filled .env.local still starts a web Worker
// with no WorkOS configuration at all. `.dev.vars` is what the Cloudflare Vite
// plugin binds in dev, and it is gitignored.
const DEV_VARS = "apps/web/.dev.vars"

// Read out of the file rather than out of process.env. The values are copied
// from one config file to another, so the file is the honest source, and
// reaching for process.env here would ask turbo to pass WORKOS_API_KEY through
// to every task, which is what D1 took out for the opposite reason.
function fromLocalEnv(name) {
  if (!existsSync(".env.local")) return ""
  const line = readFileSync(".env.local", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${name}=`))
  return line ? line.slice(name.length + 1).trim() : ""
}

const apiKey = fromLocalEnv("WORKOS_API_KEY")
if (existsSync(DEV_VARS)) {
  ok(`${DEV_VARS} exists, left as it is`)
} else {
  writeFileSync(
    DEV_VARS,
    [
      `WORKOS_API_KEY=${apiKey}`,
      `WORKOS_CLIENT_ID=${fromLocalEnv("WORKOS_CLIENT_ID")}`,
      "WORKOS_REDIRECT_URI=http://localhost:3000/api/auth/callback",
      // Generated rather than left blank. It is not shared with anyone and it
      // has no external side effect, so there is nothing to look up: leaving it
      // empty would only mean the first sign-in fails on a missing value.
      `WORKOS_COOKIE_PASSWORD=${randomBytes(32).toString("base64")}`,
      "",
    ].join("\n")
  )
  ok(
    apiKey
      ? `${DEV_VARS} created from .env.local`
      : `${DEV_VARS} created; add WORKOS_API_KEY and WORKOS_CLIENT_ID to it`
  )
}

if (process.env.NEON_OFFLINE === "1") {
  run("docker", ["compose", "up", "-d", "--wait"])
  ok("offline postgres running on localhost:5432")
}

console.log("")
note(
  "Next: fill DATABASE_URL in .env.local, then `pnpm preflight` and `pnpm dev`."
)
note(
  "Owner sign-in also needs WORKOS_API_KEY and WORKOS_CLIENT_ID in apps/web/.dev.vars."
)
note(
  "No Neon branch? Set NEON_OFFLINE=1, take the offline DATABASE_URL from the"
)
note("comment in .env.example, and run this again.")
