// `pnpm --filter <pkg> exec node ../../scripts/floor.mjs <gate> -- vitest run ...`
//
// Runs a blocking suite and fails when it passed fewer tests than its floor.
// Exit 0 is not evidence: a suite whose cases all skipped, or whose files were
// never found, exits 0 having proven nothing, and this repo has shipped that
// four times. Floors live in floors.json and ratchet up like size-budget.json.
//
// Meant to be a package script, not a shell command: the suite is spawned
// without a shell, so `vitest` resolves through the package's own bin directory
// and not from an arbitrary cwd.
//
// Skips are printed, not failed. One is legitimate (tenancy/pooler.test.ts
// needs a pooler CI has none of), and a gate that cries wolf gets bypassed.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const [gate, separator, ...command] = process.argv.slice(2)
if (!gate || separator !== "--" || command.length === 0) {
  console.error("usage: node scripts/floor.mjs <gate> -- <command...>")
  process.exit(2)
}

const floors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./floors.json", import.meta.url)), "utf8")
)
// A database unskips live cases, so a gate can have two floors. Gates without a
// `+db` entry share one, which is only safe while they fail rather than skip
// when the database is missing. floors.json says so.
const withDatabase = `${gate}+db`
const key =
  process.env.DATABASE_URL && withDatabase in floors ? withDatabase : gate
const floor = floors[key]
if (typeof floor !== "number") {
  console.error(`floor: no floor for "${key}". Add one to scripts/floors.json.`)
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), "reme-floor-"))
const report = join(dir, "report.json")
const clean = () => rmSync(dir, { recursive: true, force: true })

const run = spawnSync(
  command[0],
  // `default` as well as `json`, because `--reporter=json` alone replaces the
  // console reporter: a failing suite then prints one summary line and no test
  // name, file or diff, and a gate nobody can read from the log is a gate
  // people route around.
  [
    ...command.slice(1),
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { stdio: "inherit" }
)

if (run.error) {
  clean()
  console.error(
    run.error.code === "ENOENT"
      ? `floor ${key}: ${command[0]} is not on the path. Run this as a package script.`
      : `floor ${key}: ${command[0]} could not start. ${run.error.message}`
  )
  process.exit(1)
}

let results
try {
  results = JSON.parse(readFileSync(report, "utf8"))
} catch {
  clean()
  console.error(
    `floor ${key}: the suite wrote no report, so nothing can say what it ran.`
  )
  process.exit(run.status || 1)
}
clean()

const passed = results.numPassedTests ?? 0
const failed = results.numFailedTests ?? 0
const skipped = (results.testResults ?? [])
  .flatMap((file) => file.assertionResults ?? [])
  .filter((test) => test.status === "pending" || test.status === "skipped")

if (skipped.length > 0) {
  console.log(
    `floor ${key}: ${skipped.length} case(s) skipped, and did not count:`
  )
  for (const test of skipped) console.log(`  - ${test.fullName ?? test.title}`)
}

// The suite's own verdict first: a floor failure printed over a real test
// failure buries the thing worth reading.
if (run.status !== 0 || failed > 0) {
  console.error(
    `floor ${key}: the suite failed. ${passed} passed, ${failed} failed.`
  )
  process.exit(run.status || 1)
}

if (passed < floor) {
  console.error(
    `floor ${key}: ${passed} test(s) passed against a floor of ${floor}.\n` +
      "If cases were removed on purpose, lower the number in scripts/floors.json in the same commit."
  )
  process.exit(1)
}

console.log(`floor ${key}  ${passed} passed against a floor of ${floor}`)
