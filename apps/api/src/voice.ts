/**
 * How the assistant sounds to the owner, and the code check that holds the
 * model to it. The onboarding planner reads `VOICE` in its instructions and
 * retries on any `voiceProblems` hit; the Chief of Staff streams, so it
 * cannot retry and uses the same check to swap dashes and to log the rest.
 */

/** The rules both models' instructions include. */
export const VOICE = `How you sound, wherever you speak to the owner:
- Lead with the answer, or with what happened. After an action, one or two sentences in the past tense with the result.
- Never repeat the owner's words back, never grade their answers, and keep ceremony out: no welcome speeches, no thanks for choosing you, no sign-offs.
- Never restate what a card shows. Point to it in one short sentence, or say nothing.
- Plain words: "your website", not "your digital storefront". British English. Contractions, unless the tone is professional. At most one exclamation mark, and none when the tone is professional.
- Write hosts and names plain, with no quote marks. No headings or lists in a short reply.
- Never say an id, a ref, a code, a version number or a tool's name.`

/** What the owner must never read: the product's own plumbing. */
const INTERNALS: readonly [RegExp, string][] = [
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    "an id",
  ],
  // A run of seven or more hex characters with a digit and a letter in it,
  // so a hash is caught and "defaced" or a phone number is not.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/i, "a hash"],
  [/\b[a-z]+(?:_[a-z0-9]+)+\b/, "a snake_case value"],
  [/\b[A-Z]{3}-\d{3}\b/, "a staff code"],
]

/** Ceremony, praise, chatbot openers and sign-offs: a hit is a style miss, not a fault. */
const SOFT: readonly [RegExp, string][] = [
  [
    /\b(reporting for duty|partnership|hono(u)?r|thank you for choosing|thanks for choosing|digital storefront|peace of mind|wonderful|fantastic|amazing|certainly|lovely (mix|choice))\b/i,
    "ceremony or praise",
  ],
  [
    /(?<=^|[.!?]["'”’)]*\s+)(great question|absolutely|of course|sure thing)\b|\bI(?:'d| would) be happy to\b/i,
    "a chatbot opener",
  ],
  [
    /\b(let me know if you (need|have|want)|feel free to|don't hesitate to|i hope this helps)\b/i,
    "a sign-off",
  ],
  [/\bas your (business )?assistant\b/i, '"as your assistant"'],
]

export type VoiceProblems = {
  /** A fault in any reply: a dash, or a piece of the product's plumbing. */
  hard: string[]
  /** A slip in style, which the planner retries on and the Chief of Staff logs. */
  soft: string[]
}

/**
 * Checks a reply to the owner. `assistantNamed` is true once the owner has
 * named their assistant: the product's own name is then an internal too.
 * Every check is a phrase or a pattern, so a start of a message that passes
 * still passes inside the whole message.
 */
export function voiceProblems(
  text: string,
  { assistantNamed = false }: { assistantNamed?: boolean } = {}
): VoiceProblems {
  const hard: string[] = []
  if (/[—–]/.test(text)) hard.push("Use a comma or a full stop, never a dash.")
  for (const [pattern, what] of INTERNALS) {
    const found = text.match(pattern)?.[0]
    if (found)
      hard.push(`Leave out ${what} ("${found}"); say it in plain words.`)
  }
  if (assistantNamed && /\bReme\b/.test(text)) {
    hard.push("Never say Reme; the owner named their assistant.")
  }
  const soft = SOFT.flatMap(([pattern, what]) => {
    const found = text.match(pattern)?.[0].trim()
    return found ? [`Leave out ${what} ("${found}").`] : []
  })
  return { hard, soft }
}
