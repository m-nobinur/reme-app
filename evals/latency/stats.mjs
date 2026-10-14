/**
 * EV3's numbers, pure functions over log lines. The CLI (../latency.mjs)
 * only reads the files.
 */

/** Nearest-rank percentile: the smallest value with `p` of the sample at or below it. null when empty. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  return xs[Math.max(0, Math.ceil(p * xs.length) - 1)]
}

/**
 * The JSON object a log line carries, whatever wraps it: a bare object, text
 * before the first `{` (a tail's timestamp), or a Workers Logs row whose
 * `message` holds the line as a string or an object. null for anything else.
 */
export function parseLine(line) {
  const at = line.indexOf("{")
  if (at === -1) return null
  const parse = (text) => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  const obj = parse(line.slice(at))
  if (!obj) return null
  if (obj.type) return obj
  const inner =
    typeof obj.message === "string" ? parse(obj.message) : obj.message
  return inner && typeof inner === "object" ? inner : obj
}

const objects = (text) => text.split("\n").map(parseLine).filter(Boolean)

export const timingsOf = (text) =>
  objects(text).filter((o) => o.type === "revise.timing")

/**
 * `runtime.turn` rows, from the event log or the billed-cost tap's export,
 * as `{assignment, role, input, cacheRead, cacheWrite, output, cost}`. A row
 * carries a role when its writer set one (the quick lane's calls do); a
 * Developer turn has none, so the model it asked for stands in, then "unknown".
 */
export function turnsOf(text) {
  return objects(text)
    .filter((o) => o.type === "runtime.turn")
    .map((o) => {
      const p = o.payload ?? {}
      const usage = p.response?.usage ?? {}
      return {
        assignment: o.assignment_id ?? o.assignmentId ?? null,
        role:
          p.role ??
          p.request?.requestedModel ??
          p.model ??
          p.response?.model ??
          "unknown",
        input: usage.input ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        output: usage.output ?? 0,
        cost: usage.cost?.total ?? 0,
      }
    })
}

/** Dollars a drawn photo costs when the event carries no figure (images.ts ESTIMATE, 2026-10-14). */
const PHOTO_ESTIMATE = { "1K": 0.034, "2K": 0.05 }

/**
 * Photos drawn per assignment, from `site.photos` events (IG4's shape:
 * `payload.slots`, each with `source`, `resolution` and an `asset_id` once
 * drawn, and `regenerated` for a lone redraw). A build drew every generated
 * slot that has an asset; a redraw drew only the slot it names. Cost is the
 * payload's `cost_usd` when it has one, else the estimate per resolution:
 * the event holds no billed figure (that sits in R2 metadata).
 */
export function photosOf(text) {
  const out = new Map()
  for (const o of objects(text).filter((o) => o.type === "site.photos")) {
    const p = o.payload ?? {}
    const id = o.assignment_id ?? o.assignmentId
    if (!id || !Array.isArray(p.slots)) continue
    const drawn = p.slots.filter(
      (s) =>
        s.source === "generated" &&
        s.asset_id &&
        (!p.regenerated || s.id === p.regenerated)
    )
    out.set(id, {
      images: drawn.length,
      cost:
        typeof p.cost_usd === "number"
          ? p.cost_usd
          : drawn.reduce((n, s) => n + (PHOTO_ESTIMATE[s.resolution] ?? 0), 0),
    })
  }
  return out
}

/** The lane a timing line belongs to: `quick:copy`, `full:creative`, or `full:site.build` for a line from before lanes. */
export const laneOf = (t) =>
  `${t.lane ?? "full"}:${t.change_kind ?? t.kind ?? "unknown"}`

/**
 * One row per lane. Wall time is `end_to_end_ms`; `preview_ready_ms` counts
 * only builds that reached a preview. Cost is the sum of an assignment's turns
 * and is left out for an assignment with none. `baseline` is QE1's lines: the
 * p50 of `preview_ready_ms` (or `end_to_end_ms` where the line predates it)
 * over the same assignment `kind`, because the baseline has no lanes.
 */
export function laneRows(timings, turns, baseline = [], photos = new Map()) {
  const spent = Map.groupBy(
    turns.filter((t) => t.assignment),
    (t) => t.assignment
  )
  const baseOf = (kind) =>
    percentile(
      baseline
        .filter((b) => b.kind === kind)
        .map((b) => b.preview_ready_ms ?? b.end_to_end_ms),
      0.5
    )
  return [...Map.groupBy(timings, laneOf)].map(([lane, group]) => {
    const seconds = (key) =>
      group
        .map((t) => t[key])
        .filter((v) => v != null)
        .map((v) => v / 1000)
    const costs = group
      .filter((t) => spent.has(t.assignment_id))
      .map((t) => spent.get(t.assignment_id).reduce((n, r) => n + r.cost, 0))
    const drawn = group.map((t) => photos.get(t.assignment_id)).filter(Boolean)
    const ready = seconds("preview_ready_ms")
    const base = baseOf(group[0].kind)
    return {
      lane,
      n: group.length,
      wallP50: percentile(seconds("end_to_end_ms"), 0.5),
      wallP95: percentile(seconds("end_to_end_ms"), 0.95),
      readyP50: percentile(ready, 0.5),
      readyP95: percentile(ready, 0.95),
      baselineP50: base === null ? null : base / 1000,
      costN: costs.length,
      costP50: percentile(costs, 0.5),
      costP95: percentile(costs, 0.95),
      imagesN: drawn.length,
      imagesP50: percentile(
        drawn.map((d) => d.images),
        0.5
      ),
      imageCostP50: percentile(
        drawn.map((d) => d.cost),
        0.5
      ),
    }
  })
}

/** Cache-read tokens over everything the prompts held (uncached, read and written), per role. */
export function roleRows(turns) {
  return [...Map.groupBy(turns, (t) => t.role)].map(([role, group]) => {
    const sum = (key) => group.reduce((n, t) => n + t[key], 0)
    const prompt = sum("input") + sum("cacheRead") + sum("cacheWrite")
    return {
      role,
      turns: group.length,
      promptTokens: prompt,
      cacheRead: sum("cacheRead"),
      ratio: prompt ? sum("cacheRead") / prompt : null,
    }
  })
}

const fmt = (v, digits = 1) =>
  v === null || v === undefined
    ? "n/a"
    : Number.isInteger(v) && digits === 0
      ? String(v)
      : v.toFixed(digits)

const md = (head, rows) =>
  [head, head.map(() => "---"), ...rows]
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n")

/** Both tables as markdown, for a PR body. */
export function render(lanes, roles) {
  return [
    md(
      [
        "lane",
        "n",
        "wall p50 s",
        "wall p95 s",
        "preview_ready p50 s",
        "preview_ready p95 s",
        "QE1 baseline p50 s",
        "cost n",
        "cost p50 $",
        "cost p95 $",
        "photo builds",
        "images p50",
        "image cost p50 $",
      ],
      lanes.map((r) => [
        r.lane,
        r.n,
        fmt(r.wallP50),
        fmt(r.wallP95),
        fmt(r.readyP50),
        fmt(r.readyP95),
        fmt(r.baselineP50),
        r.costN,
        fmt(r.costP50, 4),
        fmt(r.costP95, 4),
        r.imagesN,
        fmt(r.imagesP50, 0),
        fmt(r.imageCostP50, 3),
      ])
    ),
    "",
    md(
      ["role", "turns", "prompt tokens", "cache read", "cache-read ratio"],
      roles.map((r) => [
        r.role,
        r.turns,
        r.promptTokens,
        r.cacheRead,
        r.ratio === null ? "n/a" : `${(r.ratio * 100).toFixed(1)}%`,
      ])
    ),
  ].join("\n")
}
