import { readFileSync } from "node:fs"
import {
  askGate,
  GATE,
  modelInput,
  replyOf,
  writerPrompt,
  writeText,
} from "../apps/orchestrator/src/heartbeat-write.ts"

/**
 * HB2's check: does the heartbeat speak when the labels say it should?
 *
 *   node --env-file=.env.local evals/heartbeat.mjs [--dry]
 *
 * Reads `heartbeat/digests.json`, 30 digests in three groups of 10. Each case
 * goes through the beat as the handler runs it: an owner in the chat or
 * nothing new stops it in code; otherwise Jev's gate, then the writer at low
 * effort, whose reply speaks only as a message inside the limits. Two gates
 * are scored from the same calls: `dial`, the dial's bar in `GATE.threshold`,
 * and `floor`, Jev at 0.3 with the writer judging the rest. Passes when
 * either agrees with the labels on 25 of 30, and prints the cost. `--dry`
 * makes no model call: it checks the set's shape and the cases code decides
 * alone. Live, it spends real money on `OPENROUTER_API_KEY`.
 */

const FLOOR = 0.3
/** The most one run may spend, in USD; the run stops before a call past it. */
const BUDGET = 0.15
const sum = (xs) => xs.reduce((s, x) => s + x, 0)
const GATES = ["dial", "floor"]

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

const spend = { gate: [], writer: [] }
const rows = []
for (const c of set.cases) {
  const fresh = c.items.filter((item) => !(c.surfaced ?? []).includes(item.key))
  const bars = { dial: GATE.threshold[c.dial], floor: FLOOR }
  const decided = {}
  let step
  let text = ""
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
    const { state, data } = modelInput({
      zone: set.zone,
      now: new Date(c.now),
      items: fresh,
      profile: c.profile ?? null,
      last: c.last ? { text: c.last.text, at: new Date(c.last.at) } : null,
    })
    const gate = await askGate(key, state)
    spend.gate.push(gate.spent.cost_usd)
    step = `gate ${gate.probability.toFixed(2)}`
    // One writer call serves both gates: its input does not depend on the bar.
    let writer = null
    if (gate.probability >= Math.min(...Object.values(bars))) {
      if (sum([...spend.gate, ...spend.writer]) > BUDGET - 0.02)
        throw new Error(`stopped at the $${BUDGET} budget before ${c.id}`)
      const written = await writeText(key, writerPrompt(c.dial), data)
      spend.writer.push(written.spent.cost_usd)
      const reply = replyOf(written.text, fresh)
      text = written.text.replace(/\s+/g, " ")
      writer = reply.kind === "message" ? "speak" : "quiet"
      step += `, ${reply.kind === "error" ? reply.detail : reply.kind}`
    }
    for (const g of GATES)
      decided[g] = gate.probability >= bars[g] ? writer : "quiet"
  }
  rows.push({ ...c, decided, step, text })
  const mark = (g) =>
    decided[g] === null ? "--" : decided[g] === c.label ? "ok" : "NO"
  console.log(
    `${GATES.map(mark).join(" ")}  ${c.id.padEnd(30)} ${c.label.padEnd(5)} ${c.dial.padEnd(7)} ${step}${text ? `\n         "${text}"` : ""}`
  )
}

let best = 0
for (const g of GATES) {
  const counted = rows.filter((r) => r.decided[g] !== null)
  const agree = counted.filter((r) => r.decided[g] === r.label).length
  best = Math.max(best, agree)
  const byGroup = ["quiet", "speak", "borderline"]
    .map((group) => {
      const of = counted.filter((r) => r.group === group)
      return `${group} ${of.filter((r) => r.decided[g] === r.label).length}/${of.length}`
    })
    .join(", ")
  const writes = rows.filter(
    (r) =>
      r.decided[g] !== null && r.step.includes(",") && r.decided[g] !== "quiet"
  ).length
  console.log(
    `\n${g}: agree ${agree} of ${counted.length}; ${byGroup}; messages sent ${writes}`
  )
}
if (!dry) {
  const gate = sum(spend.gate)
  const writer = sum(spend.writer)
  console.log(
    `cost: gate $${gate.toFixed(6)} over ${spend.gate.length} calls, writer $${writer.toFixed(6)} over ${spend.writer.length} calls, total $${(gate + writer).toFixed(6)}`
  )
  if (best < 25) process.exitCode = 1
} else if (
  rows.some((r) => GATES.some((g) => r.decided[g] && r.decided[g] !== r.label))
)
  process.exitCode = 1
