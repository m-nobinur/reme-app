// Applies the AuthKit configuration for one WorkOS environment. Safe to run
// again: a second run changes nothing remotely and exits 0. The redirect and
// CORS lines say so, reading `unchanged`. The homepage line always reads `set`,
// because that call is an unconditional PUT with nothing to read back.
import { execFileSync } from "node:child_process"
import { bad, note, ok, repoRoot, warn } from "./lib.mjs"

process.chdir(repoRoot)

// The CLI prompts and opens a browser unless it knows it is not talking to a
// person. Its auto-detection misses some sandboxes, so say it outright.
process.env.WORKOS_MODE = "agent"

/**
 * What each WorkOS environment is configured with. This script only adds:
 * deleting a line here does not delete it in WorkOS.
 *
 * Removing one is a REST call, and the two halves differ. A redirect URI has
 * `GET /user_management/redirect_uris` and
 * `DELETE /user_management/redirect_uris/{id}`, so it can be listed and removed
 * with `workos api`. A CORS origin has a GET and a POST and no DELETE, so
 * removing one needs `updateCorsConfig` through the WorkOS MCP server, which
 * takes the full list and can therefore shorten it.
 *
 * Staging carries the local dev origin, the deployed one, and one wildcard for
 * preview environments. Previews answer on `*.workers.dev`, the account's
 * subdomain rather than this project's, because Cloudflare issues preview
 * aliases nowhere else; the deployed Workers answer on `remeai.co.uk` (ADR-030).
 * `signInEndpoint` is the route the sign-in story builds.
 */
const environments = {
  staging: {
    redirectUris: [
      "http://localhost:3000/api/auth/callback",
      "https://staging.remeai.co.uk/api/auth/callback",
      // Every preview environment, on one line. A preview is
      // `wrangler versions upload --preview-alias pr-<number>`, which answers
      // at `<alias>-reme-web.lifeos.workers.dev`, so each pull request is a new
      // origin and registering them one at a time would grow this list forever.
      //
      // Within the WorkOS wildcard rules, measured against the API rather than
      // read off them: the wildcard sits in the subdomain furthest from the root
      // domain, there is only one, and a suffix is allowed. `workers.dev` is a
      // public suffix and wildcards are refused on those, but the root domain
      // here is `lifeos.workers.dev` and the call was accepted.
      //
      // The `-reme-web` suffix is the whole of what keeps this narrow. The
      // subdomain is the account's and an unrelated project shares it, and a
      // wildcard matches one label and no more, so this covers every alias of
      // this Worker and nothing else. Proven both ways on 2026-08-29:
      // `probe-reme-web...` reaches the AuthKit bootstrap, `probe-reme-nope...`
      // is refused with `redirect-uri-invalid`.
      "https://*-reme-web.lifeos.workers.dev/api/auth/callback",
      // Production, on the one hostname every business shares (ADR-030). It
      // sits on the staging environment because production runs against the
      // staging WorkOS environment until launch (open item 13), so this list is
      // every origin that signs anyone in, across all three environments.
      "https://preview.remeai.co.uk/api/auth/callback",
    ],
    // No preview entry, deliberately. A CORS origin only matters when a browser
    // calls api.workos.com directly, and nothing does: sign-in is DR-4a, our own
    // pages posting to our own server functions, and the only mention of that
    // host anywhere in `@workos/authkit-tanstack-react-start` is its README.
    // Adding a wildcard here would also be permanent, because the CORS half of
    // this API has no delete.
    corsOrigins: [
      "http://localhost:3000",
      "https://staging.remeai.co.uk",
      "https://preview.remeai.co.uk",
    ],
    homepageUrl: "http://localhost:3000",
    signInEndpoint: "http://localhost:3000/sign-in",
  },
}

const name = process.argv[2] ?? "staging"
const config = environments[name]

if (!config) {
  bad(`no configuration for "${name}"`)
  note(`Configured here: ${Object.keys(environments).join(", ")}.`)
  note("Add an environment in the change that gives it a hostname, not before.")
  process.exit(1)
}

/** Runs a workos command and returns its parsed JSON, or exits naming why not. */
function workos(...args) {
  try {
    const output = execFileSync("workos", [...args, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return JSON.parse(output)
  } catch (error) {
    bad(`\`workos ${args.join(" ")}\` failed`)
    note(String(error.stderr || error.message).trim())
    process.exit(1)
  }
}

// Which environment the CLI writes to comes from its own stored state, not from
// the name above, so check the two agree before writing anything. CI has no
// stored state and sets WORKOS_API_KEY instead, which overrides it.
//
// The lint below wants this name in turbo.json so task caching stays correct.
// Declaring it in globalPassThroughEnv silences the rule and does more than
// that: envMode is strict, so a passthrough entry injects the variable into
// every task's environment, web#build included, which is the one process that
// must never see it. The task hash is unaffected either way, and this file is
// not a turbo task, so the rule has nothing to protect here.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: not read by any turbo task
if (process.env.WORKOS_API_KEY) {
  // Not a passing check. The CLI resolves --api-key, then WORKOS_API_KEY, then
  // the stored environment, so the key wins and the name above becomes
  // decorative. A prod key with a staging argument writes localhost into prod as
  // a redirect URI and a CORS origin, and neither can be removed through the CLI.
  warn(`WORKOS_API_KEY is set, so it decides the environment, not "${name}"`)
  warn("Unset it to write to the environment the CLI is on.")
} else {
  const active = workos("env", "list").data.find((entry) => entry.active)
  if (active?.name !== name) {
    bad(`the CLI is on "${active?.name ?? "no environment"}", not "${name}"`)
    note(`workos env switch ${name}`)
    note("Prod needs its API key from the dashboard first:")
    note("workos env add prod <api-key> --client-id=<client-id>")
    process.exit(1)
  }
  ok(`the CLI is on ${name}`)
}

// Padded so the redirect and CORS lines read as a column on the second run.
// `unchanged` is the CLI's own answer, not a local guess: it POSTs for real and
// maps a 409, or a 422 saying the value exists, to `alreadyExists`. Adding is
// all it can do. There is no delete for a redirect URI or a CORS origin, so this
// file is a floor and not a source of truth, and a value removed in the
// dashboard comes back as `added` on the next run rather than as a no-op.
const state = (result) =>
  (result.data.alreadyExists ? "unchanged" : "added").padEnd(9)

for (const uri of config.redirectUris) {
  ok(`${state(workos("config", "redirect", "add", uri))}  redirect URI ${uri}`)
}
for (const origin of config.corsOrigins) {
  ok(`${state(workos("config", "cors", "add", origin))}  CORS origin ${origin}`)
}
// Always `set`, never `unchanged`: homepage-url is an unconditional PUT of a
// single field with no `alreadyExists` in its response, so there is nothing to
// read back. It is also last-write-wins per environment, which means running
// this against a staging that has a real hostname reverts it to the value here.
workos("config", "homepage-url", "set", config.homepageUrl)
ok(`set        homepage URL ${config.homepageUrl}`)

// The sign-in endpoint has no CLI command, so this script cannot set it and
// cannot read it back either: the MCP server exposes the write but no matching
// query, and the dashboard is the only place the current value is visible.
console.log("")
note(`Sign-in endpoint, set once per environment: ${config.signInEndpoint}`)
note("Not the CLI. Either the Redirects tab of the application in the")
note("dashboard, or updateAuthkitExternalLoginUri through the WorkOS MCP")
note("server, which is what set it on staging.")
note(
  "https://workos.com/docs/authkit/vanilla/nodejs#configure-initiate-login-url"
)
