/**
 * `vite dev`, pointed at the same database as everything else, with the
 * scheduler's minute cron fired locally.
 *
 * The binding has no local connection string in `wrangler.jsonc` on purpose:
 * one would be a password in a committed file, which R9 forbids. The Cloudflare
 * Vite plugin reads `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`
 * the way `wrangler dev` does, so this fills it from the `DATABASE_URL` the
 * developer already has and gets out of the way if they set it themselves.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const BINDING = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE"
const app = fileURLToPath(new URL("..", import.meta.url))

if (!process.env[BINDING]) {
  try {
    process.loadEnvFile(new URL("../../../.env.local", import.meta.url))
  } catch {
    // No .env.local. The check below says what is missing.
  }
  if (!process.env.DATABASE_URL) {
    console.error(
      `orchestrator: no ${BINDING} and no DATABASE_URL to build one from.\n` +
        "Put a DATABASE_URL in .env.local, or set the variable directly."
    )
    process.exit(1)
  }
  process.env[BINDING] = process.env.DATABASE_URL
}

const vite = spawn(
  "vite",
  ["dev", "--port", "3002", ...process.argv.slice(2)],
  {
    cwd: app,
    stdio: "inherit",
    env: process.env,
  }
)
vite.on("exit", (code) => process.exit(code ?? 0))

// workerd under vite fires no cron triggers, so nothing ran a due check-in
// or reminder locally. This fires the scheduler's minute cron (src/schedule.ts)
// on each minute through Miniflare's local route, as a deploy does. The
// hourly sweep is left out: it deletes rows by age.
const SCHEDULER = "http://localhost:3002/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
const tick = () => fetch(SCHEDULER).catch(() => undefined)
setTimeout(
  () => {
    void tick()
    setInterval(tick, 60_000)
  },
  60_000 - (Date.now() % 60_000)
)
