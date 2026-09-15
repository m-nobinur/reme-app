import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { contextHash } from "@workspace/facade"

/**
 * `pnpm record:session <org> <assignment id> <fixture name>` freezes one
 * Developer session from the orchestrator's event log into
 * `fixtures/<name>.jsonl`, pinned to the hash `deriveContext` (§10.6) gives it.
 *
 * Only what a scenario reads is kept: the events the fold consumes, each tool
 * call with its result, and the two audit rows a scenario asserts on. Deltas
 * are dropped because the fold skips them and they are most of the bytes.
 * Reads ORCHESTRATOR_URL and ORCHESTRATOR_TOKEN like scripts/builder.mjs.
 */

const KEEP = new Set([
  "runtime.agent_start",
  "runtime.context_segment",
  "runtime.turn_messages",
  "runtime.compaction",
  "runtime.tool",
  "runtime.agent_end",
  "information.requested",
  "assignment.completion_reported",
])

const [org, assignmentId, name] = process.argv.slice(2)
if (!org || !assignmentId || !name) {
  console.error("usage: pnpm record:session <org> <assignment id> <name>")
  process.exit(2)
}
const base = (process.env.ORCHESTRATOR_URL ?? "http://localhost:3002").replace(
  /\/$/,
  ""
)
const res = await fetch(
  `${base}/assignments/${assignmentId}/events?org=${encodeURIComponent(org)}`,
  { headers: { authorization: `Bearer ${process.env.ORCHESTRATOR_TOKEN}` } }
)
if (!res.ok) {
  console.error(`${res.status} from ${base}`)
  process.exit(1)
}
const { events } = await res.json()
const kept = events.filter((e) => KEEP.has(e.type))
const header = {
  fixture: name,
  kind: "session",
  assignment_id: assignmentId,
  hash: contextHash(kept),
}
const out = fileURLToPath(new URL(`./fixtures/${name}.jsonl`, import.meta.url))
writeFileSync(
  out,
  `${[header, ...kept].map((line) => JSON.stringify(line)).join("\n")}\n`
)
console.log(`${out}: ${kept.length} of ${events.length} events, ${header.hash}`)
