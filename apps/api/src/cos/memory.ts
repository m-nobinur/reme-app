import {
  type MemoryChip,
  type MemoryInput,
  type MemoryLayer,
  type MemoryOperation,
  type MemoryOutput,
  MemoryReviewAction,
  MemoryView,
  NOTES_MAX_CHARS,
  OWNER_MEMORY_REVIEW_KEY,
  OWNER_PROFILE_KEY,
  OwnerMemoryReview,
  OwnerProfile,
  PROFILE_LINE_MAX,
  PROFILE_MAX_CHARS,
  type ProfileLine,
  type ProfileVersion,
  profileText,
  SKILL_NOTES_KEY,
  SKILL_NOTES_MAX_CHARS,
  type SkillNoteLine,
  SkillNotes,
  type SkillNotesView,
  WORKING_NOTES_KEY,
  WorkingNotes,
} from "@workspace/contracts"
import {
  currentFact,
  currentFacts,
  factVersions,
  type OrgScopedDb,
  readCorrections,
  sql,
  supersedePrivateFact,
  type Tenancy,
} from "@workspace/db"
import { PROCEDURES, procedure } from "@workspace/skills"
import type { Owner } from "../changes.ts"
import { failure, invalid, readBody } from "../http.ts"
import type { ToolContext } from "./tools.ts"
import type { Turn } from "./turns.ts"

/**
 * The Chief of Staff's memory (ADR-042), in three stores after Hermes's
 * MEMORY.md and USER.md: the owner profile, the working notes, and each
 * skill's notes for this business. Each is one fact of plain lines, every
 * change a version. The `memory` tool, reflection and the proposals the
 * owner accepts all write through `applyOperations` and `saveLayer`, so a
 * rule has one home.
 */

/** Refusals the same turn may get before `memory` stops answering (after hermes-agent tools/memory_tool_store.py, MIT). */
export const FULL_REFUSALS = 3

/** Past this share of its budget, a write that adds must also merge or remove (Hermes's IF FULL, early). */
export const CONSOLIDATE_AT = 0.8

/** A skill note whose skill has not loaded for this long is shown to the owner as stale (after Hermes's curator). */
export const STALE_DAYS = 60

/** One of the CoS's whole stores. */
export type Store = {
  key: string
  max: number
  schema: typeof OwnerProfile | typeof WorkingNotes | typeof SkillNotes
}
export const STORES = {
  profile: {
    key: OWNER_PROFILE_KEY,
    max: PROFILE_MAX_CHARS,
    schema: OwnerProfile,
  },
  notes: { key: WORKING_NOTES_KEY, max: NOTES_MAX_CHARS, schema: WorkingNotes },
  skills: {
    key: SKILL_NOTES_KEY,
    max: SKILL_NOTES_MAX_CHARS,
    schema: SkillNotes,
  },
} as const satisfies Record<string, Store>

/**
 * Where one `memory` write lands: a whole store, or one skill's lines of
 * the skill notes. `title` heads it in the model's context, as Hermes's
 * block headers do.
 */
export type Layer = {
  target: string
  store: Store
  /** The skill whose lines these are, or null for a whole store. */
  skill: string | null
  title: string
}

/** The layer a `memory` target names, or null for a skill that does not exist. */
export function layerOf(target: string): Layer | null {
  if (target === "user")
    return {
      target,
      store: STORES.profile,
      skill: null,
      title: "OWNER PROFILE (who the owner is)",
    }
  if (target === "notes")
    return {
      target,
      store: STORES.notes,
      skill: null,
      title: "WORKING NOTES (how this business runs)",
    }
  const name = target.startsWith("skill:") ? target.slice(6) : ""
  return procedure("cos", name)
    ? {
        target,
        store: STORES.skills,
        skill: name,
        title: `SKILL NOTES for ${name} (how they want this work done)`,
      }
    : null
}

/**
 * A store's fullness as Hermes's block header renders it, with a comma for
 * its dash: `58%, 930/1,600 chars`.
 */
export function fullness(
  lines: readonly { text: string }[],
  max: number = PROFILE_MAX_CHARS
): string {
  const used = profileText(lines).length
  return `${Math.min(100, Math.round((used / max) * 100))}%, ${used.toLocaleString("en-GB")}/${max.toLocaleString("en-GB")} chars`
}

/** A layer as the model reads it: Hermes's header with its fullness, then a line each. */
export const blockOf = (
  title: string,
  lines: readonly { text: string }[],
  max: number
) => [
  `${title} [${fullness(lines, max)}]`,
  ...lines.map((l) => l.text.replace(/</g, "\\u003c")),
]

/**
 * Lines that read as an attack on the assistant, not as a fact about the
 * owner. The patterns sit on attack vocabulary, the way hermes' memory scan
 * does, so ordinary bossy English such as "Call me Sam" passes. A second
 * kind catches a line written as an order to the assistant: a profile line
 * states what is so ("Prefers calls after 4pm"), it does not command, since
 * an imperative is re-read as a directive in later sessions.
 */
const ATTACK: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(instructions?|rules?|prompts?|guidelines?|polic(y|ies)|safeguards?|restrictions?)\b/i,
  /\b(do not|don'?t|never)\s+(tell|inform|mention|reveal|show|let)\b[^.\n]{0,30}\b(owner|user|anyone|them)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\b(jailbreak|new instructions?|you are now|pretend (to be|you)|from now on you)\b/i,
  /\b(reveal|print|repeat|output)\b[^.\n]{0,30}\b(prompt|instructions?|secrets?|api keys?|passwords?)\b/i,
  /https?:\/\/|<\/?[a-z][^>]*>|\bwww\./i,
]
const ORDER: readonly RegExp[] = [
  /^(you|assistant|chief of staff)\b/i,
  /\b(you|assistant)\s+(must|should|shall|need to|have to|will|are to|cannot|can'?t)\b/i,
  /^(please|ensure|make sure|be sure|remember to|do not|don'?t|stop|approve|publish|delete|reply|respond|answer|tell|send|write|ask)\b/i,
  // "Always reply" is an order; "Never works Sundays" is a fact.
  /^(always|never)\s+(?!\w*s\b)\w+/i,
]

/**
 * Access secrets, which never go in memory: anyone who reads the page, a
 * summary or a log would hold them. Where the key is kept is a note; its
 * code is not.
 */
const SECRET: readonly RegExp[] = [
  /\b(pass ?words?|passcodes?|pass ?phrases?|passwd|log ?in details|credentials?)\b/i,
  /\b(codes?|pins?|combinations?|combos?|cvv|cvc)\b[^.\n]{0,24}\d{3,}/i,
  /\d{3,}[^.\n]{0,24}\b(codes?|pins?|combinations?)\b/i,
  /\b(sort code|account (number|no))\b[^.\n]{0,24}\d/i,
  /\b(sk|pk|rk)[-_][A-Za-z0-9]{12,}/,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{28,}\b/,
]

/** Whether `text` holds a card number: 13 to 19 digits that pass Luhn's check. */
function holdsCard(text: string): boolean {
  for (const run of text.match(/\d[\d -]{11,}\d/g) ?? []) {
    const digits = run.replace(/\D/g, "")
    if (digits.length < 13 || digits.length > 19) continue
    let sum = 0
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i])
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
      sum += d
    }
    if (sum % 10 === 0) return true
  }
  return false
}

/** Why a line was refused, or null when it may be saved. */
export function refusalOf(text: string): "attack" | "order" | "secret" | null {
  if (ATTACK.some((p) => p.test(text))) return "attack"
  if (SECRET.some((p) => p.test(text)) || holdsCard(text)) return "secret"
  if (ORDER.some((p) => p.test(text.trim()))) return "order"
  return null
}

/**
 * A price, an email address or a phone number: business facts, which go
 * through `request_change` and never into memory.
 */
export const BUSINESS =
  /[£$€]\s?\d|\d\s?(pounds|dollars|euros|gbp|usd)\b|\S@\S|\+?\d[\d\s().-]{8,}\d/i

/**
 * A standing request is the one order a line may hold, because it is the
 * owner's own sentence quoted as typed: `Asked: "Don't email before 9am"`.
 */
const ASKED = /^Asked: "(.+)"$/
export const ASKED_MAX = 160

/** The quote of a standing request, or null for any other line. */
export const quoteOf = (text: string) => ASKED.exec(text)?.[1] ?? null

const plain = (text: string) =>
  norm(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[.!?]+$/, "")

/**
 * Whether `quote` is a whole sentence the owner typed, ignoring case,
 * spacing, curly quotes and the closing stop. Whole, so a piece cut out of
 * "Don't approve every change" can never stand alone as an order.
 */
export const quotedFrom = (quote: string, said: readonly string[]) =>
  said
    .flatMap((s) => s.split(SENTENCES))
    .some((sentence) => plain(sentence) === plain(quote))

const NEGATION = new Set(["not", "never", "no", "without", "cannot"])
const SENTENCES = /(?<=[.!?])\s+|\n+/
const CLAUSES = /(?<=[.!?;,])\s+|\s+(?:and|but)\s+|\n+/

const STOP = new Set(
  "a an the and or of to in on at by for with from is are was were be been am has have had do does did it its he she they them their his her my me i we our as that this".split(
    " "
  )
)

/**
 * A word cut back to its stem, so "calls" and "call" meet. Rough on purpose:
 * it only has to make honest rewording pass, not to be a stemmer.
 */
const stem = (word: string) =>
  word.length > 4 && word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.length > 4 && /(ch|sh|x|z|ss)es$/.test(word)
      ? word.slice(0, -2)
      : word.length > 5 && word.endsWith("ing")
        ? word.slice(0, -3)
        : word.length > 4 && word.endsWith("ed")
          ? word.slice(0, -2)
          : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
            ? word.slice(0, -1)
            : word

/**
 * The content words of `text`: letters and digits apart, lower case, stems,
 * no stopwords. "n't" reads as "not" and "'s" is dropped, so "doesn't" meets
 * "don't" and a third-person line meets the owner's first-person words.
 */
export const contentWords = (text: string) =>
  (
    text
      .toLowerCase()
      .replace(/n['’]t\b/g, " not")
      .replace(/['’]s\b/g, "")
      .match(/[\p{L}\p{M}]+|\p{N}+/gu) ?? []
  )
    .filter((w) => !STOP.has(w))
    .map(stem)

/**
 * Words a line may add to the owner's own: they frame a statement about a
 * person and carry no business claim ("Prefers calls after 4pm"). None can
 * turn a word of the owner's into its opposite, so "dislikes", "hates",
 * "usually" and "works" are not here: "Dislikes calls" from "call me" would
 * reverse what was said.
 */
const FRAMING = new Set(
  "owner prefers likes wants goes by called is has".split(" ").map(stem)
)

/**
 * Whether every content word of `line` is one the owner wrote, or a framing word. This is what
 * keeps text from a review, an email or a page out of memory: a line
 * that says something the owner did not say has a word they did not write.
 * "Before" and "not" are content words, so a reversal fails too, and so does
 * a line that drops a "not" the owner's sentence held.
 */
export function inOwnersWords(
  line: string,
  said: readonly string[],
  framing = true
) {
  const held = new Set(said.flatMap(contentWords))
  const words = contentWords(line)
  const stated = words.filter((w) => !FRAMING.has(w))
  if (!words.every((w) => held.has(w) || (framing && FRAMING.has(w))))
    return false
  if (!framing || words.some((w) => NEGATION.has(w))) return true
  return !said
    .flatMap((s) => s.split(CLAUSES))
    .some((s) => {
      const own = contentWords(s)
      return (
        own.some((w) => NEGATION.has(w)) && stated.every((w) => own.includes(w))
      )
    })
}

/**
 * Whether two lines say the same thing: the same words, or content words
 * that overlap by four fifths or more, so a reworded copy is caught too.
 */
export function sameFact(a: string, b: string): boolean {
  if (norm(a).toLowerCase() === norm(b).toLowerCase()) return true
  const x = new Set(contentWords(a))
  const y = new Set(contentWords(b))
  if (x.size === 0 || y.size === 0) return false
  const shared = [...x].filter((w) => y.has(w)).length
  return shared / (x.size + y.size - shared) >= 0.8
}

const norm = (text: string) => text.trim().replace(/\s+/g, " ")

type Source = ProfileLine["source"]

/** Why a batch changed nothing. */
export type Refusal = {
  code:
    | "memory.invalid"
    | "memory.duplicate"
    | "memory.elsewhere"
    | "memory.no_match"
    | "memory.ambiguous_match"
    | "memory.not_a_statement"
    | "memory.not_owners_words"
    | "memory.not_quoted"
    | "memory.secret"
    | "memory.business_fact"
    | "memory.no_skill"
  message: string
}

const refusal = (code: Refusal["code"], message: string): Refusal => ({
  code,
  message,
})

// Statements, not orders: after hermes-agent agent/prompt_builder.py, MIT.
const STATEMENT =
  "Write it as a declarative fact, not an instruction: 'Owner prefers short replies', never 'Always reply briefly'. An imperative is re-read as a directive in later conversations and can override what they ask then."

const SECRET_TEXT =
  "Never store passwords, card numbers, door or lockbox codes or any other access secret: anyone who reads memory would hold it. Note where a thing is, never its code."

const BUSINESS_TEXT =
  "Prices, phone numbers, email addresses and the business's other facts live in the facts, so they are not saved here: change them with request_change."

const OWN_WORDS =
  "Say only what the owner said: every word of a saved line must come from what they wrote in this conversation, or be 'owner' or their name. Write it again as a short third-person fact built from their words."

const QUOTED = `A standing request quotes one whole sentence the owner typed in this conversation, exactly, ${ASKED_MAX} characters at most: Asked: "their sentence".`

/** The lines that hold `match`, ignoring case, spacing, quote marks and dashes: the one rule that picks the line a change touches. */
export const linesMatching = <L extends { text: string }>(
  lines: readonly L[],
  match: string
) => {
  const wanted = fold(match)
  if (!/[\p{L}\p{N}]/u.test(wanted)) return []
  const whole = lines.filter((l) => fold(l.text) === wanted)
  return whole.length > 0
    ? whole
    : lines.filter((l) => fold(l.text).includes(wanted))
}

/** After hermes-agent tools/memory_tool_store.py `_normalize_for_match` (MIT): quotes, dashes and spacing folded, lower case. */
const fold = (text: string) =>
  text
    .replace(/\\n/g, " ")
    .replace(/["`‘’‚‛“”„‟]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/** `line` with the one span `old` replaced by `content`, or why not. Case, spacing, quotes and dashes are folded to find it. */
function patched(
  line: string,
  old: string,
  content: string
): string | "repeated" | "missing" {
  const hay = line.toLowerCase()
  const needle = old.trim().toLowerCase()
  const at = hay.indexOf(needle)
  // A line found only by folding is patched whole, when old_text is all of it.
  if (at < 0) return fold(line) === fold(old) ? norm(content) : "missing"
  if (hay.indexOf(needle, at + 1) >= 0) return "repeated"
  return norm(`${line.slice(0, at)}${content}${line.slice(at + needle.length)}`)
}

/** A line of the skill notes without its skill, as one skill's layer holds it. */
const unskilled = (line: ProfileLine): ProfileLine => {
  const { skill: _, ...rest } = line as SkillNoteLine
  return rest
}

/** A fact or a line of another layer a new line would repeat: where it lives, and its text. */
export type Elsewhere = { where: string; text: string }

/** What a batch that would not fit says, and the entries to consolidate (Hermes's IF FULL). */
export type Full = { lines: ProfileLine[]; note: string }

/**
 * `ops` applied to a copy of `lines`, all or none, after hermes-agent
 * tools/memory_tool_store.py `apply_batch` (MIT): the budget is checked on
 * the final result only, so one batch may remove and patch to make room and
 * add together. Every line a batch writes passes the same checks: a
 * statement, no secret, no business fact, the owner's own words when `said`
 * is given (a standing request quoted whole), no near-duplicate in this
 * store or `elsewhere`. Past `CONSOLIDATE_AT`, a batch that grows the store
 * must merge or remove in the same call.
 */
export function applyOperations(
  lines: readonly ProfileLine[],
  ops: readonly MemoryOperation[],
  source: Source,
  at: string,
  said: readonly string[] | null = null,
  newId: () => string = () => crypto.randomUUID(),
  max: number = PROFILE_MAX_CHARS,
  elsewhere: readonly Elsewhere[] = []
):
  | { ok: true; lines: ProfileLine[] }
  | { ok: false; refusal: Refusal }
  | { ok: false; full: Full } {
  let held = [...lines]
  for (const [i, op] of ops.entries()) {
    const pos = `Operation ${i + 1} (${op.action})`
    if (
      (op.action !== "remove" && !op.content) ||
      (op.action !== "add" && !op.old_text)
    ) {
      return {
        ok: false,
        refusal: refusal(
          "memory.invalid",
          `${pos}: add needs content; patch needs old_text and content; remove needs old_text. Nothing was written.`
        ),
      }
    }
    let hit: ProfileLine | undefined
    if (op.action !== "add") {
      const hits = linesMatching(held, op.old_text as string)
      if (hits.length !== 1) {
        return {
          ok: false,
          refusal:
            hits.length === 0
              ? refusal(
                  "memory.no_match",
                  `${pos}: no entry holds that. Copy old_text from one entry. Nothing was written.`
                )
              : refusal(
                  "memory.ambiguous_match",
                  `${pos}: more than one entry holds that. Use a longer piece of one. Nothing was written.`
                ),
        }
      }
      hit = hits[0] as ProfileLine
    }
    if (op.action === "remove") {
      held = held.filter((l) => l.id !== hit?.id)
      continue
    }
    const text =
      op.action === "add"
        ? norm(op.content as string)
        : patched(hit?.text ?? "", op.old_text as string, op.content as string)
    if (text === "repeated" || text === "missing") {
      return {
        ok: false,
        refusal: refusal(
          "memory.ambiguous_match",
          `${pos}: old_text must occur once in the entry. Include more of it. Nothing was written.`
        ),
      }
    }
    const checked = check(text, said && hit ? [...said, hit.text] : said, [
      ...held
        .filter((l) => l.id !== hit?.id)
        .map((l) => ({ where: "this store", text: l.text })),
      ...elsewhere,
    ])
    if (checked) return { ok: false, refusal: checked }
    held =
      op.action === "add"
        ? [...held, { id: newId(), text, source, at }]
        : held.map((l) => (l.id === hit?.id ? { ...l, text, source, at } : l))
  }
  const before = profileText(lines).length
  const after = profileText(held).length
  const current = `${before.toLocaleString("en-GB")}/${max.toLocaleString("en-GB")}`
  if (after > max || held.some((l) => l.text.length > PROFILE_LINE_MAX)) {
    return {
      ok: false,
      full: {
        lines: [...lines],
        note: `Memory at ${current} chars; this batch would put it at ${after.toLocaleString("en-GB")}: free at least ${Math.max(1, after - max).toLocaleString("en-GB")} chars. Retry as ONE batch that removes or shortens (patch) stale entries from current_entries AND adds the new one; the limit is checked only on the batch result.`,
      },
    }
  }
  if (
    after > before &&
    before >= max * CONSOLIDATE_AT &&
    !ops.some((op) => op.action !== "add")
  ) {
    return {
      ok: false,
      full: {
        lines: [...lines],
        note: `Memory at ${current} chars, over four fifths full. Consolidate rather than pile up: retry as ONE batch that merges or removes stale entries from current_entries AND adds the new one.`,
      },
    }
  }
  return { ok: true, lines: held }
}

/** Why `text` may not be written, or null. */
function check(
  text: string,
  said: readonly string[] | null,
  others: readonly Elsewhere[]
): Refusal | null {
  const quote = quoteOf(text)
  if (quote !== null) {
    if (
      quote.length > ASKED_MAX ||
      refusalOf(quote) === "attack" ||
      refusalOf(quote) === "secret" ||
      (said && !quotedFrom(quote, said))
    ) {
      return refusal("memory.not_quoted", QUOTED)
    }
  } else {
    const why = refusalOf(text)
    if (why === "secret") return refusal("memory.secret", SECRET_TEXT)
    if (why) return refusal("memory.not_a_statement", STATEMENT)
    if (BUSINESS.test(text))
      return refusal("memory.business_fact", BUSINESS_TEXT)
    if (said && !inOwnersWords(text, said)) {
      return refusal("memory.not_owners_words", OWN_WORDS)
    }
  }
  const twin = others.find((o) => sameFact(o.text, text))
  if (twin) {
    return twin.where === "this store"
      ? refusal(
          "memory.duplicate",
          `Already saved: "${twin.text}". Patch that entry instead of adding another.`
        )
      : refusal(
          "memory.elsewhere",
          `One home per fact: ${twin.where} already holds "${twin.text}". Nothing was written.`
        )
  }
  return null
}

/** A store's lines from one stored value; a value the contract refuses reads as empty. */
const linesOf = (value: unknown, store: Store = STORES.profile) =>
  (store.schema.safeParse(value).data?.lines ?? []) as ProfileLine[]

/** The current profile, or another whole store, and its version; none yet is version 0. */
export async function readProfile(
  db: OrgScopedDb,
  store: Store = STORES.profile
): Promise<{ version: number; lines: ProfileLine[] }> {
  const row = await currentFact(db, store.key)
  if (!row) return { version: 0, lines: [] }
  const parsed = store.schema.safeParse(row.value)
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        code: "memory.profile_unreadable",
        key: store.key,
        version: row.version,
      })
    )
    return { version: row.version, lines: [] }
  }
  return { version: row.version, lines: parsed.data.lines as ProfileLine[] }
}

/** A layer's lines, and every line of its store, which a skill's write keeps beside its own. */
export async function readLayer(db: OrgScopedDb, layer: Layer) {
  const { version, lines: all } = await readProfile(db, layer.store)
  const lines = layer.skill
    ? (all as SkillNoteLine[])
        .filter((l) => l.skill === layer.skill)
        .map(unskilled)
    : all
  return { version, lines, all }
}

/**
 * Takes the profile's writer lock, the one `supersedeFact` takes, so two
 * writers (the tool, the page, reflection) cannot both start from the same
 * version. Call it before `readProfile` and keep to the one transaction.
 * Another private fact read and rewritten whole takes it by its own key.
 */
export async function lockProfile(
  db: OrgScopedDb,
  orgId: string,
  key = OWNER_PROFILE_KEY
) {
  await db.execute(
    sql`select pg_advisory_xact_lock(5, hashtext(${`${orgId}:${key}`}::text))`
  )
}

/** Writes `lines` as the store's next version. */
export async function saveProfile(
  db: OrgScopedDb,
  orgId: string,
  lines: ProfileLine[],
  provenance: { source: "owner_stated" | "inferred"; confidence: number } = {
    source: "owner_stated",
    confidence: 1,
  },
  store: Store = STORES.profile
): Promise<number> {
  const written = await supersedePrivateFact(db, {
    orgId,
    key: store.key,
    factType: "owner",
    value: { lines },
    provenance,
  })
  return written.version
}

/** Writes a layer's `lines` as its store's next version, a skill's beside the other skills' lines in `all`. */
export const saveLayer = (
  db: OrgScopedDb,
  orgId: string,
  layer: Layer,
  lines: ProfileLine[],
  all: readonly ProfileLine[],
  provenance?: { source: "owner_stated" | "inferred"; confidence: number }
) =>
  saveProfile(
    db,
    orgId,
    layer.skill
      ? [
          ...(all as SkillNoteLine[]).filter((l) => l.skill !== layer.skill),
          ...lines.map((l) => ({ ...l, skill: layer.skill as string })),
        ]
      : lines,
    provenance,
    layer.store
  )

/**
 * A skill's notes for this business as its view returns them, headed as a
 * store is, or undefined when it has none.
 */
export async function skillNotesText(
  db: OrgScopedDb,
  name: string
): Promise<string | undefined> {
  const layer = layerOf(`skill:${name}`)
  if (!layer) return undefined
  const { lines } = await readLayer(db, layer)
  return lines.length > 0
    ? [
        `Notes for this business: [${fullness(lines, layer.store.max)}]`,
        ...lines.map((l) => l.text),
      ].join("\n")
    : undefined
}

/**
 * What a line written to `layer` must not repeat: the other layers' lines,
 * named by where they live, and the business's facts (one home per fact).
 */
export async function elsewhereOf(
  db: OrgScopedDb,
  layer: Layer
): Promise<Elsewhere[]> {
  const [profile, notes, skills, facts] = await Promise.all([
    readProfile(db, STORES.profile),
    readProfile(db, STORES.notes),
    readProfile(db, STORES.skills),
    currentFacts(db),
  ])
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : []
  return [
    ...(layer.target === "user"
      ? []
      : profile.lines.map((l) => ({
          where: "the owner profile",
          text: l.text,
        }))),
    ...(layer.target === "notes"
      ? []
      : notes.lines.map((l) => ({ where: "the working notes", text: l.text }))),
    ...(skills.lines as SkillNoteLine[])
      .filter((l) => l.skill !== layer.skill)
      .map((l) => ({ where: `the ${l.skill} skill's notes`, text: l.text })),
    ...facts.flatMap((f) =>
      strings(f.value)
        .filter((t) => contentWords(t).length >= 2)
        .map((text) => ({ where: `the business fact ${f.key}`, text }))
    ),
  ]
}

/**
 * What the owner typed in the session, newest 40 messages. An emailed
 * reply (`eml_`) is not counted: it crosses a channel the owner does not
 * watch the way they watch the chat.
 */
export async function ownerWords(db: OrgScopedDb, sessionId: string) {
  const rows = await db.execute<{ text: string | null }>(sql`
    select p->>'text' as text
    from (select payload from events
      where session_id = ${sessionId} and type = 'cos.message'
        and payload->'message'->>'role' = 'user'
        and payload->'message'->>'id' not like 'eml\_%'
      order by seq desc limit 40) e,
      jsonb_array_elements(e.payload->'message'->'parts') p
    where p->>'type' = 'text'`)
  return [...rows].flatMap((r) => (r.text ? [r.text] : []))
}

const refused = (code: string, message: string) => ({
  outcome: "refused" as const,
  error: { class: "validation" as const, code, message },
})

/**
 * One batch to one layer for `memory` and for reflection, under the layer's
 * lock: the outcome the tool returns, and the lines it left.
 */
export async function writeBatch(
  db: OrgScopedDb,
  orgId: string,
  input: MemoryInput,
  source: Source,
  said: readonly string[] | null,
  provenance?: { source: "owner_stated" | "inferred"; confidence: number }
): Promise<{
  output: MemoryOutput
  before: ProfileLine[]
  after: ProfileLine[] | null
}> {
  const layer = layerOf(input.target)
  if (!layer) {
    return {
      output: refused(
        "memory.no_skill",
        `No skill has that name. Targets are user, notes and skill: with one of ${PROCEDURES.map((p) => p.name).join(", ")}.`
      ),
      before: [],
      after: null,
    }
  }
  await lockProfile(db, orgId, layer.store.key)
  const { lines, all } = await readLayer(db, layer)
  const result = applyOperations(
    lines,
    input.operations,
    source,
    new Date().toISOString(),
    said,
    undefined,
    layer.store.max,
    await elsewhereOf(db, layer)
  )
  if ("refusal" in result) {
    return {
      output: refused(result.refusal.code, result.refusal.message),
      before: lines,
      after: null,
    }
  }
  if ("full" in result) {
    return {
      output: {
        outcome: "full",
        target: layer.target,
        note: result.full.note,
        fullness: fullness(result.full.lines, layer.store.max),
        current_entries: result.full.lines.map((l) => l.text),
      },
      before: lines,
      after: null,
    }
  }
  await saveLayer(db, orgId, layer, result.lines, all, provenance)
  return {
    output: {
      outcome: "saved",
      target: layer.target,
      note: "Write saved. This update is complete; do not repeat it.",
      fullness: fullness(result.lines, layer.store.max),
    },
    before: lines,
    after: result.lines,
  }
}

/**
 * The `memory` tool. Counts this turn's `full` answers from its own logged
 * results, so a fragile consolidation cannot loop the turn to its step limit
 * (after hermes-agent tools/memory_tool_store.py, MIT).
 */
export async function memory(
  { kit, owner }: ToolContext,
  input: MemoryInput,
  _key: string,
  turn: Turn
): Promise<MemoryOutput> {
  return kit.withOrg({ orgId: owner.orgId }, async (db) => {
    const [row] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from events
      where session_id = ${turn.sessionId} and type = 'cos.tool_result'
        and payload->>'turn_id' = ${turn.turnId}
        and payload->>'tool' = 'memory'
        and payload->'output'->>'outcome' = 'full'`)
    if ((row?.n ?? 0) >= FULL_REFUSALS) {
      return {
        outcome: "stopped" as const,
        note: "Memory failed to consolidate three times this turn. Stop retrying memory and continue your reply; it can be saved in a later turn.",
      }
    }
    const { output } = await writeBatch(db, owner.orgId, input, "owner_said", [
      ...(await ownerWords(db, turn.sessionId)),
      ...(owner.session.name ? [owner.session.name] : []),
    ])
    return output
  })
}

type Change = ProfileVersion["changes"][number]

/** What `after` changed against `before`, by line id. */
export function diffLines(
  before: readonly ProfileLine[],
  after: readonly ProfileLine[]
): Change[] {
  const was = new Map(before.map((l) => [l.id, l]))
  const is = new Set(after.map((l) => l.id))
  return [
    ...after.flatMap((l): Change[] => {
      const old = was.get(l.id)
      if (!old) return [{ kind: "added", text: l.text, source: l.source }]
      return old.text === l.text
        ? []
        : [{ kind: "changed", text: l.text, source: l.source }]
    }),
    ...before.flatMap((l): Change[] =>
      is.has(l.id) ? [] : [{ kind: "removed", text: l.text, source: l.source }]
    ),
  ]
}

/** A store's current lines and its newest versions. */
async function layerView(db: OrgScopedDb, store: Store): Promise<MemoryLayer> {
  const rows = await factVersions(db, store.key, 51)
  const current = rows[0] ? linesOf(rows[0].value, store) : []
  const versions = rows.slice(0, 50).map((row, i): ProfileVersion => {
    const before = rows[i + 1] ? linesOf(rows[i + 1]?.value, store) : []
    return {
      version: row.version,
      at: row.validFrom.toISOString(),
      changes: diffLines(before, linesOf(row.value, store)),
    }
  })
  return {
    version: rows[0]?.version ?? 0,
    lines: current.map(unskilled),
    max: store.max,
    versions,
  }
}

/** When each skill last loaded for this org, by the model or by code. */
async function lastLoads(db: OrgScopedDb): Promise<Map<string, number>> {
  const rows = await db.execute<{ name: string; at: string }>(sql`
    select coalesce(payload->>'name', payload->'output'->>'name') as name,
      max(recorded_at)::text as at
    from events
    where type = 'cos.skill' or (type = 'cos.tool_result'
      and payload->>'tool' = 'skill_view' and payload->'output'->>'outcome' = 'skill')
    group by 1`)
  return new Map([...rows].map((r) => [r.name, Date.parse(r.at)]))
}

/** The skill notes as the page shows them: by skill, under its plain name, the stale ones marked. */
async function skillNotesView(
  db: OrgScopedDb,
  now = Date.now()
): Promise<SkillNotesView[]> {
  const { lines } = await readProfile(db, STORES.skills)
  const loads = await lastLoads(db)
  const old = (at: number | undefined) =>
    at === undefined || now - at > STALE_DAYS * 86_400_000
  return [...new Set((lines as SkillNoteLine[]).map((l) => l.skill))].map(
    (name) => ({
      name,
      title:
        /^# (.+)$/m.exec(procedure("cos", name)?.body ?? "")?.[1]?.trim() ??
        name,
      max: SKILL_NOTES_MAX_CHARS,
      lines: (lines as SkillNoteLine[])
        .filter((l) => l.skill === name)
        .map((l) => ({
          ...unskilled(l),
          stale: old(Date.parse(l.at)) && old(loads.get(name)),
        })),
    })
  )
}

/** The page: every store's lines and versions. */
export async function memoryView(db: OrgScopedDb): Promise<MemoryView> {
  const [profile, notes, skills, notesBySkill, review, corrections] =
    await Promise.all([
      layerView(db, STORES.profile),
      layerView(db, STORES.notes),
      layerView(db, STORES.skills),
      skillNotesView(db),
      readReview(db),
      readCorrections(db),
    ])
  return {
    version: profile.version,
    lines: profile.lines,
    versions: profile.versions,
    notes,
    skills: {
      version: skills.version,
      notes: notesBySkill,
      versions: skills.versions,
    },
    ask_first: review.ask_first,
    proposals: review.proposals,
    corrections: corrections.lines,
  }
}

/** The review state; a row written before the choice existed reads as asking nothing. */
export async function readReview(db: OrgScopedDb): Promise<OwnerMemoryReview> {
  const row = await currentFact(db, OWNER_MEMORY_REVIEW_KEY)
  return (
    OwnerMemoryReview.safeParse({
      ask_first: false,
      proposals: [],
      chip_through: 0,
      ...(row?.value as object | undefined),
    }).data ?? { ask_first: false, proposals: [], chip_through: 0 }
  )
}

/** Writes the review state with `patch` over what it was. */
export async function writeReview(
  db: OrgScopedDb,
  orgId: string,
  patch: Partial<OwnerMemoryReview>
) {
  await supersedePrivateFact(db, {
    orgId,
    key: OWNER_MEMORY_REVIEW_KEY,
    factType: "owner",
    value: { ...(await readReview(db)), ...patch },
    provenance: { source: "owner_stated", confidence: 1 },
  })
}

/**
 * What changed since the chat last looked, as one chip, or null. It is the
 * net difference between the profile as the chat last saw it and now, so a
 * change taken back before the chat showed it is never mentioned.
 * Reading it moves the mark, so a change is shown once.
 */
export async function takeChip(
  db: OrgScopedDb,
  orgId: string
): Promise<MemoryChip | null> {
  const review = await readReview(db)
  const rows = await factVersions(db, OWNER_PROFILE_KEY, 8)
  const newest = rows[0]
  if (!newest || newest.version <= review.chip_through) return null
  const seen =
    rows.find((r) => r.version === review.chip_through) ?? rows.at(-1)
  const changes = diffLines(
    seen && seen.version <= review.chip_through ? linesOf(seen.value) : [],
    linesOf(newest.value)
  )
  await writeReview(db, orgId, { chip_through: newest.version })
  return changes.length === 0
    ? null
    : { version: newest.version, changes: changes.slice(0, 10) }
}

/**
 * The operation a stored proposal makes: whole lines, so a replace or patch
 * rewrites the line it was made against (Hermes: to rewrite a whole entry,
 * old_text is the whole entry).
 */
export const proposalOp = (proposal: {
  action: "add" | "replace" | "patch" | "remove"
  text?: string | undefined
  was?: string | undefined
}): MemoryOperation =>
  proposal.action === "add"
    ? { action: "add", content: proposal.text }
    : proposal.action === "remove"
      ? { action: "remove", old_text: proposal.was }
      : { action: "patch", old_text: proposal.was, content: proposal.text }

/**
 * The owner's answer on their page: the choice to be asked first, or a
 * proposal accepted (saved as \`owner_confirmed\`) or dismissed. False when
 * the proposal is gone or no longer applies; a proposal that no longer
 * applies is dropped.
 */
export async function reviewAction(
  db: OrgScopedDb,
  orgId: string,
  action: MemoryReviewAction
): Promise<boolean> {
  await lockProfile(db, orgId)
  if (action.action === "ask_first") {
    await writeReview(db, orgId, { ask_first: action.value })
    return true
  }
  const review = await readReview(db)
  const proposal = review.proposals.find((p) => p.id === action.id)
  if (!proposal) return false
  const rest = review.proposals.filter((p) => p.id !== action.id)
  if (action.action === "accept") {
    const layer = layerOf(proposal.target ?? "user")
    if (!layer) {
      await writeReview(db, orgId, { proposals: rest })
      return false
    }
    await lockProfile(db, orgId, layer.store.key)
    const { lines, all } = await readLayer(db, layer)
    const done = applyOperations(
      lines,
      [proposalOp(proposal)],
      "owner_confirmed",
      new Date().toISOString(),
      null,
      undefined,
      layer.store.max
    )
    if (!done.ok) {
      await writeReview(db, orgId, { proposals: rest })
      return false
    }
    await saveLayer(db, orgId, layer, done.lines, all)
  }
  await writeReview(db, orgId, { proposals: rest })
  return true
}

/**
 * The owner's page: `GET /memory` and `POST /memory/review`, which only the
 * org's owner may call. The page writes no memory: the owner changes it by
 * telling the assistant.
 */
export async function memoryRoute(
  request: Request,
  kit: Tenancy,
  owner: Owner
): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  const at = { orgId: owner.orgId }
  const view = async () =>
    Response.json(
      MemoryView.parse(await kit.withOrg(at, (db) => memoryView(db)))
    )
  if (pathname === "/memory" && request.method === "GET") return view()
  if (pathname === "/memory/review" && request.method === "POST") {
    const parsed = MemoryReviewAction.safeParse(await readBody(request))
    if (!parsed.success) return invalid(parsed.error.issues)
    const done = await kit.withOrg(at, (db) =>
      reviewAction(db, owner.orgId, parsed.data)
    )
    if (!done) {
      return failure(409, {
        class: "validation",
        code: "memory.nothing_to_review",
        message:
          "That suggestion is gone or no longer fits, so nothing was changed.",
        detail: {},
      })
    }
    return view()
  }
  return null
}
