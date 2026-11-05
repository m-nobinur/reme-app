/**
 * The site router on local dev, at http://*.reme.localhost:3004, reading the
 * orchestrator's local KV and R2, so a local build's preview and live links
 * open here. `.dev.vars` sets `SITE_HOST_SUFFIX=.reme.localhost` and the
 * `PREVIEW_KEY` the orchestrator signs with.
 *
 * `wrangler dev`, so the `API` service binding finds the api that `pnpm dev`
 * runs through the dev registry; start the api first, or a site's quote post
 * has nothing to reach. Given the staging route, wrangler would rewrite every
 * request's URL to the route's host and the router routes by hostname, so
 * `--infer-origin-from-routes false` keeps the host the browser sent.
 *
 * `--persist-to <dir>` overrides the state directory, `--port` the port.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { ensureLocalSites } from "../../../scripts/lib.mjs"

const BINDING = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE"
const router = fileURLToPath(new URL("..", import.meta.url))

// The pointer-miss fallback reads Postgres, as apps/api's dev script explains.
if (!process.env[BINDING]) {
  try {
    process.loadEnvFile(new URL("../../../.env.local", import.meta.url))
  } catch {
    // No .env.local. The check below says what is missing.
  }
  if (!process.env.DATABASE_URL) {
    console.error(
      `router: no ${BINDING} and no DATABASE_URL to build one from.\n` +
        "Put a DATABASE_URL in .env.local, or set the variable directly."
    )
    process.exit(1)
  }
  process.env[BINDING] = process.env.DATABASE_URL
}

// A router with no `.dev.vars` serves the staging suffix and cannot verify a claim.
ensureLocalSites()

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3004" },
    "persist-to": {
      type: "string",
      default: fileURLToPath(
        new URL("../../orchestrator/.wrangler/state", import.meta.url)
      ),
    },
  },
})

const wrangler = spawn(
  "wrangler",
  [
    "dev",
    "--port",
    values.port,
    // Past apps/api's 9329 and the Vite Workers' 9229 and 9230.
    "--inspector-port",
    "9331",
    "--persist-to",
    values["persist-to"],
    "--infer-origin-from-routes",
    "false",
  ],
  { cwd: router, stdio: "inherit", env: process.env }
)
wrangler.on("exit", (code) => process.exit(code ?? 0))
console.log(`router: http://*.reme.localhost:${values.port}`)
