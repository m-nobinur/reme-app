import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { contentFindings, parsePage } from "@workspace/gates"
import { loadSession } from "../replay.mjs"

/**
 * Tier 1 (§16.3): fabrication count, from the model's own hands. Over every
 * recorded Developer session, the text every `edit` and `write` put into
 * the site is read for the claims the content gate reads (prices, phones,
 * emails, times, postcodes) and each is traced to the facts the session was
 * briefed with, taken from the logged context segment the model was shown.
 * A claim no fact supports is a fabrication, and the count must be zero.
 * The gate on the built artifact is the rule (§8.5); this is the same check
 * at the source, so a session that invented a value and then fixed it still
 * counts, which is what an eval is for.
 */

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url))

/** The facts the model was shown, parsed from the stable segment it was logged with. */
function briefedFacts(session) {
  const segment = session.events.find(
    (e) => e.type === "runtime.context_segment"
  )
  if (!segment) throw new Error(`${session.fixture} logged no context segment`)
  const text = String(segment.payload.instructions ?? "")
  const start = text.indexOf("Canonical facts (snapshot")
  if (start === -1) throw new Error(`${session.fixture} lists no facts`)
  const block = text.slice(text.indexOf("\n", start) + 1).split("\n\n")[0]
  const facts = []
  for (const line of block.split("\n")) {
    const m = /^- (\S+) \((\w+)\): (.*)$/.exec(line)
    if (!m) continue
    facts.push({
      key: m[1],
      fact_type: m[2],
      value: JSON.parse(m[3]),
      provenance: { source: "owner_stated" },
    })
  }
  return facts
}

/** Every piece of text an `edit` or `write` put into a file, with where. */
function writtenText(session) {
  const out = []
  for (const turn of session.events.filter(
    (e) => e.type === "runtime.turn_messages"
  )) {
    for (const call of (turn.payload.message?.content ?? []).filter(
      (c) => c.type === "toolCall"
    )) {
      const path = String(call.arguments?.path ?? "").replace(
        /^\/workspace\/site\//,
        ""
      )
      if (
        call.name === "write" &&
        typeof call.arguments?.content === "string"
      ) {
        out.push({ path, text: call.arguments.content })
      }
      if (call.name === "edit") {
        for (const edit of call.arguments?.edits ?? []) {
          if (typeof edit?.newText === "string")
            out.push({ path, text: edit.newText })
        }
      }
    }
  }
  return out
}

/** Claims in the written text that no briefed fact supports. */
export function fabrications(session) {
  const facts = briefedFacts(session)
  return writtenText(session).flatMap(({ path, text }) =>
    contentFindings([parsePage(path, text)], facts).map((f) => ({
      path,
      kind: f.kind,
      claim: f.claim,
    }))
  )
}

export default async function developerFacts() {
  const names = readdirSync(fixtures).filter(
    (n) => n.startsWith("developer-") && n.endsWith(".jsonl")
  )
  let sessions = 0
  let claims = 0
  const found = []
  for (const name of names) {
    const session = loadSession(`${fixtures}${name}`)
    if (!session) continue
    sessions += 1
    claims += writtenText(session).length
    for (const f of fabrications(session)) found.push({ session: name, ...f })
  }
  if (sessions === 0) throw new Error("no Developer session to read")
  console.log(
    `      fabrication count ${found.length} over ${sessions} sessions, ${claims} written texts`
  )
  if (found.length > 0) {
    throw new Error(
      `${found.length} claim(s) match no briefed fact; the first is "${found[0].claim}" (${found[0].kind}) in ${found[0].session} ${found[0].path}`
    )
  }
}
