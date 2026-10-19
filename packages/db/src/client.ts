import { parseEnv } from "@workspace/config"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.ts"

/**
 * The Node-side connection, used by migrations, seeds and tests. Workers get
 * their handle from the tenant context in `apps/api`; this is not that path.
 *
 * One connection by default, on purpose: the migration advisory lock is
 * session-scoped, so the session that takes it has to be the session that runs
 * the DDL. `withOrg` asks for a pool instead, because its context is
 * transaction-scoped and survives being handed a different backend.
 */

/**
 * Loads `.env.local` into the process unless a DATABASE_URL is already set, so
 * a one-off run against a scratch database is not silently overwritten by
 * whatever is in the file. Idempotent, and safe to call before reading any
 * variable the file carries.
 *
 * Nothing here runs at module load and nothing here imports `node:fs`, because
 * `packages/db` is imported by a Worker now. Both were true before and both
 * broke workerd: the `node:fs` import fails the build, and resolving the path
 * against `import.meta.url` threw `Invalid URL string` at startup, measured
 * against `wrangler dev` 2026-08-28. The missing file is caught rather than
 * tested for, and the guard below is what says the whole function is Node's.
 */
export function loadLocalEnv() {
  if (process.env.DATABASE_URL || typeof process.loadEnvFile !== "function") {
    return
  }
  try {
    // The cast is for Worker projects, whose generated global URL does not fit Node's.
    process.loadEnvFile(
      new URL("../../../.env.local", import.meta.url) as import("node:url").URL
    )
  } catch {
    // No .env.local. Every caller either has DATABASE_URL in the environment
    // already or is about to fail in `parseEnv` naming the variable.
  }
}

/** `DATABASE_URL`, after `.env.local`. The Node side of the tenancy kit. */
export function connectionString(): string {
  loadLocalEnv()
  return parseEnv().DATABASE_URL
}

export function connect(options: { max?: number } = {}) {
  loadLocalEnv()
  const env = parseEnv()
  const sql = postgres(env.DATABASE_URL, {
    max: options.max ?? 1,
    // postgres.js dumps the whole notice object by default, which buries a
    // migration log under `CREATE ... IF NOT EXISTS` chatter.
    onnotice: (notice) => console.log(`notice: ${notice.message}`),
  })
  return { sql, db: drizzle(sql, { schema }) }
}
