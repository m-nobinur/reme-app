/**
 * `wrangler dev`, pointed at the same database as everything else.
 *
 * The binding has no local connection string in `wrangler.jsonc` on purpose:
 * one would be a password in a committed file, which the secret scan refuses
 * and R9 forbids. Wrangler reads
 * `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` instead, so this
 * fills it from the `DATABASE_URL` the developer already has and gets out of
 * the way if they set it themselves.
 *
 * That also carries the port. A machine where something else already owns 5432
 * publishes the container somewhere else, and `DATABASE_URL` is the one place
 * that moves.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const BINDING = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE"
const api = fileURLToPath(new URL("..", import.meta.url))

if (!process.env[BINDING]) {
  try {
    process.loadEnvFile(new URL("../../../.env.local", import.meta.url))
  } catch {
    // No .env.local. The check below says what is missing.
  }
  if (!process.env.DATABASE_URL) {
    console.error(
      `api: no ${BINDING} and no DATABASE_URL to build one from.\n` +
        "Put a DATABASE_URL in .env.local, or set the variable directly."
    )
    process.exit(1)
  }
  process.env[BINDING] = process.env.DATABASE_URL
}

const wrangler = spawn(
  "wrangler",
  ["dev", "--port", "3001", ...process.argv.slice(2)],
  { cwd: api, stdio: "inherit", env: process.env }
)
wrangler.on("exit", (code) => process.exit(code ?? 0))
