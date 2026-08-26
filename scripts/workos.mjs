// Applies the AuthKit configuration for one WorkOS environment. Safe to run
// again. Every call below is idempotent, so a second run changes nothing and
// says so on each line.
import { execFileSync } from "node:child_process"
import { bad, note, ok, repoRoot } from "./lib.mjs"

process.chdir(repoRoot)

// The CLI prompts and opens a browser unless it knows it is not talking to a
// person. Its auto-detection misses some sandboxes, so say it outright.
process.env.WORKOS_MODE = "agent"

/**
 * What each WorkOS environment is configured with. Redirect URIs and CORS
 * origins are add-only in the WorkOS API, so deleting a line here does not
 * delete it in WorkOS. Removing one is a dashboard action.
 *
 * Staging carries only the local dev origin because it is the only one that
 * exists. The preview and staging hostnames arrive with the deploy stories and
 * are added here in the same change that creates them. `signInEndpoint` is the
 * route the sign-in story builds; nothing serves it yet.
 */
const environments = {
  staging: {
    redirectUris: ["http://localhost:3000/api/auth/callback"],
    corsOrigins: ["http://localhost:3000"],
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
if (process.env.WORKOS_API_KEY) {
  ok(`WORKOS_API_KEY is set, so it decides the environment, not "${name}"`)
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

// Padded so the second run reads as a column of `unchanged`, which is the
// whole point of running it a second time.
const state = (result) =>
  (result.data.alreadyExists ? "unchanged" : "added").padEnd(9)

for (const uri of config.redirectUris) {
  ok(`${state(workos("config", "redirect", "add", uri))}  redirect URI ${uri}`)
}
for (const origin of config.corsOrigins) {
  ok(`${state(workos("config", "cors", "add", origin))}  CORS origin ${origin}`)
}
workos("config", "homepage-url", "set", config.homepageUrl)
ok(`set        homepage URL ${config.homepageUrl}`)

// The sign-in endpoint has no CLI command and no API endpoint, so it is set by
// hand once per environment and this script cannot read it back to check.
console.log("")
note(`Sign-in endpoint, by hand: ${config.signInEndpoint}`)
note("It is the Redirects tab of the application in the WorkOS dashboard.")
note(
  "https://workos.com/docs/authkit/vanilla/nodejs#configure-sign-in-endpoint"
)
