// Loads the golden fixture orgs into the database named by DATABASE_URL.
//
// `--reset` clears the three orgs first, so the database ends up matching
// packages/db/fixtures/golden.ts exactly. Without it the inserts skip rows that
// are already there and leave everything else in the database alone. Both forms
// are safe to run twice.
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

const reset = process.argv.includes("--reset")
const { seedGolden } = await import("@workspace/db/fixtures/seed")
const counts = await seedGolden({ reset })

const host = new URL(env.DATABASE_URL).host
ok(reset ? `re-seeded ${host} from scratch` : `seeded ${host}`)
note(
  Object.entries(counts)
    .map(([table, n]) => `${table}: ${n}`)
    .join("\n")
)
if (!reset) {
  note(
    "Rows that were already there were left alone. Use --reset to bring the\n" +
      "database back in line with the fixture file."
  )
}
