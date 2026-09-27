import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { FACTS } from "./cos-cases.mjs"
import { replay } from "./replay.mjs"
import { liveRun } from "./tier-2/cos-live.eval.mjs"

/**
 * `pnpm record` runs the Chief of Staff cases on staging, as tier 2 does,
 * and freezes what the owner saw into `fixtures/cos-chat.jsonl` for tier 1
 * to score offline. It takes the same environment as tier 2.
 *
 * The recording is redacted before it is written: every tool call, approval,
 * message and part id becomes a counter in order of first appearance, every
 * UUID and ULID in a value becomes a placeholder, staging host names go, and
 * provider metadata is dropped. What stays is what a scenario reads: the
 * text, and each tool call with its input, approval and output.
 */

const OUT = fileURLToPath(new URL("./fixtures/cos-chat.jsonl", import.meta.url))

const ID_KEYS = {
  toolCallId: "call",
  approvalId: "approval",
  messageId: "message",
  id: "part",
}
const DROPPED = new Set(["providerMetadata", "messageMetadata"])
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g
const HOST = /\b[a-z0-9-]+\.remeai\.co\.uk\b/gi

function redactor() {
  const seen = new Map()
  const counts = new Map()
  const stand = (kind, value) => {
    const key = `${kind}:${value}`
    if (!seen.has(key)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      seen.set(key, `${kind}-${counts.get(kind)}`)
    }
    return seen.get(key)
  }
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (ID_KEYS[key]) return stand(ID_KEYS[key], value)
      return value
        .replace(UUID, (m) => stand("uuid", m.toLowerCase()))
        .replace(ULID, (m) => stand("ulid", m))
        .replace(HOST, "host.invalid")
    }
    if (Array.isArray(value)) return value.map((v) => walk(v))
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !DROPPED.has(k))
          .map(([k, v]) => [k, walk(v, k)])
      )
    }
    return value
  }
  return walk
}

const run = await liveRun()
const redact = redactor()
const owner = {}
const sessions = {}
const lines = []
for (const { name, turns } of run.cases) {
  sessions[name] = turns.map((turn, i) => {
    const id = `${name}.${i + 1}`
    const { mode, text, deny } = turn.owner
    owner[id] = { mode, text, deny, outcome: turn.outcome }
    for (const chunk of turn.chunks) {
      lines.push({ turn: id, chunk: redact(chunk) })
    }
    return id
  })
}

const turns = Object.values(sessions).flat()
const header = { fixture: "cos-chat", facts: FACTS, owner, turns, sessions }
const byTurn = new Map(turns.map((t) => [t, []]))
for (const { turn, chunk } of lines) byTurn.get(turn).push(chunk)
const hash = replay({ ...header, turns: byTurn })

writeFileSync(
  OUT,
  `${[{ ...header, hash }, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`
)
console.log(`recorded ${OUT}`)
console.log(`  ${run.cases.length} cases, ${lines.length} chunks, ${hash}`)
console.log(
  `  key usage moved $${run.spentUsd?.toFixed(4) ?? "unknown"}, builds ${run.builds}`
)
