import { readFileSync } from "node:fs"
import {
  laneRows,
  render,
  roleRows,
  timingsOf,
  turnsOf,
} from "./latency/stats.mjs"

/**
 * EV3's speed and cost table, for a PR that touches the builder to paste in:
 *
 *   node evals/latency.mjs --timing lines.log [--cost turns.jsonl] [--baseline qe1.log]
 *
 * `--timing` is a file of log lines holding `revise.timing` JSON (a wrangler
 * tail, a Workers Logs export, or the bare lines); anything else in it is
 * skipped. `--cost` is the billed-cost tap read back: `runtime.turn` event
 * rows, one JSON per line, whose `response.usage.cost.total` is what
 * OpenRouter billed (the facade's tap writes it there). `--baseline` is QE1's
 * timing lines from before the change, for the `preview_ready` comparison.
 * Reads files only; no model calls.
 */

function parse(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      throw new Error(
        `bad argument ${argv[i]}; see the header of evals/latency.mjs`
      )
    }
    opts[argv[i].slice(2)] = argv[i + 1]
  }
  if (!opts.timing) throw new Error("--timing <file> is required")
  return opts
}

try {
  const opts = parse(process.argv.slice(2))
  const read = (file) => (file ? readFileSync(file, "utf8") : "")
  const timings = timingsOf(read(opts.timing))
  if (!timings.length)
    throw new Error(`no revise.timing lines in ${opts.timing}`)
  const turns = turnsOf(read(opts.cost))
  console.log(
    render(
      laneRows(timings, turns, timingsOf(read(opts.baseline))),
      roleRows(turns)
    )
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
