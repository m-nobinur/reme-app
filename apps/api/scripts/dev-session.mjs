/**
 * `pnpm dev:session`: a browser signed in to the local app as your development
 * owner, on `/app/approvals`, in one command.
 *
 *   pnpm dev:session            open a window, stop when it closes
 *   pnpm dev:session --check    headless: prove the page renders, then exit
 *   pnpm dev:session --delete   remove the owner, its org and the session
 *
 * The session is real. The owner lives in WorkOS staging and nowhere else (the
 * guard refuses any other environment), one per developer, named from `git
 * config user.email`. It signs in by password through the API the sign-in page
 * uses, and the SDK seals the result with this checkout's
 * `WORKOS_COOKIE_PASSWORD`, which is ADR-024's cookie and nothing we built.
 * The password is new on every run and never written down. The org comes from
 * `POST /org`, the signup path, so it has the starting team.
 *
 * Starts whichever of `web` and `api` is not answering on its port, refuses a
 * port something else holds, and stops what it started on the way out.
 */
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"
import { chromium } from "@playwright/test"
import { bad, capture, ok, warn } from "../../../scripts/lib.mjs"
import {
  appOn,
  client,
  deleteOwner,
  devOwner,
  ensureOwner,
  membershipRefusal,
  retireSession,
  sessionIdOf,
  stagingRefusal,
  startPlan,
} from "./dev-owner.mjs"

const started = Date.now()
const root = new URL("../../../", import.meta.url)
/** Without the trailing slash, as Vite prints it after `/@fs`. */
const rootPath = fileURLToPath(root).replace(/\/$/, "")
/** Gitignored. A live credential, so R9 keeps it out of every commit. */
const SESSION_FILE = new URL(".dev-session.json", root)
const URLS = { web: "http://localhost:3000", api: "http://localhost:3001" }
const PAGE = `${URLS.web}/app/approvals`

function fail(line) {
  bad(line)
  process.exit(1)
}

let owner
try {
  owner = devOwner(capture("git", ["config", "user.email"]))
} catch (error) {
  fail(error.message)
}

// The web Worker's values, because the browser talks to it: a seal made with
// any other password reads as signed out. `pnpm bootstrap` writes the same one
// into apps/api/.dev.vars.
const varsFile = new URL("apps/web/.dev.vars", root)
if (!existsSync(varsFile)) fail("no apps/web/.dev.vars. Run `pnpm bootstrap`.")
const vars = parseEnv(readFileSync(varsFile, "utf8"))
const clientId = vars.WORKOS_CLIENT_ID
const apiKey = vars.WORKOS_API_KEY
const cookiePassword = vars.WORKOS_COOKIE_PASSWORD
if (!cookiePassword) fail("WORKOS_COOKIE_PASSWORD is empty in .dev.vars.")

const refusal = await stagingRefusal({ clientId, apiKey })
if (refusal) fail(`${refusal} This runs against WorkOS staging only.`)
ok("WorkOS staging, key and client checked against each other")

const workos = await client(vars)

if (process.argv.includes("--delete")) {
  const { clearOwner } = await import("@workspace/db/fixtures/seed")
  let gone
  try {
    gone = await deleteOwner(workos, owner, () =>
      clearOwner(owner.email, owner.orgName)
    )
  } catch (error) {
    fail(
      `the local database refused the clear, so WorkOS was not touched: ${error.message}\n` +
        "  Another org in this database still holds the owner. `pnpm seed --reset` on a disposable database, or delete the rows the error names."
    )
  }
  ok(
    `cleared ${gone.local.orgs} org and ${gone.local.users} user from the local database`
  )
  ok(
    gone.remote.userId
      ? `deleted ${owner.email} (${gone.remote.userId}) and ${gone.remote.orgIds.length} org from WorkOS`
      : `${owner.email} was not in WorkOS`
  )
  rmSync(SESSION_FILE, { force: true })
  ok("removed .dev-session.json")
  process.exit(0)
}

const plan = startPlan({
  web: await appOn("web", URLS.web, rootPath),
  api: await appOn("api", URLS.api, rootPath),
})
if (plan.refusal) fail(plan.refusal)

/** What this run started, each in its own process group so it can be stopped. */
const children = plan.start.map((app) => {
  // `--strictPort` so a busy 3000 is an error rather than web on 3001.
  const args =
    app === "web" ? ["-F", "web", "dev", "--strictPort"] : ["-F", "api", "dev"]
  ok(`starting ${app}`)
  return spawn("pnpm", args, { stdio: "inherit", detached: true })
})
process.on("exit", () => {
  for (const child of children) {
    if (child.exitCode === null) process.kill(-child.pid, "SIGTERM")
  }
})
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(130))
}

async function waitFor(app) {
  for (let tries = 0; tries < 120; tries++) {
    if ((await appOn(app, URLS[app], rootPath)) === "ours") return
    if (children.some((child) => child.exitCode !== null)) {
      fail("web or api stopped before it answered")
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  fail(`${app} did not answer as ours on ${URLS[app]} after two minutes`)
}

const password = `Dev-${randomBytes(24).toString("base64url")}`
const { user, created } = await ensureOwner(workos, owner, password)
ok(`${created ? "created" : "found"} ${owner.email} (${user.id})`)

const memberships = await workos.userManagement.listOrganizationMemberships({
  userId: user.id,
})
const refused = membershipRefusal(memberships.data, owner)
if (refused) fail(refused)

let previous = null
try {
  previous = JSON.parse(readFileSync(SESSION_FILE, "utf8"))
} catch {
  // None yet, or unreadable: nothing to retire.
}

const signIn = () =>
  workos.userManagement.authenticateWithPassword({
    email: owner.email,
    password,
    session: { sealSession: true, cookiePassword },
  })
let session = await signIn()

await waitFor("api")
// The signup write, so the org is made the way an owner's is. Safe to repeat:
// it adopts the org the owner already belongs to.
const org = await fetch(`${URLS.api}/org`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: `wos-session=${encodeURIComponent(session.sealedSession)}`,
    "idempotency-key": `org:${user.id}`,
  },
  body: JSON.stringify({ name: owner.orgName }),
})
if (!org.ok) {
  fail(
    `POST /org answered ${org.status}: ${(await org.text()).slice(0, 300)}\n` +
      "  An owner deleted from another checkout leaves its row here too; `pnpm dev:session --delete` clears it."
  )
}
ok(`org ${(await org.json()).slug}`)
// A session minted before the org existed carries no org claim. With one
// membership, WorkOS puts it in the next one, and the first is ended.
if (!session.organizationId) {
  const first = sessionIdOf(session.accessToken)
  session = await signIn()
  await retireSession(workos, { userId: user.id, sessionId: first }, user.id)
}
if ((await retireSession(workos, previous, user.id)) === "revoked") {
  ok("revoked the previous run's session")
}

writeFileSync(
  SESSION_FILE,
  `${JSON.stringify(
    {
      email: owner.email,
      userId: user.id,
      sessionId: sessionIdOf(session.accessToken),
      sealedSession: session.sealedSession,
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
)
// `mode` applies only when the file is created, and it may predate this run.
chmodSync(SESSION_FILE, 0o600)
ok("sealed session written to .dev-session.json")

await waitFor("web")
const check = process.argv.includes("--check")
const browser = await chromium.launch({ headless: check })
const context = await browser.newContext()
await context.addCookies([
  {
    name: "wos-session",
    value: session.sealedSession,
    url: URLS.web,
    httpOnly: true,
    sameSite: "Lax",
  },
])
const page = await context.newPage()
await page.goto(PAGE, { timeout: 120_000 })
const heading = page.getByRole("heading", { level: 1, name: "Approvals" })
const shown = (timeout) =>
  heading.waitFor({ timeout }).then(
    () => true,
    () => false
  )
// The first page a cold Vite serves fails hydration of the `/app` match with
// `(intermediate value) is not a function` in five of seven runs measured. Not a
// late-discovered dependency: with DEBUG=vite:deps both optimizer passes say
// the scanner found every used dependency, so `optimizeDeps.include` has
// nothing to add. A reload renders, which is what a person would do, and it
// is said out loud so the day it stops being needed is visible.
if (!(await shown(20_000))) {
  warn("the first page did not hydrate, reloading once (cold Vite)")
  await page.reload({ timeout: 120_000 })
  if (!(await shown(60_000))) fail(`${page.url()} is not the approvals page`)
}
if (new URL(page.url()).pathname !== "/app/approvals") {
  fail(`landed on ${page.url()}, not /app/approvals`)
}
ok(
  `/app/approvals rendered, signed in as ${owner.email}, ${((Date.now() - started) / 1000).toFixed(1)} s after start`
)

if (!check) {
  console.log("  Close the window to stop.")
  await page.waitForEvent("close", { timeout: 0 })
}
await browser.close()
process.exit(0)
