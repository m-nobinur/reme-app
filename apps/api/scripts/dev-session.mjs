/**
 * `pnpm dev:session`: a browser signed in to the local app as the development
 * owner, on `/app/approvals`, in one command.
 *
 *   pnpm dev:session            open a window, stop when it closes
 *   pnpm dev:session --check    headless: prove the page renders, then exit
 *   pnpm dev:session --delete   remove the owner, its org and the session
 *
 * The session is real. The owner lives in WorkOS staging and nowhere else (the
 * guard refuses any other environment), signs in by password through the API
 * the sign-in page uses, and the SDK seals the result with this checkout's
 * `WORKOS_COOKIE_PASSWORD`, which is ADR-024's cookie and nothing we built.
 * The password is new on every run and never written down. The org comes from
 * `POST /org`, the signup path, so it has the starting team.
 *
 * Starts `web` and `api` if nothing answers on their ports, and stops what it
 * started on the way out.
 */
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { chromium } from "@playwright/test"
import {
  client,
  DEV_OWNER,
  ensureOwner,
  removeOwner,
  stagingRefusal,
} from "./dev-owner.mjs"

const started = Date.now()
const root = new URL("../../../", import.meta.url)
/** Gitignored. A live credential, so R9 keeps it out of every commit. */
const SESSION_FILE = new URL(".dev-session.json", root)
const WEB = "http://localhost:3000"
const API = "http://localhost:3001"
const PAGE = `${WEB}/app/approvals`

const say = (line) => console.log(`\x1b[32m✓\x1b[0m ${line}`)
function fail(line) {
  console.log(`\x1b[31m✖\x1b[0m ${line}`)
  process.exit(1)
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
say("WorkOS staging, key and client checked against each other")

const workos = await client(vars)

if (process.argv.includes("--delete")) {
  const gone = await removeOwner(workos)
  say(
    gone.userId
      ? `deleted ${DEV_OWNER.email} (${gone.userId}) and ${gone.orgIds.length} org`
      : `${DEV_OWNER.email} was not there`
  )
  const { clearOwner } = await import("@workspace/db/fixtures/seed")
  const local = await clearOwner(DEV_OWNER.email, DEV_OWNER.orgName)
  say(
    `cleared ${local.orgs} org and ${local.users} user from the local database`
  )
  rmSync(SESSION_FILE, { force: true })
  say("removed .dev-session.json")
  process.exit(0)
}

const answers = (url) =>
  fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false
  )

/** `web` and `api`, if they are not up. Their own process group, to stop. */
let servers = null
if (!((await answers(WEB)) && (await answers(API)))) {
  servers = spawn("pnpm", ["--parallel", "-F", "web", "-F", "api", "dev"], {
    stdio: "inherit",
    detached: true,
  })
  say("starting web and api")
}
function stop() {
  if (servers?.exitCode === null) process.kill(-servers.pid, "SIGTERM")
}
process.on("exit", stop)
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(130))
}

async function waitFor(url) {
  for (let tries = 0; tries < 120; tries++) {
    if (await answers(url)) return
    if (servers && servers.exitCode !== null) fail("web or api did not start")
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  fail(`nothing answered on ${url} after two minutes`)
}

const password = `Dev-${randomBytes(24).toString("base64url")}`
const { user, created } = await ensureOwner(workos, password)
say(`${created ? "created" : "found"} ${DEV_OWNER.email} (${user.id})`)

const signIn = () =>
  workos.userManagement.authenticateWithPassword({
    email: DEV_OWNER.email,
    password,
    session: { sealSession: true, cookiePassword },
  })
let session = await signIn()

await waitFor(`${API}/health`)
// The signup write, so the org is made the way an owner's is. Safe to repeat:
// it adopts the org the owner already belongs to.
const org = await fetch(`${API}/org`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: `wos-session=${encodeURIComponent(session.sealedSession)}`,
    "idempotency-key": `org:${user.id}`,
  },
  body: JSON.stringify({ name: DEV_OWNER.orgName }),
})
if (!org.ok) {
  fail(
    `POST /org answered ${org.status}: ${(await org.text()).slice(0, 300)}\n` +
      "  An owner deleted from another checkout leaves its row here too; `pnpm dev:session --delete` clears it."
  )
}
say(`org ${(await org.json()).slug}`)
// A session minted before the org existed carries no org claim. With one
// membership, WorkOS puts it in the next one.
if (!session.organizationId) session = await signIn()

writeFileSync(
  SESSION_FILE,
  `${JSON.stringify({ email: DEV_OWNER.email, userId: user.id, sealedSession: session.sealedSession }, null, 2)}\n`,
  { mode: 0o600 }
)
say("sealed session written to .dev-session.json")

await waitFor(WEB)
const check = process.argv.includes("--check")
const browser = await chromium.launch({ headless: check })
const context = await browser.newContext()
await context.addCookies([
  {
    name: "wos-session",
    value: session.sealedSession,
    url: WEB,
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
// A cold Vite optimises dependencies while serving its first page, and that
// page fails hydration with `(intermediate value) is not a function`, measured
// twice on a fresh checkout. The second load is served from the finished
// cache, so one reload is what a person would do and all this does.
if (!(await shown(20_000))) {
  await page.reload({ timeout: 120_000 })
  if (!(await shown(60_000))) fail(`${page.url()} is not the approvals page`)
}
if (new URL(page.url()).pathname !== "/app/approvals") {
  fail(`landed on ${page.url()}, not /app/approvals`)
}
say(
  `/app/approvals rendered, signed in as ${DEV_OWNER.email}, ${((Date.now() - started) / 1000).toFixed(1)} s after start`
)

if (!check) {
  console.log("  Close the window to stop.")
  await page.waitForEvent("close", { timeout: 0 })
}
await browser.close()
process.exit(0)
