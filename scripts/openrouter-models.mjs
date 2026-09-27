// `pnpm --filter @workspace/facade models`: regenerate the OpenRouter model
// entries the facade layers over Pi's catalog.
//
// Pi's catalog lags OpenRouter and its prices go stale, and flue refuses a
// model id the provider does not declare. So the ids the facade needs live in
// one list, this script reads OpenRouter's public model list for them, and
// writes entries in Pi's own `Model` shape. Run it when a model is added or
// when `pnpm eval` reports a cost drift; a test fails when an id in the list
// has no generated entry. No key is needed: the list is public. The pricing
// rule itself is `openrouterEntry` in packages/facade/src/models/price.ts.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { openrouterEntry } from "../packages/facade/src/models/price.ts"

const dir = fileURLToPath(
  new URL("../packages/facade/src/models/", import.meta.url)
)
const ids = JSON.parse(readFileSync(`${dir}openrouter.ids.json`, "utf8"))

const res = await fetch("https://openrouter.ai/api/v1/models")
if (!res.ok) {
  console.error(`openrouter answered ${res.status}`)
  process.exit(1)
}
const { data } = await res.json()
const byId = new Map(data.map((m) => [m.id, m]))

/** Every provider serving `id`, with its own pricing (one request per id). */
async function endpoints(id) {
  const r = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`)
  if (!r.ok) {
    console.error(`openrouter answered ${r.status} for ${id}'s endpoints`)
    process.exit(1)
  }
  return (await r.json()).data.endpoints
}

const models = []
/** How many distinct live providers each model's cap admits, printed. */
const admittedBy = new Map()
const missing = []
for (const id of ids) {
  const m = byId.get(id)
  if (!m) {
    missing.push(id)
    continue
  }
  const { entry, live } = openrouterEntry(m, await endpoints(id))
  admittedBy.set(id, live)
  models.push(entry)
}
if (missing.length > 0) {
  console.error(`not on OpenRouter's list: ${missing.join(", ")}`)
  process.exit(1)
}
models.sort((a, b) => a.id.localeCompare(b.id))
const out = `${dir}openrouter.models.json`
writeFileSync(out, `${JSON.stringify(models, null, 2)}\n`)
// Biome's shape, so the committed file and the regenerated one diff clean.
execFileSync("pnpm", ["exec", "biome", "format", "--write", out], {
  stdio: "ignore",
})
for (const m of models) {
  console.log(
    `${m.id}  in $${m.cost.input}/M  out $${m.cost.output}/M  context ${m.contextWindow}  live providers under the cap ${admittedBy.get(m.id)}`
  )
}
