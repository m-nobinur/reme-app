// `pnpm --filter @workspace/facade models`: regenerate the OpenRouter model
// entries the facade layers over Pi's catalog.
//
// Pi's catalog lags OpenRouter and its prices go stale, and flue refuses a
// model id the provider does not declare. So the ids the facade needs live in
// one list, this script reads OpenRouter's public model list for them, and
// writes entries in Pi's own `Model` shape. Run it when a model is added or
// when `pnpm eval` reports a cost drift; a test fails when an id in the list
// has no generated entry. No key is needed: the list is public.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

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

/** Dollars per token as OpenRouter prints them, to dollars per million. */
const perMillion = (value) => Math.round(Number(value ?? 0) * 1e6 * 1e6) / 1e6

/** The highest rate a pricing block charges for `key` at any hour of any day. */
const peak = (pricing, key) =>
  Math.max(
    perMillion(pricing?.[key]),
    ...(pricing?.overrides ?? []).map((o) => perMillion(o[key]))
  )

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
const missing = []
for (const id of ids) {
  const m = byId.get(id)
  if (!m) {
    missing.push(id)
    continue
  }
  // Pi's cost table has one rate, and OpenRouter's list price moves by the
  // hour for some models, so the rate is the day's peak. Cache reads are not
  // capped by routing, so theirs is the dearest provider the cap still admits.
  const cost = {
    input: peak(m.pricing, "prompt"),
    output: peak(m.pricing, "completion"),
    cacheRead: 0,
    cacheWrite: 0,
  }
  for (const e of await endpoints(id)) {
    if (peak(e.pricing, "prompt") > cost.input) continue
    if (peak(e.pricing, "completion") > cost.output) continue
    cost.cacheRead = Math.max(
      cost.cacheRead,
      peak(e.pricing, "input_cache_read")
    )
  }
  models.push({
    id,
    name: m.name,
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    provider: "openrouter",
    reasoning: (m.supported_parameters ?? []).includes("reasoning"),
    input: (m.architecture?.input_modalities ?? ["text"]).filter(
      (mode) => mode === "text" || mode === "image"
    ),
    cost,
    contextWindow: m.context_length,
    maxTokens: m.top_provider?.max_completion_tokens ?? 0,
    compat: {
      thinkingFormat: "openrouter",
      // The rate above is a ceiling OpenRouter routes under, so what it bills
      // for a turn is never more than the log says the turn cost, and the
      // budget cap summed from the log holds (§29.2). Measured 2026-09-17:
      // unbounded, a turn went to a provider 5% under the list rate, and
      // two others serving this model charge up to 25% over it.
      openRouterRouting: {
        max_price: { prompt: cost.input, completion: cost.output },
      },
    },
  })
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
    `${m.id}  in $${m.cost.input}/M  out $${m.cost.output}/M  context ${m.contextWindow}`
  )
}
