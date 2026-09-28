import { existsSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { contextHash } from "@workspace/facade"
import { exportRun } from "./langfuse.mjs"
import { canonical, loadFixture, loadSession, replay } from "./replay.mjs"

/**
 * `pnpm eval [--tier 1|2|3]`, the §16.3 eval runner.
 *
 * Two passes. First every recorded fixture is replayed twice and both hashes
 * are checked against the one the fixture is pinned to, because a scenario
 * scored against a context that drifts between runs is scoring noise. Then the
 * tier's scenarios run. There are none: the runtimes they would score land in
 * Phase 3, and a tier directory is created by the PR that puts the first
 * scenario in it.
 */

const dir = (name) => fileURLToPath(new URL(name, import.meta.url))

/** §16.3. The description is what a scenario in that tier has to be about. */
const TIERS = {
  1: "contract: schema-valid role output, InformationRequest over fabrication",
  2: "live-cheap: one golden build per fixture org on staging, fabrication count, gate pass rate, tokens and cost",
  3: "end-to-end: golden assignment on a fixture org, fabrication count 0",
}

function parseTiers(argv) {
  const at = argv.indexOf("--tier")
  if (at === -1) return Object.keys(TIERS).map(Number)
  const tier = Number(argv[at + 1])
  if (!TIERS[tier]) {
    console.error(
      `unknown tier: ${argv[at + 1] ?? "(missing)"}. Use 1, 2 or 3.`
    )
    process.exit(2)
  }
  return [tier]
}

/** Files ending `.eval.mjs` in `evals/tier-N`. An absent tier has none. */
function scenarioFiles(tier) {
  const path = dir(`./tier-${tier}`)
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter((name) => name.endsWith(".eval.mjs"))
    .sort()
    .map((name) => `${path}/${name}`)
}

// Parsed before anything runs, so a bad flag costs nothing.
const tiers = parseTiers(process.argv)

let failed = 0
const fail = (message) => {
  console.error(`FAIL  ${message}`)
  failed += 1
}

// The one property no fixture exercises: two objects differing only in key
// order have to canonicalise the same. Deleting the sort in `canonical` passes
// every fixture and quietly makes every hash after it depend on the order keys
// were assigned in, so it is asserted rather than assumed.
if (
  canonical({ b: 1, a: [2, { d: 3, c: 4 }] }) !==
  canonical({ a: [2, { c: 4, d: 3 }], b: 1 })
) {
  fail("canonical() is order-dependent, so no hash below can be trusted")
}

// The floor. With no scenarios yet, replaying the fixtures is all this gate
// does, so an empty `fixtures/` would make `pnpm eval` a green step that ran
// nothing. Same rule as scripts/floor.mjs and the secret scan.
const fixtureNames = readdirSync(dir("./fixtures")).sort()
if (fixtureNames.length === 0) {
  fail("evals/fixtures holds no fixtures, so this run checked nothing")
}

for (const name of fixtureNames) {
  // Two kinds: a chunk stream the chat surface recorded, folded here, and a
  // Developer session the orchestrator logged, folded by the facade (§10.6).
  const session = loadSession(dir(`./fixtures/${name}`))
  const fixture = session ?? loadFixture(dir(`./fixtures/${name}`))
  const fold = session
    ? () => contextHash(session.events)
    : () => replay(fixture)
  const first = fold()
  const second = fold()
  if (first !== second) {
    fail(`${fixture.fixture} replayed twice and differed: ${first} ${second}`)
  } else if (first !== fixture.hash) {
    fail(
      `${fixture.fixture} replayed to ${first}, pinned to ${fixture.hash}. ` +
        (session
          ? `Re-record with \`pnpm record:session <org> <assignment id> ${fixture.fixture}\``
          : "Re-record with a paid live run on staging (`evals/record.mjs`, see evals/README.md)") +
        " and read the diff."
    )
  } else {
    console.log(`ok    ${fixture.fixture} replayed twice, ${first}`)
  }
}

let scenarios = 0
for (const tier of tiers) {
  const files = scenarioFiles(tier)
  console.log(`tier ${tier}  ${files.length} scenarios  (${TIERS[tier]})`)
  for (const file of files) {
    scenarios += 1
    try {
      // A scenario is a function that throws. Nothing scores one yet, and a
      // result shape invented before its first consumer is a shape that gets
      // rewritten by it. The import is inside the try so a scenario that fails
      // to load fails that scenario rather than the run.
      await (await import(file)).default()
      console.log(`ok    ${file}`)
    } catch (error) {
      fail(`${file}: ${error.message}`)
    }
  }
}

exportRun({ scenarios, failed })

if (failed > 0) process.exit(1)
