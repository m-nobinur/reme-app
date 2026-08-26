// Loads the golden fixture orgs into the database named by DATABASE_URL.
import { bad, loadLocalEnv, note, ok, repoRoot } from "./lib.mjs"

process.chdir(repoRoot)
loadLocalEnv()

const { parseEnv } = await import("@workspace/config")

// Fails here, naming the variable, rather than at the first query.
let env
try {
  env = parseEnv()
} catch (error) {
  bad(String(error instanceof Error ? error.message : error))
  process.exit(1)
}

ok(`DATABASE_URL points at ${new URL(env.DATABASE_URL).host}`)
note("Nothing to seed yet: there is no schema and there are no fixtures.")
note("This script fills in when the Drizzle schema and the golden orgs land.")
