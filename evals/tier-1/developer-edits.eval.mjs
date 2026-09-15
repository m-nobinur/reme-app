import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { loadSession } from "../replay.mjs"

/**
 * Tier 1 (§16.3): how the Developer edits. Over every recorded Developer
 * session: a starter file is changed with `edit`, never rewritten with
 * `write`; every failed edit answers with Pi's anchor message and is
 * recovered by one retry: the next edit of that file succeeds, within two
 * turns, because a model that never saw the file needs one turn to read it.
 * The recovery session plants the failure: its goal makes the first call an
 * edit, before any read, quoting an anchor with single quotes where the file
 * has double quotes, which the edit does not forgive.
 */

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url))

/** The files the starter seeds, as the Developer sees them. */
const STARTER = new Set([
  "astro.config.mjs",
  "package.json",
  "README.md",
  "tsconfig.json",
  "src/site-config.ts",
  "src/layouts/Base.astro",
  "src/pages/index.astro",
  "src/pages/contact.astro",
])

const relative = (path) =>
  String(path ?? "").replace(/^\/workspace\/site\//, "")

/** Tool calls with their arguments and results, in the order the log holds them. */
function calls(events) {
  const turns = events
    .filter((e) => e.type === "runtime.turn_messages")
    .sort((a, b) => a.seq - b.seq)
  const out = []
  turns.forEach((turn, index) => {
    const requested = (turn.payload.message?.content ?? []).filter(
      (c) => c.type === "toolCall"
    )
    const results = turn.payload.toolResults ?? []
    for (const call of requested) {
      const result = results.find((r) => r.toolCallId === call.id)
      out.push({
        turn: index,
        name: call.name,
        path: relative(call.arguments?.path),
        isError: Boolean(result?.isError),
        text: (result?.content ?? []).map((c) => c.text ?? "").join(""),
      })
    }
  })
  return out
}

export default async function developerEdits() {
  const names = readdirSync(fixtures).filter(
    (n) => n.startsWith("developer-") && n.endsWith(".jsonl")
  )
  let recovered = 0
  for (const name of names) {
    const session = loadSession(`${fixtures}${name}`)
    if (!session) continue
    const all = calls(session.events)
    for (const c of all) {
      if (c.name === "write" && STARTER.has(c.path)) {
        throw new Error(
          `${name}: ${c.path} was rewritten with write in turn ${c.turn}`
        )
      }
    }
    for (const failed of all.filter((c) => c.name === "edit" && c.isError)) {
      if (!/Could not find|Found \d+ occurrences/.test(failed.text)) {
        throw new Error(
          `${name}: a failed edit said "${failed.text.slice(0, 120)}"`
        )
      }
      const next = all.find(
        (c) =>
          c.name === "edit" &&
          c.path === failed.path &&
          all.indexOf(c) > all.indexOf(failed)
      )
      if (!next || next.isError || next.turn > failed.turn + 2) {
        throw new Error(
          `${name}: the failed edit of ${failed.path} in turn ${failed.turn} was not recovered by one retry within two turns`
        )
      }
      recovered++
    }
  }
  const planted = loadSession(`${fixtures}developer-edit-recovery.jsonl`)
  if (!planted)
    throw new Error("developer-edit-recovery is not a session fixture")
  if (!calls(planted.events).some((c) => c.name === "edit" && c.isError)) {
    throw new Error(
      "developer-edit-recovery holds no failed edit to recover from"
    )
  }
  if (recovered === 0)
    throw new Error("no failed edit was recovered in any session")
}
