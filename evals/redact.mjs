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

/** Words that have no business in a fixture, whatever surrounds them. */
const FORBIDDEN =
  /@|\buser_|\borg_|\.workers\.dev|staging|remeai|wos-session|bearer|sk-or-|qa-e2e|QA probe/i

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
 * Everything in a serialised fixture that should not be there: any of
 * `secrets` (the run's owner email, org name and api host), a forbidden
 * word, an id or host the redaction missed, or a chunk of a type the api
 * should never stream to the owner.
 */
export function fixtureLeaks(serialised, secrets = []) {
  const found = []
  for (const secret of secrets) {
    if (secret && serialised.toLowerCase().includes(secret.toLowerCase()))
      found.push("a value of the run's own owner, org or host")
  }
  const word = FORBIDDEN.exec(serialised)
  if (word) found.push(`"${word[0]}"`)
  for (const [kind, shape] of SHAPES) {
    if (serialised.match(shape)) found.push(`an unredacted ${kind}`)
  }
  for (const line of serialised.trimEnd().split("\n").slice(1)) {
    const type = JSON.parse(line).chunk?.type
    if (!CHUNK_TYPES.has(type)) found.push(`a ${type} chunk`)
  }
  return [...new Set(found)]
}
