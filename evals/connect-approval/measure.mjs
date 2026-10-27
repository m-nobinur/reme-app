import { readFileSync } from "node:fs"
import { jevPutOn } from "../../apps/api/src/jev.ts"

/**
 * Whether connect_domain runs with no card: Jev's reading of 10 messages that
 * put the site on a name and 10 vague ones. Every put-on must run and no
 * vague message may, where "run" is what `connectApproval` does after its
 * floors (`jevPutOn` is true). The tray's exact "Yes, it's <name>" never
 * reaches Jev, a message without the name neither. Costs 20 Jev calls at
 * most, a fraction of a cent.
 *
 *   node --experimental-transform-types --env-file=<.env.local> evals/connect-approval/measure.mjs
 */

// biome-ignore lint/suspicious/noUndeclaredEnvVars: not passed through turbo, a task that saw the key would run the facade live tests
const key = process.env.OPENROUTER_API_KEY
if (!key) throw new Error("OPENROUTER_API_KEY is not set")

const { puts, vague } = JSON.parse(
  readFileSync(new URL("./messages.json", import.meta.url), "utf8")
)

// One at a time: twenty at once run past Jev's one second limit.
const runs = async (cases) => {
  const ran = []
  for (const c of cases) ran.push(await jevPutOn(key, c.said, c.name))
  return ran
}
const missed = (await runs(puts))
  .map((ran, i) => (ran ? null : puts[i].said))
  .filter(Boolean)
const ranAnyway = (await runs(vague))
  .map((ran, i) => (ran ? vague[i].said : null))
  .filter(Boolean)

const pass = missed.length === 0 && ranAnyway.length === 0
console.log(
  JSON.stringify({
    puts: puts.length,
    missed: missed.length,
    vague: vague.length,
    ran_anyway: ranAnyway.length,
    pass,
    misses: { missed, ranAnyway },
  })
)
process.exitCode = pass ? 0 : 1
