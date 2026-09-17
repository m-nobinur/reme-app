import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { loadSession } from "../replay.mjs"

/**
 * Tier 1: no credential reaches the log a model request writes (§28.3). The
 * `turn_request` event is the one that could carry a key, in a header or in
 * the prompt body, so every recorded one is read: it must hold the request's
 * summary and not its input, and nothing in any recorded event may look like
 * a key, a bearer or a connection string. The shapes are this file's own,
 * not the redactor's, so a redactor that stops matching is caught here.
 */

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url))

const KEY_SHAPES = [
  ["an API key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["a connection string", /\bpostgres(ql)?:\/\/[^\s"']+@/],
  ["an auth header", /"(authorization|x-api-key|api[-_]key)"\s*:/i],
]

/** What in one recorded session's requests or events looks like a credential. */
export function credentialFindings(session) {
  const found = []
  const requests = session.events.filter(
    (e) => e.type === "runtime.turn_request"
  )
  if (requests.length === 0) {
    found.push({ seq: null, what: "no turn_request was recorded" })
  }
  for (const r of requests) {
    if (r.payload.request?.input !== undefined) {
      found.push({ seq: r.seq, what: "a turn_request kept its input" })
    }
    if (r.payload.request?.input_summary === undefined) {
      found.push({ seq: r.seq, what: "a turn_request has no input summary" })
    }
  }
  for (const e of session.events) {
    const text = JSON.stringify(e)
    for (const [what, shape] of KEY_SHAPES) {
      if (shape.test(text))
        found.push({ seq: e.seq, what: `${what} in ${e.type}` })
    }
  }
  return found
}

export default async function developerCredentials() {
  const names = readdirSync(fixtures).filter(
    (n) => n.startsWith("developer-") && n.endsWith(".jsonl")
  )
  let sessions = 0
  let requests = 0
  const found = []
  for (const name of names) {
    const session = loadSession(`${fixtures}${name}`)
    if (!session) continue
    sessions += 1
    requests += session.events.filter(
      (e) => e.type === "runtime.turn_request"
    ).length
    for (const f of credentialFindings(session))
      found.push({ session: name, ...f })
  }
  if (sessions === 0) throw new Error("no Developer session to read")
  console.log(
    `      credential findings ${found.length} over ${sessions} sessions, ${requests} model requests`
  )
  if (found.length > 0) {
    throw new Error(
      `${found.length} credential finding(s); the first is ${found[0].what} at seq ${found[0].seq} in ${found[0].session}`
    )
  }
}
