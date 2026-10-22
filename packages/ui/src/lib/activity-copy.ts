import type {
  ActivitySegment,
  CosToolName,
  OnboardingStatus,
  PlanFactKey,
} from "@workspace/contracts"

/**
 * Every line the owner reads about work in progress, in one place: a CoS
 * tool's status, a build stage, an onboarding step, a segment's title and the
 * "{assistant} is ..." moments. The api sends state and names, never
 * sentences, and no model writes any of these, so the rules live here and one
 * test checks every template.
 *
 * Rules. A working line is a present participle, sentence case, 2 to 6
 * words, with no full stop and no ellipsis. A done line is past tense and
 * carries the result when there is one. A failed line starts "Couldn't" and
 * ends on the next step. A line holds one argument at most, cleaned by
 * `cleanArg`. The words are the owner's: "your website", "your DNS", never
 * "assignment", "revision" or "blueprint". The assistant's name is the
 * persona's and never "Reme": without one a line is written bare.
 */

/** What an icon is drawn for, so the status line picks its icon from the copy's own kind. */
export type StatusKind =
  | "thinking"
  | "planning"
  | "building"
  | "photos"
  | "checking"
  | "domain"
  | "google"
  | "reminder"
  | "payment"
  | "publishing"
  | "waiting"

export type LineState = "working" | "done" | "failed"

/** Who is speaking and for which business: `orgId` only picks a variant, so a title never changes between polls. */
export type CopyContext = { orgId: string; assistant?: string | null }

/** Collapses whitespace and swaps dashes, which no line carries, for a comma. */
const tidy = (text: string) =>
  text
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

/** The persona's name, or null before the owner has named one. "Reme" is never a persona. */
const named = (assistant?: string | null) => {
  const name = assistant ? tidy(assistant) : ""
  return name && name.toLowerCase() !== "reme" ? name : null
}

/** "Ellie is building your website", or "Building your website" when there is no name. */
const is = (assistant: string | null, rest: string) =>
  assistant ? `${assistant} is ${rest}` : cap(rest)

/** A stable 32 bit hash (FNV-1a), so the same org always reads the same variant. */
function hash(text: string) {
  let h = 0x811c9dc5
  for (const char of text) {
    h ^= char.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const pick = <T>(ctx: CopyContext, key: string, variants: readonly T[]) =>
  variants[hash(`${ctx.orgId}:${key}`) % variants.length] as T

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

// ---------------------------------------------------------------------------
// Moments: the assistant's own lines, which name her.

/** Seconds into a turn at which the line moves on. The wait says something true: more time has passed. */
export const THINKING_AFTER = 4
export const STILL_ON_IT_AFTER = 12

/** A turn before any tool or word: reading, then thinking it through, then still on it. */
export function turnMoment(
  elapsedSeconds: number,
  ctx: CopyContext,
  about: "message" | "answer" = "message"
) {
  const rest =
    elapsedSeconds >= STILL_ON_IT_AFTER
      ? "still on it"
      : elapsedSeconds >= THINKING_AFTER
        ? "thinking it through"
        : `reading your ${about}`
  return is(named(ctx.assistant), rest)
}

/** Writing a reply after tools ran. */
export const writingBack = (ctx: CopyContext) =>
  is(named(ctx.assistant), "writing back")

/** The first line of a long job in Now, before the bare stages. */
export const planningLine = (ctx: CopyContext) =>
  is(named(ctx.assistant), "planning your website")

// ---------------------------------------------------------------------------
// CoS tools: three forms each, from one table. The set is closed, so the
// model writes none of these.

type ToolArgs = {
  /** A domain or a URL; shown as a domain. */
  domain?: string
  /** What the owner asked to search for. */
  query?: string
  /** A time, already formatted in the business zone. */
  when?: string
  count?: number
  /** A change's own line, written by the model and cleaned here (SL3). */
  step?: string
}

type Cleaned = {
  domain: string | null
  query: string | null
  when: string | null
  count?: number
  step: string | null
}

type ToolCopy = {
  kind: StatusKind
  working: (a: Cleaned) => string
  done: (a: Cleaned) => string
  /** What failed, after "Couldn't". */
  fail: (a: Cleaned) => string
}

const withDomain = (
  a: Cleaned,
  withName: (d: string) => string,
  bare: string
) => (a.domain ? withName(a.domain) : bare)

const TOOLS: Record<CosToolName, ToolCopy> = {
  get_workspace: {
    kind: "checking",
    working: () => "Checking where things stand",
    done: () => "Checked where things stand",
    fail: () => "check where things stand",
  },
  get_facts: {
    kind: "checking",
    working: () => "Looking up your details",
    done: () => "Found your details",
    fail: () => "look up your details",
  },
  get_preview: {
    kind: "checking",
    working: () => "Opening the preview",
    done: () => "Opened the preview",
    fail: () => "open the preview",
  },
  request_change: {
    kind: "building",
    working: (a) => a.step ?? "Passing on your change",
    done: () => "Passed on your change",
    fail: () => "pass on your change",
  },
  answer_question: {
    kind: "building",
    working: () => "Passing on your answer",
    done: () => "Passed on your answer",
    fail: () => "pass on your answer",
  },
  create_reminder: {
    kind: "reminder",
    working: () => "Setting a reminder",
    done: (a) => (a.when ? `Reminder set for ${a.when}` : "Reminder set"),
    fail: () => "set the reminder",
  },
  record_review: {
    kind: "building",
    working: () => "Adding the review",
    done: () => "Added the review",
    fail: () => "add the review",
  },
  check_domain: {
    kind: "domain",
    working: (a) =>
      withDomain(a, (d) => `Checking DNS for ${d}`, "Checking your DNS"),
    done: (a) =>
      withDomain(a, (d) => `Checked DNS for ${d}`, "Checked your DNS"),
    fail: (a) => withDomain(a, (d) => `check DNS for ${d}`, "check your DNS"),
  },
  connect_domain: {
    kind: "domain",
    working: (a) =>
      withDomain(a, (d) => `Connecting ${d}`, "Connecting your domain"),
    done: (a) =>
      withDomain(
        a,
        (d) => `Started connecting ${d}`,
        "Started connecting your domain"
      ),
    fail: (a) => withDomain(a, (d) => `connect ${d}`, "connect your domain"),
  },
  remove_domain: {
    kind: "domain",
    working: (a) =>
      withDomain(a, (d) => `Removing ${d}`, "Removing your domain"),
    done: (a) => withDomain(a, (d) => `Removed ${d}`, "Removed your domain"),
    fail: (a) => withDomain(a, (d) => `remove ${d}`, "remove your domain"),
  },
  find_domain: {
    kind: "domain",
    working: (a) =>
      a.query ? `Searching for ${a.query}` : "Searching for a domain",
    done: (a) =>
      a.count === undefined
        ? "Found some names"
        : a.count === 0
          ? "Found no free names"
          : `Found ${plural(a.count, "name")}`,
    fail: () => "search for names",
  },
  buy_domain: {
    kind: "payment",
    working: (a) =>
      withDomain(
        a,
        (d) => `Getting ${d} ready to buy`,
        "Getting the domain ready to buy"
      ),
    done: (a) =>
      withDomain(
        a,
        (d) => `Got ${d} ready for payment`,
        "Got the domain ready for payment"
      ),
    fail: (a) => withDomain(a, (d) => `get ${d} ready`, "get the domain ready"),
  },
  connect_google: {
    kind: "google",
    working: () => "Connecting Google",
    done: () => "Opened Google sign-in",
    fail: () => "connect Google",
  },
  get_search_performance: {
    kind: "google",
    working: () => "Checking your Google results",
    done: () => "Checked your Google results",
    fail: () => "check your Google results",
  },
  get_indexing: {
    kind: "google",
    working: () => "Checking your pages on Google",
    done: () => "Checked your pages on Google",
    fail: () => "check your pages on Google",
  },
  remember: {
    kind: "thinking",
    working: () => "Noting that down",
    done: () => "Noted that down",
    fail: () => "note that down",
  },
}

const FAIL_TOOL = "try again in a moment"
const FAIL_STAGE = "You can try again from here."

const clean = (a: ToolArgs): Cleaned => ({
  domain: cleanArg(a.domain, "domain"),
  query: cleanArg(a.query),
  when: cleanArg(a.when, "text", 40),
  count: a.count,
  step: cleanArg(a.step, "text", 60),
})

/** A tool's line in one of its three forms. */
export function toolLine(
  tool: CosToolName,
  state: LineState,
  args: ToolArgs = {}
) {
  const copy = TOOLS[tool]
  const a = clean(args)
  return state === "working"
    ? copy.working(a)
    : state === "done"
      ? copy.done(a)
      : `Couldn't ${copy.fail(a)}, ${FAIL_TOOL}`
}

/** The kind a tool's icon is drawn for. */
export const toolKind = (tool: CosToolName): StatusKind => TOOLS[tool].kind

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
  /** Things the checks found and the build is fixing. */
  fixes?: number
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
    kind: "building",
    working: (a) =>
      a.total
        ? `Writing the pages, ${a.done ?? 0} of ${a.total}`
        : "Writing the pages",
    done: (a) =>
      a.total ? `Wrote ${plural(a.total, "page")}` : "Wrote the pages",
    fail: "finish the pages",
  },
  polishing: {
    kind: "building",
    working: () => "Polishing the details",
    done: () => "Polished the details",
    fail: "finish polishing",
  },
  checking: {
    kind: "checking",
    working: (a) =>
      a.fixes
        ? `Fixing ${plural(a.fixes, "thing")} the checks found`
        : "Checking the pages",
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
// Onboarding: the plan's own keys as they close in the stream (the api sends
// a key, never a word).

const FACT_LINE: Record<PlanFactKey, string> = {
  "business.name": "Saving your business name",
  "business.phone": "Saving your phone number",
  "business.email": "Saving your email address",
  "hours.weekday": "Noting your opening hours",
  "service_area.radius": "Noting how far you travel",
  "business.tagline": "Noting your tagline",
  "business.industry": "Noting what you do",
  "business.offerings": "Noting your services",
  "business.audience": "Noting who you work for",
  "business.overview": "Noting how you work",
  "business.proof": "Noting what sets you apart",
  "business.disclaimer": "Noting your regulatory notice",
  "service_area.text": "Noting where you work",
  "assistant.name": "Saving your assistant's name",
  "assistant.pronouns": "Noting your assistant's pronouns",
  "assistant.tone": "Noting the tone you want",
  "owner.preferred_name": "Noting what to call you",
  "site.build_mode": "Noting who builds your website",
  "site.template": "Noting your website layout",
  "site.palette": "Noting your colours",
  "site.font": "Noting your lettering",
  "site.direction": "Noting your page arrangement",
  "site.pages": "Noting your website pages",
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
  review_quote_form: "Drafting your quote form",
  start_build: "Getting ready to build",
  answer_only: "Working on your answer",
}

/** The line for what the planner is on: a fact it stated or the move it chose. */
export const onboardingLine = (on: OnboardingStatus["on"]) =>
  on.kind === "fact" ? FACT_LINE[on.key] : NEXT_LINE[on.next]

// ---------------------------------------------------------------------------
// Segments: a title, a line under it and a done title, with the business and
// assistant names in them. Two or three variants per title, picked by a
// stable hash of the org id.

type JobKind =
  | "onboarding"
  | "website"
  | "golive"
  | "change"
  | "domain"
  | "purchase"
  | "google"

type Names = {
  assistant: string | null
  business: string | null
  host: string | null
  domain: string | null
}

type JobCopy = {
  title: (n: Names) => readonly string[]
  done: (n: Names) => readonly string[]
  /** What stopped, after "The" and before "stopped". */
  noun: string
  /** What the pill says while the job runs, after "{assistant} is". */
  pill: (n: Names) => string
}

const biz = (n: Names) => n.business ?? "Your business"
const domain = (n: Names) => n.domain ?? "the domain"

const JOBS: Record<JobKind, JobCopy> = {
  onboarding: {
    title: (n) =>
      n.business
        ? [`Getting ${n.business} ready`, `Setting up ${n.business}`]
        : ["Getting started"],
    done: (n) => [
      `${biz(n)} is set up`,
      `${biz(n)} is all set`,
      `${biz(n)} is ready to go`,
    ],
    noun: "setup",
    pill: (n) => `getting to know ${n.business ?? "your business"}`,
  },
  website: {
    title: (n) => [
      is(n.assistant, "building your website"),
      is(n.assistant, "putting your website together"),
    ],
    done: () => [
      "Your website is ready to look over",
      "Your website is ready for a look",
    ],
    noun: "website build",
    pill: () => "building your website",
  },
  golive: {
    title: () => ["Putting your website live", "Taking your website live"],
    done: (n) =>
      n.host
        ? [
            `${biz(n)} is live at ${n.host}`,
            `${biz(n)} is now live at ${n.host}`,
          ]
        : [`${biz(n)} is live`, `${biz(n)} is now live`],
    noun: "website launch",
    pill: () => "putting your website live",
  },
  change: {
    title: (n) => [
      is(n.assistant, "updating your website"),
      is(n.assistant, "making your changes"),
    ],
    done: () => [
      "Your changes are ready to look over",
      "Your changes are ready for a look",
    ],
    noun: "update",
    pill: () => "updating your website",
  },
  domain: {
    title: (n) => [
      `Connecting ${n.domain ?? "your domain"}`,
      `Setting up ${n.domain ?? "your domain"}`,
    ],
    done: (n) => [`${cap(domain(n))} is live`, `${cap(domain(n))} is working`],
    noun: "domain connection",
    pill: (n) => `connecting ${n.domain ?? "your domain"}`,
  },
  purchase: {
    title: (n) => [
      `Buying ${n.domain ?? "your domain"}`,
      `Getting ${n.domain ?? "your domain"}`,
    ],
    done: (n) => [
      `${cap(domain(n))} is yours`,
      `${cap(domain(n))} is registered`,
    ],
    noun: "purchase",
    pill: (n) => `buying ${n.domain ?? "your domain"}`,
  },
  google: {
    title: () => ["Connecting Google", "Linking your site to Google"],
    done: () => ["Your site is on Google", "Your site is connected to Google"],
    noun: "Google connection",
    pill: () => "connecting Google",
  },
}

/** What a waiting segment waits for, after "waiting for". */
const WAITING: Partial<Record<ActivitySegment["kind"], string>> = {
  onboarding: "your answer",
  golive: "your approval",
  domain: "your DNS change",
  purchase: "your payment",
  google: "you to sign in",
  review: "your approval",
  question: "your answer",
}

const job = (segment: ActivitySegment) =>
  Object.hasOwn(JOBS, segment.kind) ? JOBS[segment.kind as JobKind] : null

const namesOf = (segment: ActivitySegment, ctx: CopyContext): Names => {
  const n = segment.names
  return {
    assistant: named(ctx.assistant),
    business: cleanArg(n?.business, "text", 60),
    host: cleanArg(n?.host, "domain"),
    domain: cleanArg(n?.domain, "domain"),
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
  const done = segment.state === "done"
  return pick(
    ctx,
    `${segment.kind}:${done ? "done" : "title"}`,
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
    const next = is(n.assistant, "looking into it")
    const why = cleanArg(extras.why, "text", 80)?.replace(/[.!]+$/, "")
    return why ? `${why}. ${next}` : next
  }
  if (state !== "now" && state !== "waiting") return null
  const waiting = state === "waiting"
  const elapsed =
    extras.elapsedSeconds === undefined
      ? null
      : elapsedText(extras.elapsedSeconds)
  switch (segment.kind as JobKind) {
    case "onboarding": {
      if (!n.business) return "A few questions, then your website"
      const left = segment.steps.filter(
        (s) => s.state !== "done" && s.state !== "skipped"
      ).length
      const then = n.assistant
        ? `${n.assistant} starts on your website`
        : "work on your website starts"
      return left <= 1
        ? `One more, then ${then}`
        : `${left} more to go, then ${then}`
    }
    case "website":
      return elapsed
        ? `${elapsed} so far, usually 4 to 6 minutes`
        : "Usually 4 to 6 minutes"
    case "change": {
      const step = cleanArg(segment.step, "text", 60)
      return step ?? (elapsed ? `${elapsed} so far` : null)
    }
    case "golive":
      return waiting
        ? "Approve it and it goes live in a minute"
        : "Going live in a minute"
    case "domain":
      return waiting
        ? `One change to make at ${cleanArg(extras.provider) ?? "your DNS provider"}`
        : "The certificate is on its way"
    case "purchase": {
      const by = cleanArg(extras.until, "text", 40)
      return waiting
        ? by
          ? `Pay by ${by} to keep the name`
          : "Pay soon to keep the name"
        : "Registering the name"
    }
    case "google":
      return waiting
        ? "Finish signing in within 10 minutes"
        : "Checking your site with Google"
  }
}

/** The panel pill: "Ellie is building your website", or "Ellie is waiting for your payment". Null when nothing runs or waits. */
export function pillLine(segment: ActivitySegment, ctx: CopyContext) {
  const assistant = named(ctx.assistant)
  if (segment.state === "failed") {
    const copy = job(segment)
    return copy ? `The ${copy.noun} stopped` : null
  }
  if (segment.state === "waiting") {
    const waitsFor = WAITING[segment.kind]
    return waitsFor ? is(assistant, `waiting for ${waitsFor}`) : null
  }
  const copy = job(segment)
  if (segment.state !== "now" || !copy) return null
  return is(assistant, copy.pill(namesOf(segment, ctx)))
}

/** A waiting row under its segment: "Waiting for your payment, until 11:50". */
export function waitingRow(segment: ActivitySegment, until?: string) {
  const waitsFor = WAITING[segment.kind]
  if (!waitsFor) return null
  const by = cleanArg(until, "text", 40)
  return `Waiting for ${waitsFor}${by ? `, until ${by}` : ""}`
}
