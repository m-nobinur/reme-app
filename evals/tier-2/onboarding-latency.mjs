/**
 * Where an onboarding turn's wait goes, against the real model. It runs the
 * planner eval's own conversation for a few owners and times each planner
 * request from the wire: when the first byte of the stream arrives, when
 * the model starts and stops reasoning, when the plan's JSON reaches `say`
 * and when `say` ends. A second planner request that starts while the first
 * is still open is the hedge firing (`PLANNER.hedgeMs`).
 *
 *   OPENROUTER_API_KEY=... ONBOARDING_EVAL_PERSONAS=cleaner \
 *     node --import ./evals/json-imports.mjs --experimental-transform-types \
 *     evals/tier-2/onboarding-latency.mjs
 *
 * `ONBOARDING_EVAL_PERSONAS` (comma list, default `cleaner`) and
 * `ONBOARDING_EVAL_CAP_USD` (default 0.5) narrow a run. Owners run one at a
 * time so the requests stay in order.
 */

process.env.ONBOARDING_EVAL_PERSONAS ??= "cleaner"
process.env.ONBOARDING_EVAL_CAP_USD ??= "0.5"

const calls = []
let seenUsage = false
const realFetch = globalThis.fetch

/** Reads a streamed completion's timings off a clone of the response. */
async function watch(call, body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  for (;;) {
    const { done, value } = await reader.read()
    const now = performance.now() - call.t0
    if (done) break
    call.firstByte ??= now
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue
      let chunk
      try {
        chunk = JSON.parse(line.slice(6))
      } catch {
        continue
      }
      // A keep-alive comment is not data: the first parsed chunk is.
      call.firstData ??= now
      const delta = chunk.choices?.[0]?.delta
      if (chunk.usage) {
        if (!seenUsage) console.log("usage:", JSON.stringify(chunk.usage))
        seenUsage = true
        call.reasoningTokens =
          chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0
        call.outputTokens = chunk.usage.completion_tokens
        call.cachedTokens =
          chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
      }
      if (delta?.content) {
        call.firstContent ??= now
        content += delta.content
        if (call.sayKey === undefined && /"say"\s*:/.test(content))
          call.sayKey = now
      }
    }
  }
  call.end = performance.now() - call.t0
}

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  const body = typeof init?.body === "string" ? init.body : ""
  // The planner's requests only: the owner simulator is a different model.
  if (!url.includes("/chat/completions") || body.includes("glm-5.3")) {
    return realFetch(input, init)
  }
  const call = { t0: performance.now(), startedAt: performance.now() }
  calls.push(call)
  const res = await realFetch(input, init)
  if (res.body) watch(call, res.clone().body).catch(() => undefined)
  return res
}

const { default: run } = await import("./onboarding-planner.eval.mjs")
await run().catch((error) => console.log(`eval: ${error.message}`))
await new Promise((resolve) => setTimeout(resolve, 500))

const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]
}
const ms = (n) => (n === null || n === undefined ? "-" : `${Math.round(n)}`)
const span = (a, b) => (a === undefined || b === undefined ? undefined : b - a)

// A request that starts about `hedgeMs` after the one before it, which has
// sent no data by then, is the hedge. The one before it is the slow call.
const rows = []
for (const [i, c] of calls.entries()) {
  const prev = calls[i - 1]
  const gap = prev ? c.startedAt - prev.startedAt : 0
  const hedge =
    prev !== undefined &&
    !rows[i - 1].hedge &&
    gap > 4_500 &&
    gap < 6_500 &&
    (prev.firstData === undefined || prev.firstData > gap)
  rows.push({
    n: i + 1,
    hedge,
    // The loser of a hedge is aborted, so it has no content to time.
    aborted: c.firstContent === undefined,
    wait: c.firstData,
    json: span(c.firstContent, c.sayKey),
    say: span(c.sayKey, c.end),
    sayStart: c.sayKey,
    total: c.end,
    reasoningTokens: c.reasoningTokens,
    outputTokens: c.outputTokens,
    cachedTokens: c.cachedTokens,
  })
}

console.log("\n--- onboarding latency (ms from request start)")
console.log(
  "call | hedge | aborted | wait for first data | JSON before say | say | say starts | total | reasoning tokens | output tokens | cached input tokens"
)
for (const r of rows) {
  console.log(
    `${r.n} | ${r.hedge ? "yes" : "no"} | ${r.aborted ? "yes" : "no"} | ${ms(r.wait)} | ${ms(r.json)} | ${ms(r.say)} | ${ms(r.sayStart)} | ${ms(r.total)} | ${r.reasoningTokens ?? "-"} | ${r.outputTokens ?? "-"} | ${r.cachedTokens ?? "-"}`
  )
}
const col = (key) => rows.map((r) => r[key]).filter((v) => v !== undefined)
for (const key of [
  "wait",
  "json",
  "say",
  "sayStart",
  "total",
  "reasoningTokens",
  "outputTokens",
]) {
  console.log(
    `${key}: p50 ${ms(percentile(col(key), 50))}, p95 ${ms(percentile(col(key), 95))}, max ${ms(Math.max(...col(key)))}`
  )
}
console.log(
  `planner requests ${rows.length}, hedges ${rows.filter((r) => r.hedge).length}, aborted ${rows.filter((r) => r.aborted).length}`
)
