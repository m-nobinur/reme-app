// Pure helpers for evals/relace.mjs: the diff, the scoring and the input checks.

const lines = (text) => (text === "" ? [] : text.split("\n"))

/**
 * Changed lines between two texts as `-old` / `+new` entries, in file order.
 * Common head and tail are trimmed, then a line LCS runs on the middle.
 * shortcut: O(n*m) on the middle, fine for one edited file of a few thousand lines.
 */
export function diffLines(before, after) {
  const a = lines(before)
  const b = lines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const w = y.length + 1
  const lcs = new Uint32Array((x.length + 1) * w)
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i * w + j] =
        x[i] === y[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
  const out = []
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++
      j++
    } else if (
      j >= y.length ||
      (i < x.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])
    ) {
      out.push(`-${x[i++]}`)
    } else {
      out.push(`+${y[j++]}`)
    }
  }
  return out
}

/**
 * Score one result against the original. `changed` is every line the result
 * touched. With `expected`, `unrequested` is what the result touched beyond what
 * the expected file touched (multiset, so a doubled line counts); `missed` is
 * what was requested and not done. Without it both are null: nothing to judge by.
 */
export function score(original, result, expected) {
  const got = diffLines(original, result)
  if (expected === undefined)
    return { changed: got.length, unrequested: null, missed: null }
  const left = new Map()
  for (const d of diffLines(original, expected))
    left.set(d, (left.get(d) ?? 0) + 1)
  let unrequested = 0
  for (const d of got) {
    const n = left.get(d) ?? 0
    if (n > 0) left.set(d, n - 1)
    else unrequested++
  }
  const missed = [...left.values()].reduce((s, n) => s + n, 0)
  return { changed: got.length, unrequested, missed }
}

/** One JSONL line to a record, or the reason it is not one. */
export function parseRecords(text) {
  const records = []
  const problems = []
  text.split("\n").forEach((raw, n) => {
    if (raw.trim() === "") return
    let r
    try {
      r = JSON.parse(raw)
    } catch {
      problems.push(`line ${n + 1}: not JSON`)
      return
    }
    for (const k of ["path", "original", "instruction"]) {
      if (typeof r[k] !== "string" || r[k] === "")
        problems.push(`line ${n + 1}: ${k} must be a non-empty string`)
    }
    if (r.expected !== undefined && typeof r.expected !== "string")
      problems.push(`line ${n + 1}: expected must be a string when present`)
    records.push(r)
  })
  if (records.length === 0) problems.push("no records")
  return { records, problems }
}

/** The JSON object a model wrote, with or without a code fence around it. */
export function parseEditsJson(text) {
  const body = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")
  const parsed = JSON.parse(
    body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)
  )
  const edits = parsed.edits
  if (
    !Array.isArray(edits) ||
    edits.length === 0 ||
    edits.some(
      (e) => typeof e?.oldText !== "string" || typeof e?.newText !== "string"
    )
  )
    throw new Error("reply has no edits[{oldText,newText}]")
  return edits
}

/** Relace's input: one user message of three tags. */
export const relacePrompt = (instruction, code, update) =>
  `<instruction>${instruction}</instruction>\n<code>${code}</code>\n<update>${update}</update>`

/** Strip a code fence a model may wrap a whole file or snippet in. */
export const unfence = (text) =>
  text.replace(/^\s*```[\w-]*\n/, "").replace(/\n```\s*$/, "")

const median = (xs) => {
  const s = [...xs].sort((p, q) => p - q)
  return s.length === 0
    ? null
    : s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** Per-path summary of rows `{path, ok, ms, cost, unrequested, missed}`. */
export function summarise(rows) {
  const by = new Map()
  for (const r of rows) by.set(r.path, [...(by.get(r.path) ?? []), r])
  return [...by].map(([path, rs]) => ({
    path,
    n: rs.length,
    applied: rs.filter((r) => r.ok).length,
    medianMs: median(rs.map((r) => r.ms)),
    unrequested: rs.reduce((s, r) => s + (r.unrequested ?? 0), 0),
    missed: rs.reduce((s, r) => s + (r.missed ?? 0), 0),
    cost: rs.reduce((s, r) => s + (r.cost ?? 0), 0),
  }))
}

export function table(summary) {
  const head = [
    "path",
    "applied",
    "median ms",
    "unrequested lines",
    "missed lines",
    "cost $",
  ]
  const body = summary.map((s) => [
    s.path,
    `${s.applied}/${s.n}`,
    s.medianMs === null ? "-" : String(Math.round(s.medianMs)),
    String(s.unrequested),
    String(s.missed),
    s.cost.toFixed(5),
  ])
  const w = head.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i].length))
  )
  const row = (r) =>
    r
      .map((c, i) => c.padEnd(w[i]))
      .join("  ")
      .trimEnd()
  return [row(head), ...body.map(row)].join("\n")
}
