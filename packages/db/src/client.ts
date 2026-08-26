import { existsSync } from "node:fs"
import { parseEnv } from "@workspace/config"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.ts"

const localEnv = new URL("../../../.env.local", import.meta.url)

/**
 * The Node-side connection, used by migrations, seeds and tests. Workers get
 * their handle from the tenant context in `apps/api`; this is not that path.
 *
 * One connection on purpose: the migration advisory lock is session-scoped, so
 * the session that takes it has to be the session that runs the DDL.
 */
export function connect() {
  // An explicit DATABASE_URL wins, so a one-off run against a scratch database
  // is not silently overwritten by whatever is in .env.local.
  if (!process.env.DATABASE_URL && existsSync(localEnv)) {
    process.loadEnvFile(localEnv)
  }
  const env = parseEnv()
  const sql = postgres(env.DATABASE_URL, {
    max: 1,
    // postgres.js dumps the whole notice object by default, which buries a
    // migration log under `CREATE ... IF NOT EXISTS` chatter.
    onnotice: (notice) => console.log(`notice: ${notice.message}`),
  })
  return { sql, db: drizzle(sql, { schema }) }
}
