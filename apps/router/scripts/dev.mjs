/**
 * The site router on local dev, at http://*.reme.localhost:3004, reading the
 * orchestrator's local KV and R2, so a local build's preview and live links
 * open here. `.dev.vars` sets `SITE_HOST_SUFFIX=.reme.localhost` and the
 * `PREVIEW_KEY` the orchestrator signs with.
 *
 * Not `wrangler dev`: given the staging route, it rewrites every request's URL
 * to the route's host, and the router routes by hostname. `startWorker` takes
 * `inferOriginFromRoutes: false`, which keeps the host the browser sent.
 *
 * `--persist-to <dir>` overrides the state directory, `--port` the port.
 */
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { unstable_startWorker } from "wrangler"

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

process.chdir(router)
const worker = await unstable_startWorker({
  config: "wrangler.jsonc",
  dev: {
    server: { port: Number(values.port) },
    // Past apps/api's 9329 and the Vite Workers' 9229 and 9230.
    inspector: { port: 9331 },
    persist: values["persist-to"],
    inferOriginFromRoutes: false,
  },
})
await worker.ready
console.log(`router: http://*.reme.localhost:${values.port}`)
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => worker.dispose().finally(() => process.exit(0)))
}
