// Creates the Cloudflare and Postgres resources one environment needs, from
// code. Safe to run again: a second run changes nothing and exits 0.
//
// Which lines are honest about that, and which are not, matters more than the
// exit code. `unchanged` is always the remote API's own answer to a list call.
// `present` on a secret means the name exists on the Worker, not that its value
// matches .env.local: wrangler exposes no read for a secret value, so nothing
// here can compare one. A rotated value in .env.local therefore reads `present`
// and is not pushed. Delete the secret to re-push it.
//
// Run: node infra/bootstrap.ts [environment]
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
process.chdir(repoRoot)

const ok = (message: string) => console.log(`\x1b[32m✓\x1b[0m ${message}`)
const bad = (message: string) => console.log(`\x1b[31m✖\x1b[0m ${message}`)
const note = (message: string) =>
  console.log(
    String(message)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")
  )

/** Padded so the state words read as a column. */
const state = (word: string) => word.padEnd(13)

function stop(message: string, ...fixes: string[]): never {
  bad(message)
  for (const fix of fixes) note(fix)
  process.exit(1)
}

/**
 * What each environment is made of. Every name is prefixed `reme-` and carries
 * the environment, because this account also serves an unrelated project and a
 * collision here would be one project reconfiguring another's storage.
 *
 * The ids are not here. They arrive from the create calls below and are
 * committed into the two wrangler configs, which is where a deploy reads them;
 * this file checks that the config and the account still agree.
 */
const environments = {
  staging: {
    neonProject: "sparkling-wildflower-04343187",
    neonBranch: "main",
    // Named because neonctl refuses to guess once a branch has more than one
    // role, and migration 0001 makes that true by creating `reme_app`.
    neonOwner: "neondb_owner",
    hyperdrive: "reme-staging-postgres",
    kv: "reme-staging-web-cache",
    /**
     * The three the session rests on (ADR-024, ADR-026, open item 24).
     * `WORKOS_COOKIE_PASSWORD` is the same value on both Workers on purpose: it
     * is the seal `apps/web` writes and `apps/api` reads, so two values means
     * `apps/api` reads every session as `{}`.
     */
    secrets: ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"],
    workers: ["reme-web", "reme-api"],
  },
  /**
   * Its own Neon project rather than a branch of the staging one, and that is
   * the whole point: a branch inherits its parent's rows, so a production
   * database branched from staging arrives holding the golden fixture orgs.
   * Measured, not theorised. A separate project starts empty, takes the
   * migrations from the journal, and cannot be reached by a mistyped command
   * aimed at staging. The free plan carries both.
   *
   * The secrets are the staging WorkOS environment's, by decision: there are no
   * customers before launch and the production environment's API key cannot be
   * minted from any surface. Open item 13 lists what that defers.
   */
  prod: {
    neonProject: "super-brook-02913792",
    neonBranch: "main",
    neonOwner: "neondb_owner",
    hyperdrive: "reme-prod-postgres",
    kv: "reme-prod-web-cache",
    secrets: ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"],
    workers: ["reme-web-production", "reme-api-production"],
  },
} as const

const name = (process.argv[2] ?? "staging") as keyof typeof environments
const config = environments[name]
if (!config) {
  stop(
    `no configuration for "${name}"`,
    `Configured here: ${Object.keys(environments).join(", ")}.`
  )
}

/**
 * Runs a command, returning stdout, or exits naming what failed.
 *
 * `redact` is not decoration. The Hyperdrive credential is an argument rather
 * than an environment variable, because that is the only shape wrangler takes
 * it in, so the failure message would otherwise print the database password to
 * the terminal and into whatever captured it (R9). Measured, not theorised:
 * the first run of this script did exactly that on a rejected sslmode.
 */
function cli(
  file: string,
  args: string[],
  options: { input?: string; redact?: string } = {}
): string {
  const hide = (text: string) =>
    options.redact ? text.split(options.redact).join("***") : text
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: options.input ?? "",
    })
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string }
    stop(
      hide(`\`${file} ${args.join(" ")}\` failed`),
      hide(String(detail.stderr || detail.stdout || error).trim())
    )
  }
}

/**
 * wrangler prints a banner before its JSON, and the banner is not stable across
 * versions, so take the document rather than the stream.
 */
function json<T>(output: string, open: "[" | "{" = "["): T {
  const start = output.indexOf(open)
  if (start === -1) return (open === "[" ? [] : {}) as T
  return JSON.parse(output.slice(start)) as T
}

const wrangler = (...args: string[]) => cli("npx", ["wrangler", ...args])

/**
 * The id of the Hyperdrive config with this name, or null.
 *
 * A fresh list call answers both questions this script has, "does it exist" and
 * "what is its id", so the create path re-lists rather than parsing its own
 * output. `kv namespace list` answers JSON; `hyperdrive list` answers a
 * box-drawn table and wrangler 4.125 offers it no JSON option, so the row is
 * found by name and the id is the 32-hex field on it. A shape change fails
 * loudly, as a missing id rather than a wrong one.
 */
function hyperdriveId(wanted: string): string | null {
  const row = wrangler("hyperdrive", "list")
    .split("\n")
    .find((line) => line.includes(`│ ${wanted} `))
  return row?.match(/\b[0-9a-f]{32}\b/)?.[0] ?? null
}

// ---------------------------------------------------------------- the account

// Printed rather than asserted. One account holds every environment today, so
// there is nothing to compare against; when prod arrives on its own account
// this becomes the guard that stops a staging run writing to it.
const account = wrangler("whoami").match(/\b[0-9a-f]{32}\b/)?.[0]
ok(`${state("account")}${account ?? "unknown"}`)

// ------------------------------------------------------------------- the role

/**
 * The credential Hyperdrive connects with. `reme_app` is created by migration
 * 0001 with NOLOGIN, because until now nothing connected as it and the role was
 * reached with `SET LOCAL ROLE` alone. Giving it a password is what makes the
 * decision in the phase plan true: point Hyperdrive at `reme_app`, and the
 * `SET LOCAL ROLE` inside `withOrg` becomes belt over braces rather than the
 * only thing standing between a query and every tenant.
 *
 * The password cannot live in a migration, so it is generated here, handed to
 * Hyperdrive, and forgotten. Nothing reads it back. If the Hyperdrive config is
 * ever missing, this run mints a new one rather than trying to recover the old.
 */
const neon = cli("npx", [
  "neonctl",
  "connection-string",
  config.neonBranch,
  "--project-id",
  config.neonProject,
  "--role-name",
  config.neonOwner,
]).trim()
if (!neon.startsWith("postgresql://")) {
  stop(
    "neonctl did not answer with a connection string",
    "npx neonctl auth",
    `Project ${config.neonProject}, branch ${config.neonBranch}.`
  )
}
/**
 * The same endpoint with our own credential on it, built by mutating the parsed
 * URL rather than by formatting one. Two reasons, and the second is the one
 * that matters: `URL` percent-encodes the password for us, and a template
 * literal spelling out `scheme://user:${value}@host` is indistinguishable from
 * a real connection string to the repo's secret scan, which is correct to
 * refuse it. Neon's query string carries `channel_binding=require`, which
 * Hyperdrive does not take, so it is cleared.
 */
const origin = new URL(neon)
origin.username = "reme_app"
origin.search = ""

let hyperdrive = hyperdriveId(config.hyperdrive)

const owner = postgres(neon, { max: 1 })
const [role] = await owner<{ canlogin: boolean; bypassrls: boolean }[]>`
  select rolcanlogin as canlogin, rolbypassrls as bypassrls
  from pg_roles where rolname = 'reme_app'`
if (!role) {
  await owner.end()
  stop(
    "the reme_app role does not exist on this branch",
    "The role is migration 0001, not this script. Apply the migrations first:",
    "DATABASE_URL=<the direct connection string> pnpm db:migrate"
  )
}
// A role that can bypass RLS makes every policy decoration, which is the whole
// reason this credential is not `neondb_owner` (rolbypassrls = true). Refuse
// rather than hand Hyperdrive a credential that reads every tenant.
if (role.bypassrls) {
  await owner.end()
  stop("reme_app has BYPASSRLS; refusing to point Hyperdrive at it")
}

let password: string | null = null
if (!hyperdrive) {
  // URL-safe by construction: this goes into a connection string.
  password = randomBytes(32).toString("base64url")
  // A password is not a bindable parameter in ALTER ROLE, so the value is
  // interpolated. base64url is [A-Za-z0-9_-] and carries no quote to escape.
  await owner.unsafe(`alter role reme_app with login password '${password}'`)
  ok(`${state("granted")}reme_app can log in; the password is not stored here`)
} else {
  ok(`${state(role.canlogin ? "unchanged" : "no login")}reme_app`)
}
await owner.end()

// -------------------------------------------------------------- Hyperdrive

/**
 * Caching is off, and this is a tenancy decision rather than a performance one.
 * Hyperdrive keys its cache on the query text and its parameters. Every read
 * here is scoped by row level security against a transaction-local `app.org_id`
 * that appears in neither, so two orgs issue the same cache key for different
 * rows and the second would be served the first's. Connection pooling, which is
 * what this configuration is for, is included with caching disabled.
 *
 * `sslmode` is left at Hyperdrive's default, `require`, which uses TLS and
 * validates the server certificate against WebPKI. `verify-full` is refused
 * without a CA bundle uploaded through `wrangler cert`
 * (`ca_certificate_id: cannot be blank`, measured here), and Neon serves a
 * publicly rooted certificate, so pinning one is a separate decision.
 */
if (!hyperdrive) {
  if (!password) stop("no password to create the Hyperdrive config with")
  origin.password = password
  cli(
    "npx",
    [
      "wrangler",
      "hyperdrive",
      "create",
      config.hyperdrive,
      `--connection-string=${origin.href}`,
      "--caching-disabled",
    ],
    { redact: password }
  )
  hyperdrive = hyperdriveId(config.hyperdrive)
  if (!hyperdrive) stop("the Hyperdrive config was created and cannot be read")
  ok(`${state("created")}hyperdrive ${config.hyperdrive}`)
} else {
  ok(`${state("unchanged")}hyperdrive ${config.hyperdrive}`)
}

// ---------------------------------------------------------------------- KV

const listKv = () =>
  json<{ id: string; title: string }[]>(
    wrangler("kv", "namespace", "list")
  ).find((entry) => entry.title === config.kv)

let kv = listKv()
if (!kv) {
  wrangler("kv", "namespace", "create", config.kv)
  kv = listKv()
  if (!kv) stop("the KV namespace was created and cannot be read")
  ok(`${state("created")}kv ${config.kv}`)
} else {
  ok(`${state("unchanged")}kv ${config.kv}`)
}

// --------------------------------------------------------- the committed ids

/**
 * A resource nothing is bound to is not a resource. Both ids live in a
 * committed wrangler config, so this compares the account against the repo and
 * says which line to change; it does not edit the file, because a script that
 * rewrites a config in a repo the deploy also reads makes the diff the record
 * of what happened rather than the change itself.
 */
function bindingId(file: string, id: string, label: string) {
  const source = readFileSync(file, "utf8")
  if (source.includes(`"${id}"`)) {
    ok(`${state("matches")}${label} in ${file}`)
    return
  }
  stop(
    `${file} does not carry the ${label} id`,
    `Put "${id}" in it, then run this again.`
  )
}

bindingId("apps/api/wrangler.jsonc", hyperdrive, "hyperdrive")
bindingId("apps/web/wrangler.jsonc", kv.id, "kv namespace")

// ------------------------------------------------------------------ secrets

/**
 * Values come from .env.local, which is gitignored, and go straight into
 * wrangler over stdin. Neither the value nor its length is printed (R9).
 */
if (!existsSync(".env.local")) {
  stop(".env.local is missing", "pnpm bootstrap   (it copies .env.example)")
}
const localEnv = new Map(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=")
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const
    })
)

for (const worker of config.workers) {
  // A Worker that has never been deployed has nowhere to hold a secret, and
  // `reme-api` cannot deploy until the Hyperdrive id above is in its config. So
  // this is a note and not a failure: deploy, then run this again.
  let deployed: string
  try {
    deployed = execFileSync(
      "npx",
      ["wrangler", "secret", "list", "--name", worker, "--format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    )
  } catch {
    bad(`${state("not deployed")}${worker}, so its secrets are not set`)
    continue
  }
  const already = new Set(
    json<{ name: string }[]>(deployed).map((entry) => entry.name)
  )
  for (const secret of config.secrets) {
    if (already.has(secret)) {
      ok(`${state("present")}${worker} ${secret}`)
      continue
    }
    const value = localEnv.get(secret)
    if (!value) {
      stop(
        `${secret} is empty in .env.local, so ${worker} cannot have it`,
        secret === "WORKOS_COOKIE_PASSWORD"
          ? "openssl rand -base64 32   (the same value on both Workers)"
          : "Take it from the WorkOS dashboard for this environment."
      )
    }
    cli("npx", ["wrangler", "secret", "put", secret, "--name", worker], {
      input: `${value}\n`,
      redact: value,
    })
    ok(`${state("set")}${worker} ${secret}`)
  }
}

console.log("")
note(`${name} resources are in place. Deploy with:`)
note("pnpm --filter api exec wrangler deploy")
note("pnpm --filter web build")
note(
  "pnpm --filter web exec wrangler deploy --config dist/server/wrangler.json"
)
note("")
note("A Worker that reads `not deployed` above has no secrets yet. Deploy it,")
note("then run this again: the secrets are set on the run after the first one.")
