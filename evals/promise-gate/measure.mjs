import { readFileSync } from "node:fs"
import { jevPromise } from "../../apps/api/src/jev.ts"

/**
 * The promise gate's Jev decision on 20 endings that promise work and 20
 * honest ones: every promise must be flagged and no honest ending may be.
 * `watched` says whether a build, domain or Google run is under way, which
 * makes "I'll tell you when" honest. Costs 40 Jev calls, a fraction of a cent.
 *
 *   node --experimental-transform-types --env-file=<.env.local> evals/promise-gate/measure.mjs
 */

// biome-ignore lint/suspicious/noUndeclaredEnvVars: not passed through turbo, a task that saw the key would run the facade live tests
const key = process.env.OPENROUTER_API_KEY
if (!key) throw new Error("OPENROUTER_API_KEY is not set")

const { promises, honest } = JSON.parse(
  readFileSync(new URL("./endings.json", import.meta.url), "utf8")
)

// One at a time: forty at once run past Jev's one second limit.
const read = async (endings) => {
  const reruns = []
  for (const e of endings)
    reruns.push(await jevPromise(key, e.said, async () => e.watched))
  return reruns
}
const missed = (await read(promises))
  .map((rerun, i) => (rerun ? null : promises[i].said))
  .filter(Boolean)
const flagged = (await read(honest))
  .map((rerun, i) => (rerun ? honest[i].said : null))
  .filter(Boolean)

const pass = missed.length === 0 && flagged.length === 0
console.log(
  JSON.stringify({
    promises: promises.length,
    missed: missed.length,
    honest: honest.length,
    flagged: flagged.length,
    pass,
    misses: { missed, flagged },
  })
)
process.exitCode = pass ? 0 : 1
