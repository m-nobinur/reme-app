/**
 * How the assistant sounds to the owner. Both the onboarding planner and the
 * Chief of Staff include `VOICE` in their instructions; how a reply reads is
 * the prompt's job, and no code refuses or rewrites one for its words.
 * `voiceProblems` is the evals' measure of the same voice.
 */

/** The voice both models' instructions include, each with its own notes after it. */
export const VOICE = `<voice>
You speak for the owner's own assistant, someone on their team. Sound like a capable person who knows this business: plain, warm and specific.
- Use the owner's own kind of words: "your website", not "your digital storefront". Write in British English.
- Use contractions in every tone. Keep to one exclamation mark at most, and none in a professional tone, so the rare one still means something.
- Punctuate with commas and full stops. A dash is fine where it genuinely reads better, such as an aside a comma would muddle, but most replies need none and one is plenty: a dash in every reply reads as machine-written.
- Give times in the 12-hour form with AM or PM, such as 8:00 AM or 2:30 PM, the way owners write them.
- Keep the product's plumbing out of sight. An id, a ref, a code, a version number, a field name or a tool's name means nothing to the owner, so describe the thing itself.
- Ceremony and filler make a reply longer without saying more: skip welcome speeches, thanks for choosing you, sign-offs, praise for their answers and stock phrases such as "feel free to", "let me know if", "don't hesitate to", "peace of mind", "certainly", "absolutely", "of course", "wonderful", "fantastic" or "amazing".
</voice>`

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
  [/[—–]/, "a dash"],
  [
    /\b(reporting for duty|partnership|officially|hono(u)?r|than(k you|ks) for (choosing|picking|trusting)|glad you (chose|picked)|digital storefront|peace of mind|wonderful|fantastic|amazing|certainly|lovely (mix|choice))\b/i,
    "ceremony or praise",
  ],
  [
    /(?<=^|[.!?]["'”’)]*\s+)(great question|absolutely|of course|sure thing)\b|\bI(?:'d| would) be happy to\b/i,
    "a chatbot opener",
  ],
  [
    /\b(let me know (if|whether)|feel free to|don't hesitate to|i hope this helps)\b/i,
    "a sign-off",
  ],
  [/\bas your (business )?assistant\b/i, '"as your assistant"'],
  [
    /\b(will|would|should|'ll) give (your |their )?(customers|clients|people|riders|visitors)\b|\b(plenty of|real|extra) (confidence|reassurance)\b|(?<=^|[.!?]["'”’)]*\s+)(that|this|it) makes (good |a lot of |total )?sense\b|\b(great|nice|good|smart|excellent) (choice|call|idea|touch|detail|point)\b|\b(will|'ll) take (a lot|loads|plenty|a load) off your (hands|plate)\b/i,
    "praise for the owner's answer",
  ],
]

export type VoiceProblems = {
  /** A fault in any reply: a piece of the product's plumbing. */
  hard: string[]
  /** A slip in style, which the prompt guards against and the evals count. */
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
