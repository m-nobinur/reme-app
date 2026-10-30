import { readFileSync } from "node:fs"
import {
  askGate,
  GATE,
  modelInput,
} from "../apps/orchestrator/src/heartbeat-write.ts"

/**
 * HB2's check, for Jev's gate: does it let through what the labels say to
 * speak about?
 *
 *   node --env-file=.env.local evals/heartbeat.mjs [--dry]
 *
 * Reads `heartbeat/digests.json`, 30 digests in three groups of 10. Each case
 * goes through the beat as the handler runs it: an owner in the chat or
 * nothing new stops it in code; otherwise Jev's gate. Past the gate, the
 * proactive CoS turn judges the rest and may stay `[quiet]`, so the gate
 * passes when `floor`, the shipped `GATE.floor`, stops none of the `speak`
 * cases; `dial`, the bar per dial it was chosen over, is scored beside it.
 * Prints how many cases each gate would hand to the CoS, and the cost.
 * `--dry` makes no model call: it checks the set's shape and the cases code
 * decides alone. Live, it spends real money on `OPENROUTER_API_KEY`.
 */

/** The bar per dial that `GATE.floor` was chosen over, kept to compare on new labels. */
const DIAL = { low: 0.9, default: 0.6, high: 0.5 }
/** The most one run may spend, in USD; the run stops before a call past it. */
const BUDGET = 0.05
const sum = (xs) => xs.reduce((s, x) => s + x, 0)
const GATES = ["floor", "dial"]

const set = JSON.parse(
  readFileSync(new URL("./heartbeat/digests.json", import.meta.url), "utf8")
)
const dry = process.argv.includes("--dry")
// biome-ignore lint/suspicious/noUndeclaredEnvVars: not passed through turbo, a task that saw the key would run the facade live tests
const key = process.env.OPENROUTER_API_KEY
if (!dry && !key) throw new Error("OPENROUTER_API_KEY is not set")

const groups = Object.groupBy(set.cases, (c) => c.group)
for (const group of ["quiet", "speak", "borderline"]) {
  if (groups[group]?.length !== 10)
    throw new Error(`the ${group} group must hold 10 cases`)
}

const spend = []
const rows = []
for (const c of set.cases) {
  const fresh = c.items.filter((item) => !(c.surfaced ?? []).includes(item.key))
  const bars = { floor: GATE.floor, dial: DIAL[c.dial] }
  /** Per gate: `speak` when it hands the beat to the CoS, null when not run. */
  const decided = {}
  let step
  if (c.owner_active || fresh.length === 0) {
    step = c.owner_active
      ? "owner_active"
      : c.items.length
        ? "unchanged"
        : "empty"
    for (const g of GATES) decided[g] = "quiet"
  } else if (dry) {
    step = "model"
    for (const g of GATES) decided[g] = null
  } else {
    if (sum(spend) > BUDGET - 0.005)
      throw new Error(`stopped at the $${BUDGET} budget before ${c.id}`)
    const { state } = modelInput({
      zone: set.zone,
      now: new Date(c.now),
      items: fresh,
      profile: c.profile ?? null,
    })
    const gate = await askGate(key, state)
    spend.push(gate.spent.cost_usd)
    step = `gate ${gate.probability.toFixed(2)}`
    for (const g of GATES)
      decided[g] = gate.probability >= bars[g] ? "speak" : "quiet"
  }
  rows.push({ ...c, decided, step })
  const mark = (g) =>
    decided[g] === null
      ? "--"
      : decided[g] === "quiet" && c.label === "speak"
        ? "NO"
        : "ok"
  console.log(
    `${GATES.map(mark).join(" ")}  ${c.id.padEnd(30)} ${c.label.padEnd(5)} ${c.dial.padEnd(7)} ${step}`
  )
}

let stopped = 0
for (const g of GATES) {
  const counted = rows.filter((r) => r.decided[g] !== null)
  const missed = counted.filter(
    (r) => r.label === "speak" && r.decided[g] === "quiet"
  ).length
  if (g === "floor") stopped = missed
  const handed = counted.filter((r) => r.decided[g] === "speak").length
  console.log(
    `\n${g}: hands ${handed} of ${counted.length} to the CoS; stops ${missed} the labels say to speak about`
  )
}
if (!dry)
  console.log(`cost: gate $${sum(spend).toFixed(6)} over ${spend.length} calls`)
if (stopped > 0) process.exitCode = 1
