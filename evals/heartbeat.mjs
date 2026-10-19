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
 * nothing new stops it in code; otherwise Jev's gate at the dial's bar, then
 * the writer at low effort, whose reply speaks only as a message inside the
 * limits. Passes on 25 of 30 agreeing with the labels, and prints the cost.
 * `--dry` makes no model call: it checks the set's shape and the cases code
 * decides alone. Live, it spends real money on `OPENROUTER_API_KEY`.
 */

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
  let decided
  let step
  let text = ""
  if (c.owner_active) [decided, step] = ["quiet", "owner_active"]
  else if (fresh.length === 0)
    [decided, step] = ["quiet", c.items.length ? "unchanged" : "empty"]
  else if (dry) [decided, step] = [null, "model"]
  else {
    const { state, data } = modelInput({
      zone: set.zone,
      now: new Date(c.now),
      items: fresh,
      profile: c.profile ?? null,
      last: c.last ? { text: c.last.text, at: new Date(c.last.at) } : null,
    })
    const gate = await askGate(key, state)
    spend.gate.push(gate.spent.cost_usd)
    if (gate.probability < GATE.threshold[c.dial]) {
      ;[decided, step] = ["quiet", `gate ${gate.probability.toFixed(2)}`]
    } else {
      const written = await writeText(key, writerPrompt(c.dial), data)
      spend.writer.push(written.spent.cost_usd)
      const reply = replyOf(written.text, fresh)
      text = written.text.replace(/\s+/g, " ")
      decided = reply.kind === "message" ? "speak" : "quiet"
      step = `gate ${gate.probability.toFixed(2)}, ${reply.kind === "error" ? reply.detail : reply.kind}`
    }
  }
  rows.push({ ...c, decided, step, text })
  console.log(
    `${decided === null ? "  " : decided === c.label ? "ok" : "NO"}  ${c.id.padEnd(30)} ${c.label.padEnd(5)} ${String(decided ?? "-").padEnd(5)} ${step}${text ? `\n      "${text}"` : ""}`
  )
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0)
const decidedRows = rows.filter((r) => r.decided !== null)
const agree = decidedRows.filter((r) => r.decided === r.label).length
console.log(
  `\nagree ${agree} of ${decidedRows.length}; by group: ${[
    "quiet",
    "speak",
    "borderline",
  ]
    .map((g) => {
      const of = decidedRows.filter((r) => r.group === g)
      return `${g} ${of.filter((r) => r.decided === r.label).length}/${of.length}`
    })
    .join(", ")}`
)
if (!dry) {
  const gate = sum(spend.gate)
  const writer = sum(spend.writer)
  console.log(
    `cost: gate $${gate.toFixed(6)} over ${spend.gate.length} calls, writer $${writer.toFixed(6)} over ${spend.writer.length} calls, total $${(gate + writer).toFixed(6)}`
  )
  if (agree < 25) process.exitCode = 1
} else if (agree !== decidedRows.length) process.exitCode = 1
