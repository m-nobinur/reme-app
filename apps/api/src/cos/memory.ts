import {
  type MemoryChip,
  MemoryReviewAction,
  MemoryUndo,
  MemoryView,
  OWNER_MEMORY_REVIEW_KEY,
  OWNER_PROFILE_KEY,
  OwnerMemoryReview,
  OwnerProfile,
  PROFILE_MAX_CHARS,
  type ProfileLine,
  type ProfileVersion,
  profileText,
  type RememberInput,
  type RememberOperation,
  type RememberOutput,
  STAFF_CORRECTIONS_KEY,
  Uuid,
} from "@workspace/contracts"
import {
  currentFact,
  factVersions,
  type OrgScopedDb,
  readCorrections,
  sql,
  supersedePrivateFact,
  type Tenancy,
} from "@workspace/db"
import type { Owner } from "../changes.ts"
import { isOrgOwner } from "../domain-buy.ts"
import { failure, invalid, readBody } from "../http.ts"
import type { ToolContext } from "./tools.ts"
import type { Turn } from "./turns.ts"

/**
 * The Chief of Staff's memory of the owner (ADR-042): one fact of plain
 * lines, every change a version. The owner's page, the `remember` tool and
 * reflection all write through `saveProfile`, so a change has one home.
 */

/** Refusals the same turn may get before `remember` stops answering. */
export const FULL_REFUSALS = 3

/** The profile as a person reads its fullness: `62%, 930/1,500 chars`. */
export function fullness(lines: readonly { text: string }[]): string {
  const used = profileText(lines).length
  return `${Math.round((used / PROFILE_MAX_CHARS) * 100)}%, ${used.toLocaleString("en-GB")}/${PROFILE_MAX_CHARS.toLocaleString("en-GB")} chars`
}

/**
 * Lines that read as an attack on the assistant, not as a fact about the
 * owner. The patterns sit on attack vocabulary, the way hermes' memory scan
 * does, so ordinary bossy English such as "Call me Sam" passes. A second
 * kind catches a line written as an order to the assistant: a profile line
 * states what is so ("Prefers calls after 4pm"), it does not command.
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

/** Why a line was refused, or null when it may be saved. */
export function refusalOf(text: string): "attack" | "order" | null {
  if (ATTACK.some((p) => p.test(text))) return "attack"
  if (ORDER.some((p) => p.test(text.trim()))) return "order"
  return null
}

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
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[.!?]+$/, "")

/**
 * Whether `quote` is a whole sentence the owner typed, ignoring case,
 * spacing, curly quotes and the closing stop. Whole, so a piece cut out of
 * "Don't approve every change" can never stand alone as an order.
 */
export const quotedFrom = (quote: string, said: readonly string[]) =>
  said
    .flatMap((s) => s.split(/(?<=[.!?])\s+|\n+/))
    .some((sentence) => plain(sentence) === plain(quote))

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
    : word.length > 5 && word.endsWith("ing")
      ? word.slice(0, -3)
      : word.length > 4 && word.endsWith("ed")
        ? word.slice(0, -2)
        : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
          ? word.slice(0, -1)
          : word

/** The content words of `text`: letters and digits apart, lower case, stems, no stopwords. */
export const contentWords = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{M}]+|\p{N}+/gu) ?? [])
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
  "prefers likes wants goes by called is has".split(" ").map(stem)
)

/**
 * Whether every content word of `line` is one the owner wrote, or a framing word. This is what
 * keeps text from a review, an email or a page out of the profile: a line
 * that says something the owner did not say has a word they did not write.
 * "Before" and "not" are content words, so a reversal fails too.
 */
export function inOwnersWords(
  line: string,
  said: readonly string[],
  framing = true
) {
  const held = new Set(said.flatMap(contentWords))
  return contentWords(line).every(
    (w) => held.has(w) || (framing && FRAMING.has(w))
  )
}

const norm = (text: string) => text.trim().replace(/\s+/g, " ")
const same = (a: string, b: string) =>
  norm(a).toLowerCase() === norm(b).toLowerCase()

type Source = ProfileLine["source"]

/** Why a batch changed nothing. */
export type Refusal = {
  code:
    | "memory.invalid"
    | "memory.duplicate"
    | "memory.no_match"
    | "memory.ambiguous_match"
    | "memory.not_a_statement"
    | "memory.not_owners_words"
    | "memory.not_quoted"
  message: string
}

const refusal = (code: Refusal["code"], message: string): Refusal => ({
  code,
  message,
})

const STATEMENT =
  "Write it as a plain statement about the owner, such as 'Prefers calls after 4pm'. Instructions to the assistant are not saved."

/** The lines that hold `match`, ignoring case and spacing: the one rule that picks the line a change touches. */
export const linesMatching = (lines: readonly ProfileLine[], match: string) => {
  const wanted = norm(match).toLowerCase()
  return lines.filter((l) => l.text.toLowerCase().includes(wanted))
}

const OWN_WORDS =
  "Use the owner's own words: every word of a saved line must come from what the owner wrote in this conversation. Say it again with their words."

const QUOTED = `A standing request quotes one whole sentence the owner typed in this conversation, exactly, ${ASKED_MAX} characters at most: Asked: "their sentence".`

/**
 * `ops` applied to a copy of `lines`, all or none. The limit is checked on
 * the result, so a batch may remove and add in one call. `full` names the
 * result that would not fit.
 */
export function applyOperations(
  lines: readonly ProfileLine[],
  ops: readonly RememberOperation[],
  source: Source,
  at: string,
  said: readonly string[] | null = null,
  newId: () => string = () => crypto.randomUUID()
):
  | { ok: true; lines: ProfileLine[] }
  | { ok: false; refusal: Refusal }
  | { ok: false; full: ProfileLine[] } {
  let held = [...lines]
  const need = (op: RememberOperation) =>
    (op.action !== "remove" && !op.text) || (op.action !== "add" && !op.match)
  for (const op of ops) {
    if (need(op)) {
      return {
        ok: false,
        refusal: refusal(
          "memory.invalid",
          "add needs text; replace needs match and text; remove needs match."
        ),
      }
    }
    const text = op.text === undefined ? undefined : norm(op.text)
    if (text !== undefined) {
      const quote = quoteOf(text)
      if (quote !== null) {
        if (
          quote.length > ASKED_MAX ||
          refusalOf(quote) === "attack" ||
          (said && !quotedFrom(quote, said))
        ) {
          return { ok: false, refusal: refusal("memory.not_quoted", QUOTED) }
        }
      } else if (refusalOf(text)) {
        return {
          ok: false,
          refusal: refusal("memory.not_a_statement", STATEMENT),
        }
      } else if (said && !inOwnersWords(text, said)) {
        return {
          ok: false,
          refusal: refusal("memory.not_owners_words", OWN_WORDS),
        }
      }
      if (held.some((l) => same(l.text, text))) {
        return {
          ok: false,
          refusal: refusal("memory.duplicate", "already saved"),
        }
      }
    }
    if (op.action === "add") {
      held.push({
        id: newId(),
        text: text as string,
        source,
        at,
      })
      continue
    }
    const hits = linesMatching(held, op.match as string)
    if (hits.length === 0) {
      return {
        ok: false,
        refusal: refusal(
          "memory.no_match",
          "No saved line contains that. Match a short piece of an existing line."
        ),
      }
    }
    if (hits.length > 1) {
      return {
        ok: false,
        refusal: refusal(
          "memory.ambiguous_match",
          "More than one saved line contains that. Match a longer, unique piece."
        ),
      }
    }
    const hit = hits[0] as ProfileLine
    held =
      op.action === "remove"
        ? held.filter((l) => l.id !== hit.id)
        : held.map((l) =>
            l.id === hit.id ? { ...l, text: text as string, source, at } : l
          )
  }
  const parsed = OwnerProfile.safeParse({ lines: held })
  if (!parsed.success) return { ok: false, full: [...lines] }
  return { ok: true, lines: parsed.data.lines }
}

/** The current profile and its version; none yet is version 0. */
export async function readProfile(
  db: OrgScopedDb
): Promise<{ version: number; lines: ProfileLine[] }> {
  const row = await currentFact(db, OWNER_PROFILE_KEY)
  if (!row) return { version: 0, lines: [] }
  const parsed = OwnerProfile.safeParse(row.value)
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        code: "memory.profile_unreadable",
        version: row.version,
      })
    )
    return { version: row.version, lines: [] }
  }
  return { version: row.version, lines: parsed.data.lines }
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

/** Writes `lines` as the profile's next version. */
export async function saveProfile(
  db: OrgScopedDb,
  orgId: string,
  lines: ProfileLine[],
  provenance: { source: "owner_stated" | "inferred"; confidence: number } = {
    source: "owner_stated",
    confidence: 1,
  }
): Promise<number> {
  const written = await supersedePrivateFact(db, {
    orgId,
    key: OWNER_PROFILE_KEY,
    factType: "owner",
    value: { lines },
    provenance,
  })
  return written.version
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

/** The `remember` tool. Counts this turn's `full` answers from its own logged results. */
export async function remember(
  { kit, owner }: ToolContext,
  input: RememberInput,
  _key: string,
  turn: Turn
): Promise<RememberOutput> {
  return kit.withOrg({ orgId: owner.orgId }, async (db) => {
    const [row] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from events
      where session_id = ${turn.sessionId} and type = 'cos.tool_result'
        and payload->>'turn_id' = ${turn.turnId}
        and payload->>'tool' = 'remember'
        and payload->'output'->>'outcome' = 'full'`)
    if ((row?.n ?? 0) >= FULL_REFUSALS) {
      return {
        outcome: "stopped" as const,
        note: "stop retrying memory and continue your reply",
      }
    }
    await lockProfile(db, owner.orgId)
    const held = await readProfile(db)
    const result = applyOperations(
      held.lines,
      input.operations,
      "owner_said",
      new Date().toISOString(),
      await ownerWords(db, turn.sessionId)
    )
    if ("refusal" in result) {
      return {
        outcome: "refused" as const,
        error: {
          class: "validation" as const,
          code: result.refusal.code,
          message: result.refusal.message,
        },
      }
    }
    if ("full" in result) {
      return {
        outcome: "full" as const,
        note: "full: merge or remove first",
        fullness: fullness(result.full),
        lines: result.full.map((l) => l.text),
      }
    }
    await saveProfile(db, owner.orgId, result.lines)
    return {
      outcome: "saved" as const,
      note: "Saved. This update is complete; do not repeat it.",
      fullness: fullness(result.lines),
    }
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

/** One stored version's lines; a value the contract refuses reads as empty. */
const linesOf = (value: unknown): ProfileLine[] =>
  OwnerProfile.safeParse(value).data?.lines ?? []

/**
 * The inverse of `after`'s change against `before`, applied to `current`:
 * an added line goes, a removed one returns, an edited one is restored. A
 * part that no longer applies (the line was edited or removed since) is
 * left. Returns null when nothing is left to undo.
 */
export function inverse(
  before: readonly ProfileLine[],
  after: readonly ProfileLine[],
  current: readonly ProfileLine[]
): ProfileLine[] | null {
  const was = new Map(before.map((l) => [l.id, l]))
  const made = new Map(after.map((l) => [l.id, l]))
  let held = [...current]
  let changed = false
  for (const line of after) {
    const old = was.get(line.id)
    if (old?.text === line.text) continue
    const now = held.find((l) => l.id === line.id)
    if (!now || now.text !== line.text) continue
    changed = true
    held = old
      ? held.map((l) => (l.id === line.id ? old : l))
      : held.filter((l) => l.id !== line.id)
  }
  for (const line of before) {
    if (made.has(line.id) || held.some((l) => l.id === line.id)) continue
    changed = true
    held.push(line)
  }
  return changed ? held : null
}

/** The page: the current lines and the newest versions, each with whether undo still applies. */
export async function memoryView(db: OrgScopedDb): Promise<MemoryView> {
  const rows = await factVersions(db, OWNER_PROFILE_KEY, 51)
  const current = rows[0] ? linesOf(rows[0].value) : []
  const versions = rows.slice(0, 50).map((row, i): ProfileVersion => {
    const before = rows[i + 1] ? linesOf(rows[i + 1]?.value) : []
    const after = linesOf(row.value)
    return {
      version: row.version,
      at: row.validFrom.toISOString(),
      changes: diffLines(before, after),
      undoable: inverse(before, after, current) !== null,
    }
  })
  const review = await readReview(db)
  return {
    version: rows[0]?.version ?? 0,
    lines: current,
    versions,
    ask_first: review.ask_first,
    proposals: review.proposals,
    corrections: (await readCorrections(db)).lines,
  }
}

/** Undoes one version's change, as the next version. Null when it no longer applies. */
export async function undoVersion(
  db: OrgScopedDb,
  orgId: string,
  version: number
): Promise<{ version: number } | null> {
  const rows = await factVersions(db, OWNER_PROFILE_KEY, 51)
  const index = rows.findIndex((r) => r.version === version)
  const target = rows[index]
  if (!target) return null
  const before = rows[index + 1] ? linesOf(rows[index + 1]?.value) : []
  await lockProfile(db, orgId)
  const held = await readProfile(db)
  const lines = inverse(before, linesOf(target.value), held.lines)
  if (!lines) return null
  const written = await saveProfile(db, orgId, lines)
  // An undo the owner made is not a change to tell them about.
  const shown = await readReview(db)
  if (shown.chip_through >= written - 1) {
    await writeReview(db, orgId, { chip_through: written })
  }
  return { version: written }
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
 * change the owner took back before the chat showed it is never mentioned.
 * Reading it moves the mark, so a change is shown once; the owner's own
 * undos of a shown change move the mark themselves.
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
    const held = await readProfile(db)
    const done = applyOperations(
      held.lines,
      [{ action: proposal.action, text: proposal.text, match: proposal.was }],
      "owner_confirmed",
      new Date().toISOString()
    )
    if (!done.ok) {
      await writeReview(db, orgId, { proposals: rest })
      return false
    }
    await saveProfile(db, orgId, done.lines)
  }
  await writeReview(db, orgId, { proposals: rest })
  return true
}

/**
 * Takes one of the owner's corrections for staff away, from the next run
 * on. False when it is not there.
 */
export async function removeCorrection(
  db: OrgScopedDb,
  orgId: string,
  id: string
): Promise<boolean> {
  await lockProfile(db, orgId, STAFF_CORRECTIONS_KEY)
  const { lines } = await readCorrections(db)
  const left = lines.filter((l) => l.id !== id)
  if (left.length === lines.length) return false
  await supersedePrivateFact(db, {
    orgId,
    key: STAFF_CORRECTIONS_KEY,
    factType: "owner",
    value: { lines: left },
    provenance: { source: "owner_stated", confidence: 1 },
  })
  return true
}

/**
 * The owner's page: `GET /memory`, `POST /memory/undo`, `POST /memory/review`
 * and `DELETE /memory/corrections/{id}`, which only the org's owner may call.
 */
export async function memoryRoute(
  request: Request,
  kit: Tenancy,
  owner: Owner
): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  const at = { orgId: owner.orgId }
  if (pathname === "/memory" && request.method === "GET") {
    return Response.json(
      MemoryView.parse(await kit.withOrg(at, (db) => memoryView(db)))
    )
  }
  if (pathname === "/memory/undo" && request.method === "POST") {
    const parsed = MemoryUndo.safeParse(await readBody(request))
    if (!parsed.success) return invalid(parsed.error.issues)
    const done = await kit.withOrg(at, (db) =>
      undoVersion(db, owner.orgId, parsed.data.version)
    )
    if (!done) {
      return failure(409, {
        class: "validation",
        code: "memory.nothing_to_undo",
        message:
          "That change was already undone or has been edited since, so there is nothing left to undo.",
        detail: {},
      })
    }
    return Response.json(
      MemoryView.parse(await kit.withOrg(at, (db) => memoryView(db)))
    )
  }
  const [, , section, id = ""] = pathname.split("/")
  if (section === "corrections" && request.method === "DELETE") {
    if (!(await isOrgOwner(kit, owner))) {
      return failure(403, {
        class: "permission",
        code: "memory.not_owner",
        message: "Only the owner can remove how the website is worked on.",
        detail: {},
      })
    }
    const done =
      Uuid.safeParse(id).success &&
      (await kit.withOrg(at, (db) => removeCorrection(db, owner.orgId, id)))
    if (!done) {
      return failure(404, {
        class: "resource",
        code: "memory.correction_not_found",
        message: "That instruction was already removed.",
        detail: {},
      })
    }
    return Response.json(
      MemoryView.parse(await kit.withOrg(at, (db) => memoryView(db)))
    )
  }
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
    return Response.json(
      MemoryView.parse(await kit.withOrg(at, (db) => memoryView(db)))
    )
  }
  return null
}
