import { appendFileSync } from "node:fs"

/**
 * Tier 2 (§16.3), live and cheap: one build per golden org on staging, each
 * watched to the first state that waits on someone, then cancelled so no
 * preview outlives the run and the site lock is free. From each run's own
 * log: the state it settled in, gate pass rate, fabrication count (content
 * gate failures), turns, tokens, cache hit and cost. The numbers go to the
 * job summary when there is one and to stdout always. Skipped, not failed,
 * without an orchestrator to talk to, so `pnpm eval` runs everywhere.
 */

const GOLDEN = ["brightclean", "mopandbucket", "emptyco"]
/** How many builds a run makes: one per golden org that has a Developer, topped up on the first that does. */
const RUNS = 3
const SETTLED = new Set([
  "preview_ready",
  "blocked_on_information",
  "blocked_on_approval",
  "failed",
  "cancelled",
])
/** How long one build may take before the run gives up on it. */
const TIMEOUT_MS = 15 * 60 * 1000
/** The most one run may spend, all three builds together. */
const SPEND_CAP_USD = 0.5

const base = (process.env.ORCHESTRATOR_URL ?? "").replace(/\/$/, "")
const token = process.env.ORCHESTRATOR_TOKEN ?? ""

async function call(method, path, org, body) {
  const url = new URL(`${base}${path}`)
  url.searchParams.set("org", org)
  const headers = { authorization: `Bearer ${token}` }
  if (body) headers["content-type"] = "application/json"
  if (method === "POST") headers["idempotency-key"] = crypto.randomUUID()
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Refused(res.status, json.code ?? "", path)
  return json
}

class Refused extends Error {
  constructor(status, code, path) {
    super(`${status} ${code} on ${path}`)
    this.code = code
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** What one run's log says about it. */
function numbers(events) {
  const turns = events.filter((e) => e.type === "runtime.turn")
  const sum = (key) =>
    turns.reduce((n, e) => n + (e.payload.response?.usage?.[key] ?? 0), 0)
  const input = sum("input")
  const cached = sum("cacheRead")
  const cost = turns.reduce(
    (n, e) => n + (e.payload.response?.usage?.cost?.total ?? 0),
    0
  )
  const reports = events.filter(
    (e) => e.type === "assignment.validation_reported"
  )
  const gates = reports.flatMap((e) => e.payload.gates ?? [])
  const fabrications = gates.filter(
    (g) => g.gate === "content" && !g.passed
  ).length
  const asked = events.filter((e) => e.type === "information.requested").length
  return {
    turns: turns.length,
    input_tokens: input,
    cached_tokens: cached,
    output_tokens: sum("output"),
    cache_hit: input + cached > 0 ? cached / (input + cached) : 0,
    cost_usd: cost,
    gates_run: gates.length,
    gates_passed: gates.filter((g) => g.passed).length,
    fabrications,
    asked,
  }
}

async function build(org) {
  const created = await call("POST", "/assignments", org, {
    kind: "site.build",
    model: "A",
    withhold: [],
  })
  const id = created.assignment_id
  const started = Date.now()
  let state = created.state
  while (!SETTLED.has(state)) {
    if (Date.now() - started > TIMEOUT_MS) break
    await sleep(10_000)
    state = (await call("GET", `/assignments/${id}`, org)).assignment.state
  }
  const { events } = await call("GET", `/assignments/${id}/events`, org)
  // Nothing from a nightly outlives it: the preview is retired and the lock freed.
  await call("POST", `/assignments/${id}/cancel`, org, {}).catch(
    () => undefined
  )
  return {
    org,
    assignment_id: id,
    state,
    seconds: Math.round((Date.now() - started) / 1000),
    ...numbers(events),
  }
}

export default async function goldenBuilds() {
  if (!base || !token) {
    console.log(
      "      skipped: ORCHESTRATOR_URL and ORCHESTRATOR_TOKEN name no orchestrator"
    )
    return
  }
  const rows = []
  const skipped = []
  // One build per golden org that has a Developer; an org seeded without one
  // is a row that says so. The pass over the orgs done, the count is topped
  // up on the first org that built.
  for (const org of GOLDEN) {
    try {
      rows.push(await build(org))
    } catch (error) {
      if (
        error instanceof Refused &&
        error.code === "staff.developer_missing"
      ) {
        skipped.push(org)
        continue
      }
      throw error
    }
  }
  while (rows.length > 0 && rows.length < RUNS) {
    rows.push(await build(rows[0].org))
    const spent = rows.reduce((n, r) => n + r.cost_usd, 0)
    if (spent > SPEND_CAP_USD) {
      throw new Error(
        `spend cap: $${spent.toFixed(4)} after ${rows.length} builds`
      )
    }
  }
  const total = {
    cost_usd: rows.reduce((n, r) => n + r.cost_usd, 0),
    fabrications: rows.reduce((n, r) => n + r.fabrications, 0),
    gates_run: rows.reduce((n, r) => n + r.gates_run, 0),
    gates_passed: rows.reduce((n, r) => n + r.gates_passed, 0),
  }
  const rate =
    total.gates_run > 0
      ? `${Math.round((total.gates_passed / total.gates_run) * 100)}%`
      : "no gates ran"
  const lines = [
    "## Tier 2: golden builds on staging",
    "",
    `Fabrication count ${total.fabrications}, gate pass rate ${rate} (${total.gates_passed} of ${total.gates_run}), cost $${total.cost_usd.toFixed(4)}.`,
    "",
    "| Org | Settled in | Seconds | Asked | Turns | Input | Cached | Output | Cache hit | Gates | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.org} | ${r.state} | ${r.seconds} | ${r.asked} | ${r.turns} | ${r.input_tokens} | ${r.cached_tokens} | ${r.output_tokens} | ${Math.round(r.cache_hit * 100)}% | ${r.gates_passed}/${r.gates_run} | $${r.cost_usd.toFixed(4)} |`
    ),
    ...skipped.map(
      (org) => `| ${org} | no Developer seeded | | | | | | | | | |`
    ),
    "",
  ]
  console.log(lines.join("\n"))
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`)
  }
  const stuck = rows.filter(
    (r) => !SETTLED.has(r.state) || r.state === "failed"
  )
  if (stuck.length > 0) {
    throw new Error(
      `${stuck.map((r) => `${r.org} ${r.state}`).join(", ")} did not reach a preview or a question`
    )
  }
  if (total.fabrications > 0) {
    throw new Error(
      `${total.fabrications} content gate failure(s) across the golden builds`
    )
  }
}
