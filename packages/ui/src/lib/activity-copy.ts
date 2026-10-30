import type {
  Activity,
  ActivitySegment,
  ActivityStep,
  BuildActivity,
  CosToolName,
  MessageReading,
  OnboardingStatus,
  OnboardingStep,
  PlanFactKey,
} from "@workspace/contracts"
import type { StatusState } from "@workspace/ui/lib/status-line"

/**
 * Every line the owner reads about work in progress, in one place: a CoS
 * tool's status, a build stage, an onboarding step, a segment's title and the
 * "{assistant} is ..." moments. The api sends state and names, never
 * sentences, and no model writes any of these, so the rules live here and one
 * test checks every template.
 *
 * Rules. A working line is a present participle, sentence case, 2 to 6
 * words, with no full stop and no ellipsis; the pages once some are written
 * say what is done and what is left instead. A done line is past tense and
 * carries the result when there is one. A failed line starts "Couldn't" and
 * ends on the next step. A line holds one argument at most, cleaned by
 * `cleanArg`. The words are the owner's: "your website", "your DNS", never
 * "assignment", "revision" or "blueprint". The assistant's name is the one
 * the owner chose, Reme included: without one a line is written bare.
 *
 * Robustness. A status line is a total function: every tool or kind, in
 * every state the thread can see, has a line, so behaviour no one planned
 * for still reads as a sentence.
 * - The catalogue is the only source. No model writes a line: a tool's
 *   `step`, the planner's `doing` and a reasoning heading are never shown.
 *   A line comes from the tool or kind, its state and its cleaned argument.
 * - Layered fallback, never empty, never raw. The specific line with its
 *   argument; the same line without it when `cleanArg` refuses the argument
 *   or there is none; the kind's line; one universal line per state ("Working
 *   on it", "Done", "Couldn't finish that", "Stopped"). Never a tool name, an
 *   id, a snake_case word or an empty string. A name the table does not know
 *   (the api a deploy ahead, a new tool, segment or stage) lands on the kind
 *   or universal line.
 * - States. Every AI SDK tool part state (`PartState`) and every way a turn
 *   ends (`TurnEnd`) maps to one `Phase` in `partPhase`. Once the turn is
 *   over no part is working: it is done, failed or stopped. A cancelled part
 *   (the owner sent a new message) says "Stopped"; one the stream left
 *   without a result says "Didn't finish", never that the work itself
 *   stopped, since it may have run on.
 * - Liveness. A working line past `STILL_AFTER` seconds says "Still ...". A
 *   line belongs to its turn: variants are seeded by the turn's id, and the
 *   thread clears a turn's status when the next one is sent.
 * - Variety. Common lines have two to four variants, picked by a hash of the
 *   seed (a message id in chat, the org and segment in the panel), so a line
 *   is stable within a turn and differs across turns; given the previous
 *   turn's seed it never repeats that turn's variant.
 * - Observability. A known name that falls below its own line, and a name
 *   the table does not know, are reported by `reportCopyGap` (a console
 *   warning in development; the tests catch every known case).
 */

/** What an icon is drawn for, so the status line picks its icon from the copy's own kind. */
export type StatusKind =
  | "reading"
  | "thinking"
  | "still"
  | "setup"
  | "question"
  | "planning"
  | "building"
  | "photos"
  | "writing"
  | "polishing"
  | "checking"
  | "domain"
  | "google"
  | "reminder"
  | "payment"
  | "publishing"
  | "waiting"

export type LineState = "working" | "done" | "failed"

/**
 * Who is speaking, and what picks a variant: `seed` is a message id in chat
 * and the org in the panel (a segment adds its own id), so a line never
 * changes within a turn or between polls. `earlier` holds the seeds of the
 * conversation's earlier turns, oldest first, so a line never reads the same
 * as the turn before.
 */
export type CopyContext = {
  seed: string
  earlier?: readonly string[] | undefined
  assistant?: string | null
}

/** Collapses whitespace and swaps dashes, which no line carries, for a comma. */
const tidy = (text: string) =>
  text
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const uncap = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

/** The name the owner gave the assistant, or null before they have given one. */
const named = (assistant?: string | null) => {
  const name = assistant ? tidy(assistant) : ""
  return name || null
}

/** "Ellie is building your website", or "Building your website" when there is no name. */
const is = (assistant: string | null, rest: string) =>
  assistant ? `${assistant} is ${rest}` : cap(rest)

/** What a stopped job leaves to the owner: nothing runs until they ask. */
const askAgain = (assistant: string | null) =>
  `Ask ${assistant ?? "your assistant"} to try again`

/** A stable 32 bit hash (FNV-1a), so the same seed always reads the same variant. */
function hash(text: string) {
  let h = 0x811c9dc5
  for (const char of text) {
    h ^= char.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * A variant by the seed. Each earlier turn's pick is worked out in order, and
 * a turn that would read as the one before moves to the next variant, so no
 * two turns in a row read alike.
 */
const pick = <T>(ctx: CopyContext, key: string, variants: readonly T[]) => {
  const n = variants.length
  let at = -1
  for (const seed of [...(ctx.earlier ?? []), ctx.seed]) {
    const raw = hash(`${seed}:${key}`) % n
    at = raw === at ? (raw + 1) % n : raw
  }
  return variants[at] as T
}

/**
 * Where a gap in the catalogue is reported: a name the table does not know,
 * or a known one that fell below its own line. A warning in development, so
 * gaps are found; silent in production, where the fallback line is enough.
 */
export function reportCopyGap(where: string, name: string) {
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    console.warn(`[copy] no line for ${where} "${name}"`)
  }
}

const ARG_MAX = 32
// What must never reach the owner as an argument: ids, hashes, enums, staff codes.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const HEX_RUN = /[0-9a-f]{7,}/i
const ENUM = /^[a-z0-9]+(?:_[a-z0-9]+)+$/
const STAFF_CODE = /\b[A-Z]{3}-\d{3}\b/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)+$/

/**
 * Cleans the one argument a line may carry. Whitespace collapses; a URL
 * becomes its domain and a slug a page name; text is cut at 32 characters
 * with an ellipsis. An id, hash, raw value or staff code gives null, and the
 * line is written without an argument.
 */
export function cleanArg(
  raw: string | null | undefined,
  kind: "text" | "domain" | "page" = "text",
  max = ARG_MAX
): string | null {
  const text = tidy(raw ?? "")
  if (!text) return null
  if (kind === "domain") {
    const host = text
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .split(/[/?#\s]/)[0]
    return host ? host.toLowerCase().slice(0, 253) : null
  }
  if (UUID.test(text) || HEX_RUN.test(text) || STAFF_CODE.test(text))
    return null
  if (ENUM.test(text)) return null
  const words =
    kind === "page" && SLUG.test(text) ? cap(text.replace(/-/g, " ")) : text
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words
}

/** How long a job has run, in the units an owner thinks in. */
export const elapsedText = (seconds: number) =>
  seconds < 60 ? "Under a minute" : plural(Math.floor(seconds / 60), "minute")

/**
 * How long a build takes, as a range in whole minutes rounded outward: the
 * lane's p50 is the low end and its p95 the high ("about 6 to 10 minutes").
 * Once the time passes the top, the range moves up to start above it, never
 * quoting a time already gone.
 */
export function rangeText(
  usualSeconds: number,
  lateSeconds: number,
  elapsedSeconds?: number
) {
  let low = Math.max(1, Math.floor(usualSeconds / 60))
  let high = Math.max(low + 1, Math.ceil(lateSeconds / 60))
  const longer = elapsedSeconds !== undefined && elapsedSeconds > high * 60
  if (longer) {
    const width = Math.max(2, high - low)
    low = Math.floor(elapsedSeconds / 60) + 1
    high = low + width
  }
  return { text: `about ${low} to ${high} minutes`, longer }
}

// ---------------------------------------------------------------------------
// Moments: the assistant's own lines, which name her.

/**
 * Seconds with no news after which the waiting line moves on, so what it
 * says stays true: more time has passed.
 */
export const WORKING_AFTER = 4
export const STILL_AFTER = 12
export const LATE_AFTER = 30

/** The icon for `turnMoment`'s line at the same moment, so the picture changes with the words. */
export const turnKind = (elapsedSeconds: number): StatusKind =>
  elapsedSeconds >= STILL_AFTER
    ? "still"
    : elapsedSeconds >= WORKING_AFTER
      ? "writing"
      : "reading"

/**
 * A turn with no news: reading, working on it, still working, then longer
 * than usual, never a time. Never "thinking": most turns run with no
 * reasoning, and a real one shows its own line. Never "putting a reply
 * together" either: a tool's line may still follow, and the reply line
 * would then read backwards; `writingBack` says it once tools have run.
 */
const MOMENTS = {
  reading: ["reading your message", "looking at your message"],
  working: ["looking into it", "working on it", "working out what to do"],
  still: ["still working on it", "still on it"],
  late: ["taking longer than usual", "taking a little longer than usual"],
} as const

export function turnMoment(elapsedSeconds: number, ctx: CopyContext) {
  const moment =
    elapsedSeconds >= LATE_AFTER
      ? "late"
      : elapsedSeconds >= STILL_AFTER
        ? "still"
        : elapsedSeconds >= WORKING_AFTER
          ? "working"
          : "reading"
  return is(named(ctx.assistant), pick(ctx, `turn:${moment}`, MOMENTS[moment]))
}

/**
 * A turn's line before its first word: its latest status (an onboarding
 * step, a fact noted, the next move) while it is fresh, then how long it
 * has stood, so the words change only when something did.
 */
export const waitingLine = (
  on: OnboardingStatus["on"] | null,
  seconds: number,
  ctx: CopyContext
): { kind: StatusKind; label: string } =>
  on && seconds < STILL_AFTER
    ? { kind: onboardingKind(on), label: onboardingLine(on) }
    : { kind: turnKind(seconds), label: turnMoment(seconds, ctx) }

/** A turn a reload cut off, still running: its reply comes when it lands. */
export const resumingLine = (ctx: CopyContext) =>
  is(named(ctx.assistant), "still on your last message")

/** Writing a reply after tools ran, so it follows their lines in order. */
export const writingBack = (ctx: CopyContext) =>
  is(
    named(ctx.assistant),
    pick(ctx, "turn:writing", [
      "writing back",
      "putting a reply together",
      "writing your reply",
    ])
  )

/** The first line of a long job in Now, before the bare stages. */
export const planningLine = (ctx: CopyContext) =>
  is(named(ctx.assistant), "planning your website")

const CHANGE_ASKED_MAX = 100

/** The line a change asked for in the panel leaves in the chat: their words, clipped. */
export function changeAsked(text: string) {
  const words = tidy(text)
  const clipped =
    words.length > CHANGE_ASKED_MAX
      ? `${words.slice(0, CHANGE_ASKED_MAX - 1).trimEnd()}…`
      : words
  return `Asked for changes: ${clipped}`
}
/** Under that line: where the result will turn up. */
export const CHANGE_ASKED_NEXT =
  "Your new version will show here when it's ready."

/** The model's own reasoning, folded under one line. */
export const reasoningLine = (working: boolean) =>
  working ? "Thinking it through" : "Thought it through"

/**
 * The version card once the owner said publish, held until the assistant's
 * live message lands: at work at once, then published while the load check
 * runs, so the chat is never silent in between. A check still going after the
 * usual time (`late`) says so, and that the owner will hear.
 */
export const publishLine = (published: boolean, live = false, late = false) =>
  live
    ? "Published, your website is live"
    : published && late
      ? "Your website is taking longer than usual to come online. I'll tell you when it's live"
      : published
        ? "Published, checking your website loads"
        : "Approved, publishing your website"

/** Several quiet reads folded into one line. */
export const groupLine = (count: number, working: boolean) =>
  `${working ? "Checking" : "Checked"} ${plural(count, "thing")}`

// ---------------------------------------------------------------------------
// CoS tools: each line from one table, in every state a tool part can be
// in. The set is closed and the model writes none of them.

export type ToolArgs = {
  /** A domain or a URL; shown as a domain. */
  domain?: string
  /** What the owner asked to search for. */
  query?: string
  /** A time, already formatted in the business zone. */
  when?: string
  count?: number
  /** The line the model wrote, for a tool in `STEPPED`. */
  step?: string | undefined
}

type Cleaned = {
  domain: string | null
  query: string | null
  when: string | null
  count?: number | undefined
}

/**
 * One way to say a line: plain words, or words around the call's argument,
 * which give null without it so the line falls back to the plain ones.
 */
type Say = string | ((a: Cleaned) => string | null)

type ToolCopy = {
  kind: StatusKind
  /** While it runs. "Still", "Stopped" and "Didn't finish" are made from these. */
  working: readonly Say[]
  done: readonly Say[]
  /** What failed, after "Couldn't". */
  fail: readonly Say[]
  /** Overrides for a phase whose made line would mislead. */
  stopped?: readonly Say[]
  cut?: readonly Say[]
}

const withArg =
  (field: "domain" | "query", line: (arg: string) => string) =>
  (a: Cleaned) => {
    const arg = a[field]
    return arg ? line(arg) : null
  }
const onDomain = (line: (d: string) => string) => withArg("domain", line)

const TOOLS: Record<CosToolName, ToolCopy> = {
  get_workspace: {
    kind: "checking",
    working: [
      "Checking where things stand",
      "Looking over where things stand",
      "Catching up on where things are",
    ],
    done: ["Checked where things stand"],
    fail: ["check where things stand"],
  },
  get_facts: {
    kind: "checking",
    working: [
      "Looking up your details",
      "Checking your business details",
      "Going over your details",
    ],
    done: ["Found your details"],
    fail: ["look up your details"],
  },
  get_preview: {
    kind: "checking",
    working: ["Checking the preview", "Looking at your preview"],
    done: ["Checked the preview"],
    fail: ["check the preview"],
  },
  request_change: {
    kind: "building",
    working: [
      "Passing on your change",
      "Getting your change started",
      "Sending your change to be made",
    ],
    done: ["Passed on your change", "Started your change"],
    fail: ["pass on your change"],
  },
  answer_question: {
    kind: "building",
    working: ["Passing on your answer", "Sending your answer on"],
    done: ["Passed on your answer"],
    fail: ["pass on your answer"],
  },
  create_reminder: {
    kind: "reminder",
    working: ["Setting a reminder", "Adding a reminder"],
    done: [
      (a) => (a.when ? `Reminder set for ${a.when}` : null),
      "Reminder set",
    ],
    fail: ["set the reminder"],
  },
  update_reminder: {
    kind: "reminder",
    working: ["Changing the reminder"],
    done: ["Changed the reminder"],
    fail: ["change the reminder"],
  },
  delete_reminder: {
    kind: "reminder",
    working: ["Removing the reminder"],
    done: ["Removed the reminder"],
    fail: ["remove the reminder"],
  },
  set_time_zone: {
    kind: "thinking",
    working: ["Setting your time zone"],
    done: ["Changed your time zone"],
    fail: ["set your time zone"],
  },
  record_review: {
    kind: "building",
    working: ["Adding the review", "Saving the review"],
    done: ["Added the review"],
    fail: ["add the review"],
  },
  domain_bought: {
    kind: "domain",
    working: [onDomain((d) => `Looking for ${d}`), "Looking for your domain"],
    done: [onDomain((d) => `Looked for ${d}`), "Looked for your domain"],
    fail: [onDomain((d) => `look for ${d}`), "look for your domain"],
  },
  inspect_domain: {
    kind: "domain",
    working: [
      onDomain((d) => `Looking up ${d}`),
      onDomain((d) => `Finding out about ${d}`),
      "Looking up your domain",
    ],
    done: [onDomain((d) => `Looked up ${d}`), "Looked up your domain"],
    fail: [onDomain((d) => `look up ${d}`), "look up your domain"],
  },
  check_domain: {
    kind: "domain",
    working: [
      onDomain((d) => `Checking ${d}`),
      onDomain((d) => `Checking the records for ${d}`),
      "Checking your domain",
      "Checking your DNS",
    ],
    done: [onDomain((d) => `Checked ${d}`), "Checked your domain"],
    fail: [onDomain((d) => `check ${d}`), "check your domain"],
    // This one check, never the watch on the domain, which goes on.
    stopped: [
      onDomain((d) => `Stopped this check of ${d}`),
      "Stopped this check of your domain",
    ],
    cut: [
      onDomain((d) => `Didn't finish this check of ${d}`),
      "Didn't finish this check of your domain",
    ],
  },
  connect_domain: {
    kind: "domain",
    working: [
      onDomain((d) => `Connecting ${d}`),
      onDomain((d) => `Getting ${d} connected`),
      "Connecting your domain",
    ],
    done: [
      onDomain((d) => `Started connecting ${d}`),
      "Started connecting your domain",
    ],
    fail: [onDomain((d) => `connect ${d}`), "connect your domain"],
  },
  remove_domain: {
    kind: "domain",
    working: [onDomain((d) => `Removing ${d}`), "Removing your domain"],
    done: [onDomain((d) => `Removed ${d}`), "Removed your domain"],
    fail: [onDomain((d) => `remove ${d}`), "remove your domain"],
  },
  find_domain: {
    kind: "domain",
    working: [
      withArg("query", (q) => `Searching for ${q}`),
      withArg("query", (q) => `Looking for names like ${q}`),
      "Searching for a domain",
      "Looking for a free name",
    ],
    done: [
      (a) =>
        a.count === undefined
          ? null
          : a.count === 0
            ? "Found no free names"
            : `Found ${plural(a.count, "name")}`,
      "Found some names",
    ],
    fail: ["search for names"],
  },
  buy_domain: {
    kind: "payment",
    working: [
      onDomain((d) => `Getting ${d} ready to buy`),
      "Getting the domain ready to buy",
    ],
    done: [
      onDomain((d) => `Got ${d} ready for payment`),
      "Got the domain ready for payment",
    ],
    fail: [onDomain((d) => `get ${d} ready`), "get the domain ready"],
  },
  connect_google: {
    kind: "google",
    working: ["Connecting Google", "Getting Google connected"],
    done: ["Opened Google sign-in"],
    fail: ["connect Google"],
  },
  get_search_performance: {
    kind: "google",
    working: ["Checking your Google results", "Looking at your Google numbers"],
    done: ["Checked your Google results"],
    fail: ["check your Google results"],
  },
  get_indexing: {
    kind: "google",
    working: ["Checking your pages on Google", "Seeing which pages Google has"],
    done: ["Checked your pages on Google"],
    fail: ["check your pages on Google"],
  },
  remember: {
    kind: "thinking",
    working: ["Noting that down", "Making a note of that"],
    done: ["Noted that down"],
    fail: ["note that down"],
  },
  put_off: {
    kind: "thinking",
    working: ["Noting that for later", "Keeping that for later"],
    done: ["Noted that for later"],
    fail: ["note that for later"],
  },
  offer_grant: {
    kind: "thinking",
    working: ["Saving your choice"],
    done: ["Saved your choice"],
    fail: ["save your choice"],
  },
  read_skill: {
    kind: "thinking",
    working: ["Going over how I do this", "Checking my notes on this"],
    done: ["Checked my notes on this"],
    fail: ["go over my notes"],
  },
  save_correction: {
    kind: "thinking",
    working: ["Noting that for your website", "Making a note for your site"],
    done: ["Noted that for your website"],
    fail: ["note that for your website"],
  },
  schedule_skill: {
    kind: "reminder",
    working: ["Setting up your weekly round-up"],
    done: ["Updated your weekly round-up"],
    fail: ["set up your weekly round-up"],
  },
}

/** What a tool's line says, whatever the part's state, the turn's end or the time. */
export type Phase =
  | "working"
  /** Working past `STILL_AFTER`. */
  | "still"
  /** A card waiting on the owner's yes. */
  | "waiting"
  | "done"
  | "failed"
  /** Cancelled: the owner sent a new message first. */
  | "stopped"
  /** The stream ended without its result: it may have run on. */
  | "cut"
  /** The owner said no. */
  | "denied"

/** How deep the line had to fall, for `reportCopyGap` and the tests. */
export type Level = "specific" | "plain" | "kind" | "universal"

/** The last line of all, one per phase. */
const UNIVERSAL: Record<Phase, string> = {
  working: "Working on it",
  still: "Still working on it",
  waiting: "Ready for your yes",
  done: "Done",
  failed: "Couldn't finish that",
  stopped: "Stopped",
  cut: "Stopped",
  denied: "Left as it was",
}

/**
 * A kind's own line where a tool has none of its own: a card waiting on the
 * owner's yes, or their no. Every other phase is the tool's own. A tool the
 * table does not know has no kind either, so it reads the universal line.
 */
const KIND_LINES: Partial<Record<StatusKind, Partial<Record<Phase, string>>>> =
  {
    reminder: {
      waiting: "Reminder ready to add",
      denied: "Reminder not added",
    },
    domain: {
      waiting: "Ready for your yes on your domain",
      denied: "Left your domain as it was",
    },
    payment: {
      waiting: "Ready for your payment",
      denied: "Didn't buy the domain",
    },
    google: {
      waiting: "Ready to connect Google",
      denied: "Left Google unconnected",
    },
    building: { denied: "Left your website as it was" },
  }

const FAIL_TOOL = "try again in a moment"
const FAIL_STAGE = "You can try again from here."

/** Each line of a list turned into another phase's. */
const remade = (says: readonly Say[], line: (text: string) => string) =>
  says.map((say) =>
    typeof say === "string"
      ? line(say)
      : (a: Cleaned) => {
          const text = say(a)
          return text && line(text)
        }
  )

/** A phase's lines from a tool's table row; null where the row has none. */
const sayings = (copy: ToolCopy, phase: Phase): readonly Say[] | null => {
  switch (phase) {
    case "working":
    case "done":
      return copy[phase]
    case "still":
      return remade(copy.working, (t) => `Still ${uncap(t)}`)
    case "failed":
      return remade(copy.fail, (t) => `Couldn't ${t}, ${FAIL_TOOL}`)
    case "stopped":
      return copy.stopped ?? remade(copy.working, (t) => `Stopped ${uncap(t)}`)
    case "cut":
      return (
        copy.cut ?? remade(copy.working, (t) => `Didn't finish ${uncap(t)}`)
      )
    default:
      return null
  }
}

/**
 * The slow reads whose call carries a line the model wrote (`step`), which
 * replaces their fixed one while they run.
 */
export const STEPPED: ReadonlySet<string> = new Set([
  "find_domain",
  "check_domain",
  "inspect_domain",
  "get_search_performance",
  "get_indexing",
])

/** The line the model wrote for a call of `tool`, cleaned like any argument, or null. */
export const stepText = (tool: string, step: string | undefined) =>
  STEPPED.has(tool) ? cleanArg(step, "text", 60) : null

const clean = (a: ToolArgs): Cleaned => ({
  domain: cleanArg(a.domain, "domain"),
  query: cleanArg(a.query),
  when: cleanArg(a.when, "text", 40),
  count: a.count,
})

const known = (tool: string): tool is CosToolName => Object.hasOwn(TOOLS, tool)

/**
 * A tool's line in a phase, falling through its argument, its plain words,
 * its kind and the universal line. Never empty, never the tool's name.
 */
export function toolSay(
  tool: string,
  phase: Phase,
  args: ToolArgs = {},
  ctx: CopyContext = { seed: "" }
): { text: string; level: Level } {
  const copy = known(tool) ? TOOLS[tool] : null
  const says = copy && sayings(copy, phase)
  const a = clean(args)
  const step = phase === "working" ? stepText(tool, args.step) : null
  if (step) return { text: step, level: "specific" }
  // The same pick for every phase, so a line and its "Still" agree.
  const key = `tool:${tool}`
  if (says) {
    const argued = says.flatMap((say) =>
      typeof say === "function" ? (say(a) ?? []) : []
    )
    if (argued.length)
      return { text: pick(ctx, key, argued), level: "specific" }
    const plain = says.filter((say): say is string => typeof say === "string")
    if (plain.length) return { text: pick(ctx, key, plain), level: "plain" }
  }
  // Waiting and denied read as the kind's: the card says the rest. Anything
  // else here is a gap: a name the table does not know.
  if (!copy || (phase !== "waiting" && phase !== "denied"))
    reportCopyGap("tool", tool)
  const kind = copy && KIND_LINES[copy.kind]?.[phase]
  return kind
    ? { text: kind, level: "kind" }
    : { text: UNIVERSAL[phase], level: "universal" }
}

/** A tool's line: `toolSay`'s words alone. */
export const toolLine = (
  tool: string,
  phase: Phase,
  args: ToolArgs = {},
  ctx?: CopyContext
) => toolSay(tool, phase, args, ctx).text

/** Every state the AI SDK gives a tool part. */
export const PART_STATES = [
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
] as const
export type PartState = (typeof PART_STATES)[number]

/**
 * Where the turn stands: still running, or how it ended. `cancelled` is the
 * owner sending a new message, `aborted` the stream ending early (a reload,
 * Stop, a dropped connection).
 */
export const TURN_ENDS = [
  "running",
  "finished",
  "cancelled",
  "aborted",
  "errored",
  "timeout",
] as const
export type TurnEnd = (typeof TURN_ENDS)[number]

/**
 * The phase a part's line is in. A result or a no is final; a card waiting
 * on the owner waits until they answer or move on; anything else is at work
 * only while the turn runs, and once it is over it is stopped, failed or
 * left without its result. Nothing works after its turn.
 */
export function partPhase(
  state: PartState,
  turn: TurnEnd,
  elapsedSeconds = 0
): Phase {
  if (state === "output-available") return "done"
  if (state === "output-error") return "failed"
  if (state === "output-denied") return "denied"
  if (turn === "cancelled") return "stopped"
  if (state === "approval-requested") return "waiting"
  if (turn === "running")
    return elapsedSeconds >= STILL_AFTER ? "still" : "working"
  if (turn === "errored" || turn === "timeout") return "failed"
  return "cut"
}

/** The state a status line draws for a phase: its icon and motion. */
export const phaseState = (phase: Phase): StatusState =>
  phase === "still"
    ? "working"
    : phase === "cut" || phase === "denied"
      ? "stopped"
      : phase

// ---------------------------------------------------------------------------
// Build stages: the six every full build lists, from its first event.

export type BuildStage =
  | "planning"
  | "photos"
  | "writing"
  | "polishing"
  | "checking"
  | "ready"

type StageArgs = {
  /** Photos or pages finished, and how many there are. */
  done?: number
  total?: number
  /** Pages being written now. */
  working?: number
  /** The written pages' names, in the plan's order. */
  written?: readonly string[]
  /** Things the checks found and the build is fixing. */
  fixes?: number
}

/**
 * The pages as they are written: the first writer alone, then several at
 * once, then what is done and what is left, naming up to two done pages.
 */
function writingLine(a: StageArgs) {
  const { total, done = 0, working = 0, written = [] } = a
  if (!total) return "Writing the pages"
  if (done >= total) return "Putting the pages together"
  if (done === 0) {
    if (working > 1) return `Writing ${working} pages at once`
    return `Writing ${plural(total, "page")}`
  }
  const finished =
    written.length === done && done <= 2
      ? written.join(" and ")
      : plural(done, "page")
  return `${finished} ${done === 1 ? "is" : "are"} done, ${total - done} to go`
}

type StageCopy = {
  kind: StatusKind
  working: (a: StageArgs) => string
  done: (a: StageArgs) => string
  fail: string
}

/** Keyed and ordered as the api's stage ids (`apps/api/src/workspace.ts`). */
const STAGES: Record<BuildStage, StageCopy> = {
  planning: {
    kind: "planning",
    working: () => "Planning your website",
    done: () => "Planned your website",
    fail: "plan your website",
  },
  photos: {
    kind: "photos",
    working: (a) =>
      a.total
        ? `Making ${plural(a.total, "photo")}, ${a.done ?? 0} done`
        : "Making your photos",
    done: (a) =>
      a.total ? `Made ${plural(a.total, "photo")}` : "Made your photos",
    fail: "make your photos",
  },
  writing: {
    kind: "writing",
    working: writingLine,
    done: (a) =>
      a.total ? `Wrote ${plural(a.total, "page")}` : "Wrote the pages",
    fail: "finish the pages",
  },
  polishing: {
    kind: "polishing",
    working: () => "Polishing the details",
    done: () => "Polished the details",
    fail: "finish polishing",
  },
  checking: {
    kind: "checking",
    working: (a) =>
      a.fixes
        ? `Fixing ${plural(a.fixes, "thing")} the checks found`
        : "Checking every page",
    done: () => "Checked the pages",
    fail: "finish the checks",
  },
  ready: {
    kind: "publishing",
    working: () => "Getting your website ready",
    done: () => "Finished, ready to look over",
    fail: "get your website ready",
  },
}

/** A build stage's line in one of its three forms. A failed build stops, so its line offers a new try, never a retry. */
export function stageLine(
  stage: BuildStage,
  state: LineState,
  args: StageArgs = {}
) {
  const copy = STAGES[stage]
  return state === "working"
    ? copy.working(args)
    : state === "done"
      ? copy.done(args)
      : `Couldn't ${copy.fail}. ${FAIL_STAGE}`
}

export const stageKind = (stage: BuildStage): StatusKind => STAGES[stage].kind

// ---------------------------------------------------------------------------
// Onboarding: the step a turn starts on, then the plan's own keys as they
// close in the stream (the api sends a key, never a word).

/** Each step as the owner would name it, after "Noting" or "Looking at". */
const FACT_TOPIC: Record<PlanFactKey, string> = {
  "business.name": "your business name",
  "business.phone": "your phone number",
  "business.email": "your email address",
  "hours.weekday": "your opening hours",
  "service_area.radius": "how far you travel",
  "business.tagline": "your tagline",
  "business.industry": "what you do",
  "business.offerings": "your services",
  "business.audience": "who you work for",
  "business.overview": "how you work",
  "business.proof": "what sets you apart",
  "business.disclaimer": "your regulatory notice",
  "service_area.text": "where you work",
  "business.prices": "your prices",
  "business.enquiries": "how enquiries reach you",
  "owner.priorities": "your priorities",
  "assistant.name": "your assistant's name",
  "assistant.pronouns": "your assistant's pronouns",
  "assistant.tone": "the tone you want",
  "owner.preferred_name": "what to call you",
  "site.build_mode": "who builds your website",
  "site.template": "your website layout",
  "site.palette": "your colours",
  "site.font": "your lettering",
  "site.direction": "your page arrangement",
  "site.pages": "your website pages",
}
const TOPIC: Record<OnboardingStep, string> = {
  ...FACT_TOPIC,
  industry: FACT_TOPIC["business.industry"],
  pronouns: FACT_TOPIC["assistant.pronouns"],
  tone: FACT_TOPIC["assistant.tone"],
  build_for_me: FACT_TOPIC["site.build_mode"],
  manual_builder: FACT_TOPIC["site.build_mode"],
  template: FACT_TOPIC["site.template"],
  palette: FACT_TOPIC["site.palette"],
  font: FACT_TOPIC["site.font"],
  pages: FACT_TOPIC["site.pages"],
  contact: "your phone and email",
  assistant: "your assistant's details",
  quote_form: "your quote questions",
  design: "your design choices",
  upload: "your photos",
}

/** Kept word for word as given, so saved rather than noted. */
const SAVED: readonly OnboardingStep[] = [
  "business.name",
  "business.phone",
  "business.email",
  "assistant.name",
]

/** "Noting your services" once given, "Looking at your services" while a reply about them is read. */
const stepLine = (step: OnboardingStep, given: boolean) => {
  const topic = TOPIC[step]
  if (!topic) reportCopyGap("onboarding step", step)
  return `${!given || step === "upload" ? "Looking at" : SAVED.includes(step) ? "Saving" : "Noting"} ${topic ?? "your answer"}`
}

const NEXT_LINE: Record<
  Extract<OnboardingStatus["on"], { kind: "next" }>["next"],
  string
> = {
  ask_open: "Getting the next question ready",
  ask_choice: "Getting your options ready",
  ask_design: "Getting the design questions ready",
  ask_fact: "Getting the next question ready",
  ask_details: "Getting the next question ready",
  ask_upload: "Getting the photo upload ready",
  review_quote_form: "Drafting your quote requirements",
  start_build: "Getting ready to build",
  answer_only: "Working on your answer",
}

/** A typed message's line, true at any step. */
const READING_LINE: Record<MessageReading, string> = {
  answer: "Looking at your answer",
  change: "Looking at what you'd like to change",
  question: "Looking into your question",
}

/**
 * A status's line. The planner's `doing` and a reasoning heading carry model
 * text, which is never shown: they read as the catalogue's own lines.
 */
export const onboardingLine = (on: OnboardingStatus["on"]) =>
  on.kind === "doing"
    ? NEXT_LINE.answer_only
    : on.kind === "thinking"
      ? reasoningLine(true)
      : on.kind === "step"
        ? stepLine(on.step, on.answered)
        : on.kind === "reading"
          ? READING_LINE[on.about]
          : on.kind === "fact"
            ? stepLine(on.key, true)
            : (NEXT_LINE[on.next] ?? UNIVERSAL.working)

const NEXT_KIND: Record<
  Extract<OnboardingStatus["on"], { kind: "next" }>["next"],
  StatusKind
> = {
  ask_open: "question",
  ask_choice: "question",
  ask_design: "question",
  ask_fact: "question",
  ask_details: "question",
  ask_upload: "photos",
  review_quote_form: "writing",
  start_build: "building",
  answer_only: "writing",
}

/** The icon for `onboardingLine`: a reply being read, a thought, a fact noted down, or the move being made ready. */
export const onboardingKind = (on: OnboardingStatus["on"]): StatusKind =>
  on.kind === "next"
    ? NEXT_KIND[on.next]
    : on.kind === "thinking"
      ? "thinking"
      : on.kind === "reading" || (on.kind === "step" && !on.answered)
        ? "reading"
        : "planning"

// ---------------------------------------------------------------------------
// Segments: a title, a line under it and a done title, with the business and
// assistant names in them. Two or three variants per title, picked by a
// stable hash of the org id.

type JobKind =
  | "onboarding"
  | "website"
  | "golive"
  | "change"
  | "address"
  | "domain"
  | "purchase"
  | "google"

type Names = {
  assistant: string | null
  business: string | null
  /** What a change changes, in the owner's terms: "your hero title". */
  change: string | null
  domain: string | null
  /** The DNS host the owner changes records at. */
  provider: string | null
  /** The step at work or waiting, the furthest along: what the title is about now. */
  step: string | null
}

type JobCopy = {
  title: (n: Names) => readonly string[]
  /** The title while the job has not begun, when it differs from `title`. */
  next?: (n: Names) => readonly string[]
  /** The title while it waits on the owner, when it differs from `title`. */
  waiting?: (n: Names) => readonly string[]
  done: (n: Names) => readonly string[]
  /** What stopped, after "The" and before "stopped". */
  noun: string
  /** What the pill says while the job runs, after "{assistant} is". */
  pill: (n: Names) => string
}

const biz = (n: Names) => n.business ?? "Your business"
const domain = (n: Names) => n.domain ?? "the domain"
/** At the start of a line: a domain name keeps its case, the fallback is capitalised. */
const startDomain = (n: Names) => n.domain ?? "The domain"

const JOBS: Record<JobKind, JobCopy> = {
  onboarding: {
    title: (n) =>
      n.business
        ? [`Getting ${n.business} ready`, `Setting up ${n.business}`]
        : ["Getting started"],
    done: (n) => [
      `${biz(n)} is set up`,
      `Finished setting up ${n.business ?? "your business"}`,
    ],
    noun: "setup",
    pill: (n) => `getting to know ${n.business ?? "your business"}`,
  },
  website: {
    title: (n) => [
      is(n.assistant, "building your website"),
      is(n.assistant, "putting your website together"),
    ],
    next: () => ["Your website comes next", "Next, your website"],
    done: () => ["Your website is built", "Finished building your website"],
    noun: "website build",
    pill: () => "building your website",
  },
  golive: {
    title: () => ["Putting your website live", "Taking your website live"],
    next: () => ["Then it goes live", "Then your website goes live"],
    waiting: () => ["Your website is ready"],
    done: (n) => [`${biz(n)} is live`, `${biz(n)} is now live`],
    noun: "website launch",
    pill: () => "putting your website live",
  },
  change: {
    title: (n) => [is(n.assistant, `updating ${n.change ?? "your website"}`)],
    done: () => ["Your changes are made", "Finished making your changes"],
    noun: "update",
    pill: (n) => `updating ${n.change ?? "your website"}`,
  },
  address: {
    // By the step it is on, so a name being picked is not a domain going on.
    title: (n) =>
      n.step === "find_out" || n.step === "choose"
        ? ["Choosing your web address", "Picking a name for your website"]
        : n.step === "purchase" && n.domain
          ? [`Buying ${n.domain}`, `Getting ${n.domain}`]
          : n.domain
            ? [`Putting your website on ${n.domain}`, `Setting up ${n.domain}`]
            : ["Getting your own web address", "Setting up your web address"],
    next: () => ["Your own web address comes next", "Next, your own address"],
    done: (n) => [`${startDomain(n)} is live`, `${startDomain(n)} is working`],
    noun: "address setup",
    pill: (n) =>
      n.domain
        ? `putting your website on ${n.domain}`
        : "setting up your web address",
  },
  domain: {
    title: (n) => [
      `Connecting ${n.domain ?? "your domain"}`,
      `Setting up ${n.domain ?? "your domain"}`,
    ],
    done: (n) => [`${startDomain(n)} is live`, `${startDomain(n)} is working`],
    noun: "domain connection",
    pill: (n) => `connecting ${n.domain ?? "your domain"}`,
  },
  purchase: {
    title: (n) => [
      `Buying ${n.domain ?? "your domain"}`,
      `Getting ${n.domain ?? "your domain"}`,
    ],
    done: (n) => [
      `${startDomain(n)} is yours`,
      `${startDomain(n)} is registered`,
    ],
    noun: "purchase",
    pill: (n) => `buying ${n.domain ?? "your domain"}`,
  },
  google: {
    title: () => ["Connecting Google", "Linking your site to Google"],
    next: () => ["Your site on Google comes next", "Next, your site on Google"],
    done: () => ["Your site is on Google", "Your site is connected to Google"],
    noun: "Google connection",
    pill: () => "connecting Google",
  },
}

/**
 * The website's title while it is at work, by the stage it is on, so the
 * heading says what is happening now; two ways each, as the other titles.
 */
const WEBSITE_NOW: Partial<
  Record<BuildStage | "assembling", readonly string[]>
> = {
  planning: ["planning your website", "planning your pages"],
  photos: ["making your photos", "making photos for your website"],
  writing: ["writing your pages", "writing your website"],
  assembling: ["putting your pages together", "putting your website together"],
  polishing: ["polishing the design", "polishing your website"],
  checking: ["checking your site", "checking every page"],
}

/** The stage a website segment is on, with the pages all written read as putting them together. */
const websiteNow = (segment: ActivitySegment) => {
  const step = segment.steps.find((s) => s.state === "now")
  if (!step || !isStage(step.id)) return null
  const count = step.count
  return step.id === "writing" && count && count.done >= count.total
    ? "assembling"
    : step.id
}

/** What a waiting segment waits for, after "waiting for". */
const WAITING: Partial<Record<ActivitySegment["kind"], string>> = {
  onboarding: "your answer",
  golive: "your approval to publish",
  domain: "your DNS change",
  purchase: "your payment",
  google: "you to sign in",
  review: "your approval to publish",
  question: "your answer",
}

/** What an owner task waits for, by the step that waits. */
const STEP_WAITING: Readonly<Record<string, string>> = {
  find_out: "your answer",
  choose: "your choice of name",
  purchase: "your payment",
  records: "your DNS change",
  ownership: "your DNS change",
  sign_in: "you to sign in",
  permissions: "you to allow access",
  verify: "your help with Google",
}

/**
 * The step a segment is on: the furthest one at work or waiting. A step
 * further along proves an earlier one that still waits is past, so a name
 * chosen long ago never stands in for the DNS change waited on now.
 */
const currentStep = (segment: ActivitySegment) =>
  segment.steps
    .filter((s) => s.state === "now" || s.state === "waiting")
    .at(-1) ?? null

/** The step a task segment waits on, else null; other kinds name theirs by kind. */
const waitingStep = (segment: ActivitySegment) => {
  if (segment.kind !== "address" && segment.kind !== "google") return null
  const step = currentStep(segment)
  return step?.state === "waiting" ? step : null
}

const waitsFor = (segment: ActivitySegment) => {
  const step = waitingStep(segment)
  // Buying it elsewhere waits on the owner's own purchase, not a payment here.
  if (step?.id === "purchase" && step.note?.startsWith("buying ")) {
    return "you to buy it"
  }
  return STEP_WAITING[step?.id ?? ""] ?? WAITING[segment.kind]
}

const job = (segment: ActivitySegment) =>
  Object.hasOwn(JOBS, segment.kind) ? JOBS[segment.kind as JobKind] : null

const namesOf = (segment: ActivitySegment, ctx: CopyContext): Names => {
  const n = segment.names
  return {
    assistant: named(ctx.assistant),
    business: cleanArg(n?.business, "text", 60),
    change: cleanArg(n?.change, "text", 40),
    domain: cleanArg(n?.domain, "domain"),
    provider: cleanArg(n?.provider),
    step: currentStep(segment)?.id ?? null,
  }
}

/**
 * A segment's heading: its working title, its done title once done, and
 * "The {thing} stopped" when it failed. Null for a kind that is one row, not
 * a segment (reminders, check-ins, a turn).
 */
export function segmentTitle(segment: ActivitySegment, ctx: CopyContext) {
  const copy = job(segment)
  if (!copy) return null
  const n = namesOf(segment, ctx)
  if (segment.state === "failed") return `The ${copy.noun} stopped`
  if (segment.state === "upcoming" && copy.next) {
    return pick(ctx, `${segment.id}:next`, copy.next(n))
  }
  if (segment.state === "waiting" && copy.waiting) {
    return pick(ctx, `${segment.id}:waiting`, copy.waiting(n))
  }
  const done = segment.state === "done"
  const stage =
    segment.kind === "website" && segment.state === "now"
      ? websiteNow(segment)
      : null
  const now = stage ? WEBSITE_NOW[stage] : undefined
  if (now) {
    return is(n.assistant, pick(ctx, `${segment.id}:${stage}`, now))
  }
  return pick(
    ctx,
    `${segment.id}:${done ? "done" : "title"}`,
    done ? copy.done(n) : copy.title(n)
  )
}

type LineExtras = {
  elapsedSeconds?: number
  /** A time, already formatted in the business zone. */
  until?: string
  /** The DNS provider's name, when known. */
  provider?: string
  /** What stopped, for a failed segment. */
  why?: string
  /** A change's build row at work, such as "Checking the page". */
  doing?: string
}

/** The muted line under a segment's title, or null when it has none (done, upcoming). */
export function segmentLine(
  segment: ActivitySegment,
  ctx: CopyContext,
  extras: LineExtras = {}
): string | null {
  const copy = job(segment)
  if (!copy) return null
  const n = namesOf(segment, ctx)
  const { state } = segment
  if (state === "failed") {
    const next = askAgain(n.assistant)
    const why = cleanArg(extras.why, "text", 80)?.replace(/[.!]+$/, "")
    return why ? `${why}. ${next}` : next
  }
  if (state !== "now" && state !== "waiting") return null
  const waiting = state === "waiting"
  const elapsed =
    extras.elapsedSeconds === undefined
      ? null
      : `${elapsedText(extras.elapsedSeconds)} so far`
  const range =
    segment.usual_seconds === undefined
      ? null
      : rangeText(
          segment.usual_seconds,
          // An api older than the late time: the high end is half again.
          segment.late_seconds ?? segment.usual_seconds * 1.5,
          extras.elapsedSeconds
        )
  // The time so far, then what can be said of it: a restart or the lane's
  // range. Past the range's top the range alone says it, as it has to grow.
  // Nothing it cannot back.
  const said = segment.restarted
    ? `${n.assistant ?? "your assistant"} restarted it`
    : (range?.text ?? null)
  const timing =
    range?.longer && !segment.restarted
      ? `Taking a little longer, ${said}`
      : elapsed && said
        ? `${elapsed}, ${said}`
        : (elapsed ?? (said && cap(said)))
  switch (segment.kind as JobKind) {
    // The question at work says enough; no count of what is left.
    case "onboarding":
      return null
    case "website":
      return cleanArg(segment.step, "text", 60) ?? timing
    case "change": {
      // The step it is on, with the range beside it.
      const doing = cleanArg(segment.step ?? extras.doing, "text", 60)
      return doing && range
        ? `${doing}, ${range.longer ? "taking a little longer, " : ""}${range.text}`
        : (doing ?? timing)
    }
    case "golive":
      // Waiting, its one step says what it waits for.
      return waiting ? null : "Going live in a minute"
    case "address": {
      // The step's own note first: code wrote it for this wait.
      const step = waiting
        ? waitingStep(segment)
        : segment.steps.find((s) => s.state === "now")
      const note = waiting ? cleanArg(step?.note, "text", 80) : null
      if (note) return cap(note)
      if (step?.id === "purchase" && waiting) return payBy(extras)
      if ((step?.id === "records" || step?.id === "ownership") && waiting)
        return dnsChanges(segment, n.provider)
      return (step && ADDRESS_NOW[step.id]) ?? null
    }
    case "domain":
      return waiting
        ? dnsChanges(segment, cleanArg(extras.provider) ?? n.provider)
        : "The certificate is on its way"
    case "purchase":
      return waiting ? payBy(extras) : "Registering the name"
    case "google": {
      if (!waiting) return "Checking your site with Google"
      const step = waitingStep(segment)
      return (
        cleanArg(step?.note, "text", 80) ??
        (step?.id === "permissions"
          ? "Google needs one more permission"
          : "Google needs you to sign in again")
      )
    }
  }
}

/**
 * The DNS changes the owner has to make, at their provider by name: as many
 * as the connect card listed, carried as the records step's count, and no
 * number when the count is not known.
 */
const dnsChanges = (segment: ActivitySegment, provider: string | null) => {
  const total = segment.steps.find((s) => s.id === "records")?.count?.total
  const where = provider ?? "your DNS provider"
  if (!total) return `Changes to make at ${where}`
  return `${total === 1 ? "One change" : `${total} changes`} to make at ${where}`
}

/** A purchase waiting on payment, by when the name's hold ends. */
const payBy = (extras: LineExtras) => {
  const by = cleanArg(extras.until, "text", 40)
  return by ? `Pay by ${by} to keep the name` : "Pay soon to keep the name"
}

/** An address step at work, as the line under its title. */
const ADDRESS_NOW: Readonly<Record<string, string>> = {
  purchase: "Registering the name",
  records: "Setting up the records",
  ownership: "Checking the domain is yours",
  certificate: "The certificate is on its way",
  loads: "Checking your website loads on it",
}

/** The panel pill: "Ellie is building your website", or "Ellie is waiting for your payment". Null when nothing runs or waits. */
export function pillLine(segment: ActivitySegment, ctx: CopyContext) {
  const assistant = named(ctx.assistant)
  if (segment.state === "failed") {
    const copy = job(segment)
    return copy ? `The ${copy.noun} stopped` : null
  }
  if (segment.state === "waiting") {
    const what = waitsFor(segment)
    return what ? is(assistant, `waiting for ${what}`) : null
  }
  const copy = job(segment)
  if (segment.state !== "now" || !copy) return null
  return is(assistant, copy.pill(namesOf(segment, ctx)))
}

/** A waiting row under its segment: "Waiting for your payment, until 11:50". */
export function waitingRow(segment: ActivitySegment, until?: string) {
  const what = waitsFor(segment)
  if (!what) return null
  const by = cleanArg(until, "text", 40)
  return `Waiting for ${what}${by ? `, until ${by}` : ""}`
}

// ---------------------------------------------------------------------------
// Waiting on the owner: one list, from the workspace frame's activity, that
// the panel, Notifications, Tasks and the assistant's own view all read, so
// no two of them disagree about what needs the owner.

/** One thing waiting on the owner. A stable shape: the assistant's view reads it. */
export type OwnerWait = {
  /** The segment's id. */
  id: string
  kind: ActivitySegment["kind"]
  /** The step waited on, for a task (`records`, `purchase`, `sign_in`), else null. */
  step: string | null
  domain: string | null
  /** What it waits for, after "waiting for": "your DNS change". */
  what: string
  /** What to do, as a heading: "Make the DNS change for pebblewick.co.uk". */
  title: string
  since: string
  until: string | null
}

/** What the owner does, by the step that waits, as a heading. */
const WAIT_TITLES: Readonly<Record<string, (d: string | null) => string>> = {
  find_out: () => "Say which web address you want",
  choose: () => "Choose a name for your website",
  purchase: (d) => (d ? `Pay for ${d}` : "Pay for your domain"),
  payment: (d) => (d ? `Pay for ${d}` : "Pay for your domain"),
  records: (d) => (d ? `Make the DNS change for ${d}` : "Make your DNS change"),
  ownership: (d) =>
    d ? `Make the DNS change for ${d}` : "Make your DNS change",
  dns: (d) => (d ? `Make the DNS change for ${d}` : "Make your DNS change"),
  sign_in: () => "Sign in to Google",
  permissions: () => "Give Google the permission it asks for",
  verify: () => "Help Google check your website",
}

/** The same by kind, for a wait with no step of its own. */
const WAIT_KIND_TITLES: Partial<Record<ActivitySegment["kind"], string>> = {
  onboarding: "Answer the setup question",
  golive: "Publish your website",
  review: "Review your changes",
  question: "Answer a question about your website",
}

/** A wait the tables have no title for: reported, and said plainly. */
const gapTitle = (kind: string, step: string | null) => {
  reportCopyGap("wait", `${kind}:${step}`)
  return "Something needs you"
}

/**
 * Every job waiting on the owner, the first run's included, each once and
 * oldest first: a version to publish, a question, a DNS change, a payment,
 * a sign-in. Due reminders are not here: they are due, not waited on.
 */
export function ownerWaits(activity: Activity | null | undefined): OwnerWait[] {
  if (!activity) return []
  const segments = [...activity.journey, ...activity.waiting].filter(
    (segment, i, all) =>
      segment.state === "waiting" &&
      all.findIndex((other) => other.id === segment.id) === i
  )
  return segments
    .map((segment): OwnerWait => {
      const waited =
        segment.kind === "address" || segment.kind === "google"
          ? waitingStep(segment)
          : segment.steps.find((s) => s.state === "waiting")
      const step = waited?.id ?? null
      const host = cleanArg(segment.names?.domain, "domain")
      // Buying it elsewhere waits on the owner's own purchase, not a payment here.
      const elsewhere =
        step === "purchase" && waited?.note?.startsWith("buying ")
      const title =
        (elsewhere ? `Buy ${host ?? "your domain"}` : null) ??
        WAIT_TITLES[step ?? ""]?.(host) ??
        WAIT_KIND_TITLES[segment.kind] ??
        gapTitle(segment.kind, step)
      return {
        id: segment.id,
        kind: segment.kind,
        step,
        domain: host,
        what: waitsFor(segment) ?? "you",
        title,
        since: segment.at,
        until: segment.deadline ?? null,
      }
    })
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
}

// ---------------------------------------------------------------------------
// Steps: the fixed steps of each segment kind, as the panel lists them. The
// api sends the ids; these are the words.

const STEP_LABELS: Partial<
  Record<ActivitySegment["kind"], Readonly<Record<string, string>>>
> = {
  onboarding: {
    work: "Services",
    area: "Service area",
    customers: "Customers",
    proof: "What sets you apart",
    contact: "Contact details",
    assistant: "Your assistant",
    website: "Website",
    quote_form: "Quote requirements",
    prices: "Your prices",
    day_to_day: "Your day to day",
    photos: "Photos",
    look: "Look and feel",
  },
  website: {
    planning: "Planning",
    photos: "Photos",
    writing: "Pages",
    polishing: "Polishing",
    checking: "Checking",
    ready: "Ready",
  },
  golive: {
    approval: "Your approval",
    publishing: "Publishing",
    loads: "Checking it loads",
  },
  change: {
    understanding: "Understanding the change",
    making: "Making it",
    checking: "Checking",
    ready: "Ready",
  },
  address: {
    find_out: "Your web address",
    choose: "Choosing a name",
    purchase: "Buying it",
    records: "Your DNS change",
    ownership: "Proving it's yours",
    certificate: "Certificate",
    loads: "Site loads on the new address",
  },
  domain: {
    dns: "Your DNS change",
    certificate: "Certificate",
    loads: "Site loads on the new address",
  },
  purchase: {
    details: "Your details",
    payment: "Payment",
    registration: "Registration",
    connecting: "Connecting",
  },
  google: {
    sign_in: "Sign in",
    permissions: "Permissions",
    verify: "Verifying your site",
    sitemap: "Sending your pages to Google",
    first_data: "Your first search numbers",
  },
}

const isStage = (id: string): id is BuildStage => Object.hasOwn(STAGES, id)

/** An onboarding step while it is asked: the question, not its name. */
const ONBOARDING_ASKS: Readonly<Record<string, string>> = {
  work: "What services do you offer?",
  area: "Where do you work?",
  customers: "Who are your customers?",
  proof: "What helps customers trust you?",
  contact: "How do customers reach you?",
  assistant: "What should your assistant be like?",
  website: "Would you like a website?",
  quote_form: "What do you need to know to quote?",
  prices: "What do your usual jobs cost?",
  day_to_day: "How do enquiries reach you?",
  photos: "Do you have photos to use?",
  look: "How should your website look?",
}

/**
 * A step's label. The website's step at work says what it is doing from its
 * count and, given its build row's `items`, which pages are written or at
 * work ("Home and Services are done, 5 to go") or the repair the checks
 * asked for; an onboarding step being asked is its question, and the
 * approval waited on says so; every other step, and one in a segment that
 * stopped, is its name.
 * Null for a step the table does not know, which the panel leaves out.
 */
export function stepLabel(
  segment: ActivitySegment,
  step: ActivityStep,
  items?: BuildActivity["items"]
) {
  const working = segment.state === "now" && step.state === "now"
  if (segment.kind === "website" && working && isStage(step.id)) {
    const fixing = step.id === "checking" && items?.find((i) => !i.done)
    if (fixing) return fixing.label
    return stageLine(step.id, "working", {
      ...step.count,
      ...(items && {
        working: items.filter((i) => i.working).length,
        written: items.filter((i) => i.done).map((i) => i.label),
      }),
    })
  }
  const asked = step.state === "now" || step.state === "waiting"
  if (segment.kind === "onboarding" && asked && ONBOARDING_ASKS[step.id]) {
    return ONBOARDING_ASKS[step.id]
  }
  if (segment.kind === "golive" && asked && step.id === "approval") {
    return "Waiting for your approval to publish"
  }
  return STEP_LABELS[segment.kind]?.[step.id] ?? null
}

/** What a skipped step says beside its label. */
export const SKIPPED = "Skipped"

const SEGMENT_KIND: Record<ActivitySegment["kind"], StatusKind> = {
  onboarding: "setup",
  website: "building",
  golive: "publishing",
  change: "building",
  address: "domain",
  domain: "domain",
  purchase: "payment",
  google: "google",
  reminder: "reminder",
  review: "waiting",
  question: "waiting",
  checkin: "checking",
  turn: "thinking",
}

/** The icon a segment's header draws. */
export const segmentKind = (segment: ActivitySegment): StatusKind =>
  SEGMENT_KIND[segment.kind]

/** The icon a step at work moves: a website stage's own, an onboarding question's, else its segment's. */
export const stepKind = (
  segment: ActivitySegment,
  step: ActivityStep
): StatusKind =>
  segment.kind === "website" && isStage(step.id)
    ? stageKind(step.id)
    : segment.kind === "onboarding"
      ? "question"
      : segmentKind(segment)

/** A finished job as a Completed row: what got done, in a few words. */
const COMPLETED: Record<JobKind, (n: Names) => string> = {
  onboarding: (n) => `${biz(n)} set up`,
  website: () => "Website built",
  golive: () => "Website published",
  change: () => "Website changes made",
  address: (n) => `${startDomain(n)} connected`,
  domain: (n) => `${startDomain(n)} connected`,
  purchase: (n) => `${startDomain(n)} registered`,
  google: () => "Connected to Google",
}

/** An owner task nothing has begun: the panel offers it as Up next. */
export const notStarted = (segment: ActivitySegment) =>
  (segment.kind === "address" || segment.kind === "google") &&
  segment.state === "upcoming" &&
  segment.steps.every((s) => s.state === "next")

/**
 * What a done step of an owner task proved, as the line under its Done row.
 * A step with no line here (finding out, choosing) earns no row of its own.
 */
const PROVED: Readonly<Record<string, (n: Names) => string>> = {
  purchase: (n) => `${startDomain(n)} is registered in your name`,
  records: (n) => `Your DNS points ${domain(n)} at your website`,
  ownership: (n) => `Ownership of ${domain(n)} is confirmed`,
  certificate: (n) => `The certificate for ${domain(n)} is active`,
  loads: (n) => `Your website loads at ${domain(n)}`,
  sign_in: () => "You signed in to Google",
  permissions: () => "Google can read your search data",
  verify: () => "Google confirmed the site is yours",
  sitemap: () => "Your pages were sent to Google",
  first_data: () => "Google sent its first search numbers",
}

/** The line an owner task's furthest done step earns, and when that step moved. */
export function proofOf(segment: ActivitySegment, ctx: CopyContext) {
  // A go-live segment has a "loads" step of its own, which proves something else.
  if (segment.kind !== "address" && segment.kind !== "google") return null
  const step = segment.steps
    .filter((s) => s.state === "done" && Object.hasOwn(PROVED, s.id))
    .at(-1)
  const line = step && PROVED[step.id]
  return step && line
    ? { text: line(namesOf(segment, ctx)), at: step.at }
    : null
}

/** The check-in sent the owner a message. */
const wroteToOwner = (segment: ActivitySegment) =>
  segment.steps.some((s) => s.id === "message" && s.state === "done")

/**
 * A one-line row in Coming up or Completed. A reminder is its own title,
 * which is the owner's text; a check-in says whether it needed the owner; a
 * bought domain's renewal names the domain; a finished job says what got
 * done. Null for a segment with nothing to say as a row.
 */
export function rowLine(
  segment: ActivitySegment,
  ctx: CopyContext,
  title?: string | null
): string | null {
  const assistant = named(ctx.assistant)
  if (segment.state === "done" && Object.hasOwn(COMPLETED, segment.kind)) {
    return COMPLETED[segment.kind as JobKind](namesOf(segment, ctx))
  }
  switch (segment.kind) {
    case "reminder":
      return title?.trim() ? reminderTitle(tidy(title)) : "A reminder"
    case "checkin": {
      if (segment.state === "upcoming") {
        return assistant ? `${assistant}'s next check-in` : "Next check-in"
      }
      const who = assistant ?? "Your assistant"
      return wroteToOwner(segment)
        ? `${who} checked in and messaged you`
        : `${who} checked in, all clear`
    }
    case "purchase":
      if (segment.state === "upcoming") {
        const name = cleanArg(segment.names?.domain, "domain")
        return name ? `${name} is due for renewal` : "Your domain renewal"
      }
      return segmentTitle(segment, ctx)
    case "google":
      // Signed in and sent, the one step left is Google's first numbers.
      return segment.state === "upcoming" &&
        segment.steps.some((s) => s.id === "sign_in" && s.state === "done")
        ? "Your first search numbers from Google"
        : segmentTitle(segment, ctx)
    default:
      return segmentTitle(segment, ctx)
  }
}

/** What waits in the tray, by the name its card docks under. */
const TRAY_ITEMS: Readonly<Record<string, string>> = {
  "ask-fact": "a question",
  "ask-details": "a question",
  "ask-choice": "a question",
  "ask-upload": "your photos",
  "ask-design": "your design questions",
  "build-questions": "your build's questions",
  "buy-domain": "your domain payment",
  "site-ready-tray": "your website to publish",
  "approval-request": "an approval",
  "answer-question": "an answer to send",
  "create-reminder": "a reminder",
  "record-review": "a review to save",
  "connect-domain": "a domain to connect",
  "remove-domain": "a domain to remove",
}

/** One item in the tray, in a few words: "a reminder". */
export function trayItem(name: string) {
  const item = TRAY_ITEMS[name]
  if (!item) reportCopyGap("tray item", name)
  return item ?? "something else"
}

/**
 * What else waits in the tray beside the item shown: "also a reminder", "also
 * 2 answers to send", "also a question and 2 more". Items of one kind count
 * together; a "your" item has one tray, so it never repeats.
 */
export function trayOthers(names: readonly string[]) {
  const counts = new Map<string, number>()
  for (const item of names.map(trayItem)) {
    counts.set(item, (counts.get(item) ?? 0) + 1)
  }
  const phrases = [...counts].map(([item, n]) =>
    n === 1 ? item : item.replace(/^an? (\w+)/, `${n} $1s`)
  )
  const [first, second] = phrases
  if (!first) return "nothing else"
  if (phrases.length === 1) return `also ${first}`
  return phrases.length === 2
    ? `also ${first} and ${second}`
    : `also ${first} and ${names.length - (counts.values().next().value ?? 1)} more`
}

/** A reminder's title as shown: the owner's words, with a capital to start. */
export const reminderTitle = (title: string) => cap(title.trim())

/** "Services, service area and customers", or "…, customers and 4 more". */
const listed = (labels: string[]) => {
  const words = labels.map((label, i) => (i ? label.toLowerCase() : label))
  if (words.length > 3) {
    return `${words.slice(0, 3).join(", ")} and ${words.length - 3} more`
  }
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
    : (words[0] ?? "")
}

/**
 * A finished row's one-line brief, for the Tasks page: what it covered or
 * what it means for the owner. Null when the row says it all.
 */
export function completedBrief(
  segment: ActivitySegment,
  ctx: CopyContext
): string | null {
  const n = namesOf(segment, ctx)
  const total = (id: string) =>
    segment.steps.find((s) => s.id === id)?.count?.total
  switch (segment.kind) {
    case "onboarding": {
      const labels = segment.steps.flatMap((s) =>
        s.state === "done" ? (STEP_LABELS.onboarding?.[s.id] ?? []) : []
      )
      return labels.length ? listed(labels) : null
    }
    case "website": {
      const pages = total("writing")
      const photos = total("photos")
      const made = [
        pages ? plural(pages, "page") : null,
        photos ? plural(photos, "photo") : null,
      ].filter((part) => part !== null)
      return made.length
        ? `${made.join(" and ")}, checked and ready`
        : "Planned, written and checked"
    }
    case "golive":
      return "Anyone can now visit your website"
    case "change":
      return cleanArg(segment.step, "text", 60) ?? "Made and checked"
    case "address":
    case "google":
      return proofOf(segment, ctx)?.text ?? null
    case "domain":
      return `Your website now loads at ${n.domain ?? "your domain"}`
    case "purchase":
      return "Registered in your name"
    case "checkin":
      return wroteToOwner(segment)
        ? "Sent you a message in the chat"
        : "Nothing needed you"
    case "reminder":
      return "Marked done"
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// The Website page: where the site stands, one line per thing. The page reads
// the same segments as the panel, so these lines say what the panel says.

/** The headings of the page's three kinds of row, and the lines that need no segment. */
export const PAGE_WORDS = {
  published: "Published",
  address: "Address",
  google: "Google",
  notPublished: "Not published yet",
  notConnected: "Not connected",
  afterLive: "Connect it once your website is live",
  afterDomain: "Connect it once your own domain is live",
} as const

type PageExtras = {
  /** When it went live, formatted in the reader's zone. */
  when?: string | undefined
  /** A bought domain's renewal date, formatted. */
  renews?: string | undefined
  /** When Google's data was last read, formatted in the reader's zone. */
  synced?: string | undefined
  /** When a payment wait ends, formatted. */
  until?: string | undefined
}

/** The domain steps at work, where the segment's own line says only the certificate. */
const DOMAIN_NOW: Readonly<Record<string, string>> = {
  certificate: "The certificate is on its way",
  loads: "Checking your website loads on it",
}

/**
 * The line under a standing row: a live publish, a domain, a purchase or the
 * Google connection, by where its segment stands. A segment that stopped says
 * so and what happens next.
 */
export function standingLine(
  segment: ActivitySegment,
  ctx: CopyContext,
  extras: PageExtras = {}
): string {
  const { kind, state } = segment
  if (state === "failed") {
    const noun = job(segment)?.noun ?? "setup"
    return `The ${noun} stopped. ${askAgain(named(ctx.assistant))}`
  }
  if (state === "waiting") {
    return waitingRow(segment, extras.until) ?? "Waiting for you"
  }
  if (state === "now") {
    const step = segment.steps.find((s) => s.state === "now")
    return (
      (kind === "domain" && step && DOMAIN_NOW[step.id]) ||
      segmentLine(segment, ctx) ||
      UNIVERSAL.working
    )
  }
  // Begun and paused between steps: what is proved so far, never "Live".
  if (state === "upcoming") {
    return proofOf(segment, ctx)?.text ?? "Not started yet"
  }
  switch (kind) {
    case "golive":
      return extras.when ? `Published ${extras.when}` : "Published"
    case "purchase":
      return extras.renews ? `Renews ${extras.renews}` : "Registered"
    case "address":
      return extras.renews ? `Live. Renews ${extras.renews}` : "Live"
    case "google": {
      const seen = segment.numbers
      if (seen) {
        const counts = `${plural(seen.clicks, "click")} and ${plural(seen.impressions, "appearance")} on Google in the last 28 days`
        return extras.synced ? `${counts}. Data read ${extras.synced}` : counts
      }
      return extras.synced
        ? `Verified, pages sent. Data read ${extras.synced}`
        : "Verified, pages sent. No data yet"
    }
    default:
      return "Live"
  }
}

/**
 * What a build is doing now, for the Website page: a change's own step line,
 * else the step at work ("Writing the pages, 3 of 6"). Null when no step is.
 */
export function workLine(segment: ActivitySegment): string | null {
  const step = segment.steps.find((s) => s.state === "now")
  return (
    (segment.kind === "change" && cleanArg(segment.step, "text", 60)) ||
    (step && stepLabel(segment, step)) ||
    null
  )
}

export type PageActionKey = "own" | "dns" | "pay" | "google" | "failed"

/**
 * A row's one next action: the button, and what the owner says to the
 * assistant when they press it. `subject` is the domain, or "Google".
 */
export function pageAction(key: PageActionKey, subject?: string | null) {
  const what = cleanArg(subject, "text", 60) ?? "my domain"
  switch (key) {
    case "own":
      return {
        label: "Use your own domain",
        ask: "I'd like to use my own domain",
      }
    case "dns":
      return {
        label: "Show the change",
        ask: `What do I change at my DNS provider for ${what}?`,
      }
    case "pay":
      return {
        label: "Continue to payment",
        ask: `Open the payment form for ${what}`,
      }
    case "google":
      return { label: "Connect Google", ask: "Connect Google to my website" }
    case "failed":
      return { label: "Ask what happened", ask: `What happened with ${what}?` }
  }
}
