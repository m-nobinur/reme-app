import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { FACTS } from "./cos-cases.mjs"
import { fixtureLeaks, MARK, mergeDeltas, SHAPES } from "./redact.mjs"
import { replay } from "./replay.mjs"
import { liveRun } from "./tier-2/cos-live.eval.mjs"

/**
 * `pnpm record` runs the Chief of Staff cases on staging, as tier 2 does,
 * and freezes what the owner saw into `fixtures/cos-chat.jsonl` for tier 1
 * to score offline. It takes the same environment as tier 2, and each run
 * spends from the key (see `tier-2/cos-live.eval.mjs`).
 *
 * The recording is redacted before it is written: every tool call, approval,
 * message and part id becomes a counter in order of first appearance, and
 * every URL, email, staging host, UUID and ULID becomes `REDACTED-<kind>-<n>`,
 * which tier 1 fails if it ever shows up in a reply. Provider metadata is
 * dropped. Then it fails closed: nothing is written when the scan in
 * `redact.mjs` finds anything left, when the run stopped on its cap or did
 * not know its spend, or when any build started without the owner's yes.
 */

const OUT = fileURLToPath(new URL("./fixtures/cos-chat.jsonl", import.meta.url))

const ID_KEYS = {
  toolCallId: "call",
  approvalId: "approval",
  messageId: "message",
  id: "part",
}
const DROPPED = new Set(["providerMetadata", "messageMetadata"])
const TRANSIENT = new Set([
  "message-metadata",
  "data-onboarding_status",
  "data-memory",
])

function redactor() {
  const seen = new Map()
  const counts = new Map()
  const stand = (kind, value) => {
    const key = `${kind}:${value.toLowerCase()}`
    if (!seen.has(key)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      seen.set(key, `${kind}-${counts.get(kind)}`)
    }
    return seen.get(key)
  }
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (ID_KEYS[key]) return stand(ID_KEYS[key], value)
      return SHAPES.reduce(
        (text, [kind, shape]) =>
          text.replace(shape, (m) => `${MARK}-${stand(kind, m)}`),
        value
      )
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

/** The fixture a run writes, or a throw naming why it must not be written. */
export function serialise(run) {
  const refused = [
    run.stopped,
    run.spentUsd === null && "the run's spend is unknown",
    run.builds !== 0 && `${run.builds ?? "unknown"} unapproved build(s)`,
  ].filter(Boolean)
  if (refused.length > 0)
    throw new Error(`nothing recorded: ${refused.join("; ")}`)
  const redact = redactor()
  const owner = {}
  const sessions = {}
  const lines = []
  for (const { name, turns } of run.cases) {
    sessions[name] = turns.map((turn, i) => {
      const id = `${name}.${i + 1}`
      const { mode, text, deny } = turn.owner
      owner[id] = { mode, text, deny, outcome: turn.outcome }
      const kept = turn.chunks.filter((c) => !TRANSIENT.has(c.type))
      for (const chunk of mergeDeltas(kept)) {
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
  const text = `${[{ ...header, hash }, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`
  const leaks = fixtureLeaks(text, run.secrets)
  if (leaks.length > 0)
    throw new Error(`nothing recorded, the fixture holds ${leaks.join(", ")}`)
  return { text, hash, chunks: lines.length }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = await liveRun()
  const { text, hash, chunks } = serialise(run)
  writeFileSync(OUT, text)
  console.log(`recorded ${OUT}`)
  console.log(`  ${run.cases.length} cases, ${chunks} chunks, ${hash}`)
  console.log(
    `  key usage moved $${run.spentUsd.toFixed(4)}, builds ${run.builds}`
  )
}
