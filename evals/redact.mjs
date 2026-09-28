import { deriveContext } from "./replay.mjs"

/**
 * What must never reach a committed CoS fixture, or the owner's screen: ids,
 * hosts, URLs, emails and credentials. `record.mjs` redacts with these
 * shapes and then refuses to write if `fixtureLeaks` finds anything left;
 * tier 1 runs the same scan over the committed file, and `cos-cases.mjs`
 * fails a reply that shows the owner any of them.
 */

/** Each redacted value becomes this prefix plus its kind and a counter. */
export const MARK = "REDACTED"

/**
 * The shapes, in the order they are redacted. A ULID is matched with any
 * `word_` prefix, which is how WorkOS writes its ids (`user_01...`), and in
 * either case.
 */
export const SHAPES = [
  ["url", /\bhttps?:\/\/[^\s"'<>)]+/gi],
  ["email", /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi],
  ["host", /\b(?:[a-z0-9-]+\.)+(?:remeai\.co\.uk|workers\.dev)\b/gi],
  [
    "uuid",
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  ],
  ["ulid", /(?<![0-9a-z])(?:[a-z]+_)?[0-9a-hjkmnp-tv-z]{26}(?![0-9a-z])/gi],
]

/**
 * What has no business in a fixture. An "@" is caught by the email shape, a
 * bearer only with a token after it, and "staging" only as part of a host.
 */
const FORBIDDEN =
  /\buser_|\borg_|\.workers\.dev|\bstaging[\w-]*\.[a-z0-9-]+\.|remeai|wos-session|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|sk-or-|qa-e2e|QA probe/i

/** The chunk types a recorded turn may hold: what the api streams to the owner. */
export const CHUNK_TYPES = new Set([
  "finish",
  "finish-step",
  "start",
  "start-step",
  "text-delta",
  "text-end",
  "text-start",
  "tool-approval-request",
  "tool-approval-response",
  "tool-input-available",
  "tool-input-delta",
  "tool-input-start",
  "tool-output-available",
  "tool-output-denied",
])

/**
 * Consecutive deltas of one part merged into one chunk, so a value the
 * stream split across chunks is whole when it is redacted. The fold reads
 * the same text either way.
 */
export function mergeDeltas(chunks) {
  const out = []
  for (const chunk of chunks) {
    const last = out.at(-1)
    if (
      chunk.type === "text-delta" &&
      last?.type === "text-delta" &&
      last.id === chunk.id
    ) {
      out[out.length - 1] = { ...last, delta: last.delta + chunk.delta }
    } else if (
      chunk.type === "tool-input-delta" &&
      last?.type === "tool-input-delta" &&
      last.toolCallId === chunk.toolCallId
    ) {
      out[out.length - 1] = {
        ...last,
        inputTextDelta: last.inputTextDelta + chunk.inputTextDelta,
      }
    } else out.push(chunk)
  }
  return out
}

/**
 * Each turn's text as a reader joins it: every part the fold yields, and
 * every tool call's streamed input, so a value split across chunks that
 * were not merged is still read whole.
 */
function joinedTexts(lines) {
  const byTurn = new Map()
  for (const { turn, chunk } of lines) {
    if (!byTurn.has(turn)) byTurn.set(turn, [])
    byTurn.get(turn).push(chunk)
  }
  const texts = []
  for (const chunks of byTurn.values()) {
    for (const part of deriveContext(chunks).parts) {
      texts.push(part.text ?? JSON.stringify(part))
    }
    const inputs = new Map()
    for (const c of chunks.filter((k) => k.type === "tool-input-delta")) {
      inputs.set(
        c.toolCallId,
        (inputs.get(c.toolCallId) ?? "") + c.inputTextDelta
      )
    }
    texts.push(...inputs.values())
  }
  return texts
}

/**
 * Everything in a serialised fixture that should not be there: any of
 * `secrets` (the run's owner email, org name and api host), a forbidden
 * word, an id or host the redaction missed, or a chunk of a type the api
 * should never stream to the owner. The file is read as written and as
 * each part's joined text.
 */
export function fixtureLeaks(serialised, secrets = []) {
  const found = []
  const lines = serialised
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line))
  for (const { chunk } of lines) {
    if (!CHUNK_TYPES.has(chunk?.type)) found.push(`a ${chunk?.type} chunk`)
  }
  for (const text of [serialised, ...joinedTexts(lines)]) {
    for (const secret of secrets) {
      if (secret && text.toLowerCase().includes(secret.toLowerCase()))
        found.push("a value of the run's own owner, org or host")
    }
    const word = FORBIDDEN.exec(text)
    if (word) found.push(`"${word[0]}"`)
    for (const [kind, shape] of SHAPES) {
      if (text.match(shape)) found.push(`an unredacted ${kind}`)
    }
  }
  return [...new Set(found)]
}
