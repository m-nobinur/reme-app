import { voiceProblems } from "../../apps/api/src/voice.ts"

/**
 * The style patterns the onboarding planner no longer refuses, measured on
 * its replies so the eval shows how often each one reaches the owner. Self
 * contained, so the same counters run against an older planner.
 */

export const PATTERNS = [
  "bold question",
  "noted opener",
  "echo",
  "partial list",
  "read-back",
  "sign-off",
  "outcome",
]

const wordsOf = (said) => said.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

const COMMON = new Set(
  "that this they them their there then than what when where which whether with within would could should want wants like just also some more most much very have from into about your only each every other over once here been were will does done make made need needs sure okay yeah roughly usually mostly maybe really thing things stuff noted understood sorted covered included added changed updated".split(
    " "
  )
)

const stem = (word) => word.replace(/ies$/, "y").replace(/(?<!s)s$/, "")

const contentWords = (words) =>
  wordsOf(words)
    .filter((w) => w.length >= 4 && !COMMON.has(w))
    .map(stem)

/** Say as the owner reads it: no emphasis markers, a run of bullets as one sentence. */
function plain(say) {
  const bullet = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/
  const lines = say.split("\n")
  return lines
    .map((line, i) =>
      i > 0 && bullet.test(line) && bullet.test(lines[i - 1])
        ? `, ${line.replace(bullet, "")}`
        : `${i > 0 ? "\n" : ""}${line.replace(bullet, "")}`
    )
    .join("")
    .replace(/\*\*|__|(?<![\p{L}\p{N}])[*_]|[*_](?![\p{L}\p{N}])/gu, "")
}

const SENTENCE = /(?<=[.!?])\s+|\s*\n\s*/
const BOLD_SENTENCE = /(?<=[.!?](?:\*\*)?)\s+|\s*\n\s*/

export const opensNoted = (say) =>
  /^[^.?!\n]*\bnoted(?=[,.!])/i.test(plain(say).trim())

const boldQuestion = (say) =>
  say
    .split(BOLD_SENTENCE)
    .some((s) => s.includes("**") && /\?(?:\*\*)?$/.test(s.trim()))

const ECHO_WORDS = 6

function echoes(say, typed) {
  const owner = wordsOf(typed)
  const runs = new Set()
  for (let i = 0; i + ECHO_WORDS <= owner.length; i++)
    runs.add(owner.slice(i, i + ECHO_WORDS).join(" "))
  const mine = wordsOf(say)
  for (let i = 0; i + ECHO_WORDS <= mine.length; i++)
    if (runs.has(mine.slice(i, i + ECHO_WORDS).join(" "))) return true
  return false
}

const itemOf = (part) =>
  part
    .trim()
    .replace(/^.*?\b(?:are|is|include|includes|including|such as)\s+/i, "")
    .replace(/^(?:(?:so|plus|and|or|also|mainly|mostly|the)\s+)+/i, "")
    .replace(/[.!?]+$/, "")

const SPEAKER = /^(?:we|i|we're|i'm|we've|i've|our|my|it's|they|you)\b/i

/** The owner's lists: three or more short items in a row at one sentence's commas. */
export function listsOf(typed) {
  return typed.split(/(?<=[.!?;])\s+|\n+/).flatMap((sentence) => {
    const parts = sentence.split(/,\s*/)
    const last = parts.pop() ?? ""
    const runs = [[]]
    for (const item of [...parts, ...last.split(/\s+(?:and|or)\s+/i)].map(
      itemOf
    )) {
      const size = wordsOf(item).length
      if (/^(?:no|not|nothing|never|none)\b/i.test(item)) continue
      if (size > 0 && size <= 5 && !SPEAKER.test(item)) runs.at(-1).push(item)
      else runs.push([])
    }
    return runs.filter((run) => run.length >= 3)
  })
}

function names(words, item, list) {
  const others = new Set(
    list.filter((each) => each !== item).flatMap(contentWords)
  )
  const own = contentWords(item)
  const only = own.filter((w) => !others.has(w))
  return only.length > 0
    ? only.some((w) => words.has(w))
    : own.length > 0 && own.every((w) => words.has(w))
}

const RANGE =
  /\bfrom\s+([^,;.!?]+?)\s+(?:right\s+)?(?:through\s+)?to\s+([^,;.!?]+)|([^,;.!?]+?)\s+(?:right\s+|all the way\s+)?through\s+to\s+([^,;.!?]+)/i

const rangeOf = (sentence) => {
  const m = sentence.match(RANGE)
  return m ? [m[1] ?? m[3] ?? "", m[2] ?? m[4] ?? ""] : []
}

function spans(sentence, list) {
  const [from, to] = rangeOf(sentence)
  return Boolean(
    from &&
      to &&
      names(new Set(contentWords(from)), list[0], list) &&
      names(new Set(contentWords(to)), list.at(-1), list)
  )
}

function partOfList(sentence, lists, owner) {
  const phrase = (part) =>
    wordsOf(part).length <= 5 && contentWords(part).some((w) => owner.has(w))
  const theirs = sentence.split(/,|\s(?:and|or)\s/i).filter(phrase)
  if (theirs.length + rangeOf(sentence).filter(phrase).length < 2) return false
  const words = new Set(contentWords(sentence))
  return lists.some((list) => {
    if (spans(sentence, list)) return false
    const named = list.filter((item) => names(words, item, list))
    return named.length > 0 && named.length < list.length
  })
}

const RANGE_FROM = 4

const OUTCOME =
  /\bI(?:'ll| will)\b[^.!?]*?,? so (?:that )?(?!you (?:have|know|can quote)\b)(?:you|they|their|it|its|customers|clients|the|every|each|nothing)\b[^.!?]*/i

const ASKS_REPLY =
  /\b(?:let me know|take a look|tell me (?:what|if|whether)|any changes|adjust anything|change anything)\b/i

const LEAD_IN = ["ask_details", "review_quote_form", "ask_design", "reopen"]

/** What the counters need of a planner turn: the owner's words, lists and services, and whether a card follows. */
export function styleContext(plan, s) {
  const output = s.input.kind === "card" ? s.input.output : null
  const typed =
    s.input.kind === "message"
      ? s.input.text
      : typeof output?.text === "string"
        ? output.text
        : ""
  const answering = s.input.kind === "card" ? s.input.card : s.pending
  const onBusiness =
    answering?.type === "tool-ask_open" &&
    !["quote.form", "recap"].includes(answering.input.about)
  const ownerText = [
    ...s.rows
      .filter((r) => r.role === "user")
      .flatMap((r) =>
        r.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
      ),
    typed,
    JSON.stringify(s.onboarding.facts),
  ].join("\n")
  return {
    typed,
    lists: typed && (onBusiness || !answering) ? listsOf(typed) : [],
    owner: new Set(wordsOf(ownerText).map(stem)),
    services: plan.facts["business.offerings"]?.items ?? [],
    leadIn:
      LEAD_IN.includes(plan.next.kind) ||
      (plan.next.kind === "ask_open" && plan.next.about === "recap"),
  }
}

/** The dropped patterns a reply holds, by name from `PATTERNS`. */
export function styleHits(say, context) {
  const read = plain(say)
  const notes = read
    .split(SENTENCE)
    .filter((sentence) => !sentence.trimEnd().endsWith("?"))
  const services = context.services ?? []
  const hits = {
    "bold question": boldQuestion(say),
    "noted opener": opensNoted(say),
    echo: Boolean(context.typed) && echoes(read, context.typed),
    "partial list": notes.some((sentence) =>
      partOfList(sentence, context.lists ?? [], context.owner ?? new Set())
    ),
    "read-back":
      services.length >= RANGE_FROM &&
      notes.some((sentence) =>
        services.every((item) =>
          names(new Set(contentWords(sentence)), item, services)
        )
      ),
    "sign-off":
      voiceProblems(say).soft.some((p) => p.includes("a sign-off")) ||
      (Boolean(context.leadIn) && ASKS_REPLY.test(read)),
    outcome: OUTCOME.test(read),
  }
  return PATTERNS.filter((name) => hits[name])
}
