import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { dashesToCommas } from "@workspace/contracts"
import {
  failureCode,
  reserveSpend,
  settleSpend,
  type Tenancy,
} from "@workspace/db"
import models from "@workspace/facade/models/openrouter.models.json" with {
  type: "json",
}
import { scrub } from "@workspace/facade/tee"
import { contactsIn, vouched } from "@workspace/gates/contacts"
import { generateText } from "ai"
import { assistantName } from "./assistant.ts"
import type { DigestItem } from "./heartbeat.ts"

/**
 * Jev, a decision model, says whether a beat's new items are worth
 * interrupting the owner; the proactive CoS turn then writes the message or
 * stays `[quiet]`. Here too: the writer of the owner's updates
 * (`writeUpdate`) and what code checks in its answers.
 */

/** What one call cost, for its `cos.background_step` row. */
export type Spent = {
  model: string
  cost_usd: number
  usage: { input_tokens: number; output_tokens: number }
  ms: number
}

export const GATE = {
  model: "typesafe/jev-1.14",
  /**
   * "Is any of this worth interrupting the owner for now?", asked as the
   * three reasons it could be; the beat goes on when any is likely. One
   * question scored every digest between 0.15 and 0.68 on the eval set,
   * these three spread it from 0.26 to 0.96.
   */
  questions: {
    needs_owner:
      "Does any item need the owner to decide, answer a question, or do something?",
    visible_problem:
      "Did something go wrong that the business's visitors or customers would notice?",
    wanted_news:
      "Is any item news about the business the owner would want to hear today?",
  },
  /**
   * Jev stops only what is plainly not worth a word; the proactive CoS turn
   * judges the rest and may answer `[quiet]`. With the old writer, on the
   * coordinator's seed labels (evals/heartbeat) this agreed on 25 of 30, and
   * a bar per dial (0.9, 0.6, 0.5) on 24. Recheck on the owner's labels and
   * on the dismiss rate of the first 50 real heartbeats.
   */
  floor: 0.3,
  timeoutMs: 5_000,
  /** Per Mtok of input, for when OpenRouter reports no cost. */
  inputPrice: 0.042,
} as const

export const WRITER = {
  model: "openai/gpt-6.1-sol",
  /** Reasoning counts here too; low effort stays well under it. */
  maxOutputTokens: 2_000,
  timeoutMs: 60_000,
} as const

const billed = (metadata: unknown): number | null => {
  const cost = (
    metadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined
  )?.openrouter?.usage?.cost
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? cost
    : null
}

type GateState = Parameters<
  ReturnType<
    ReturnType<typeof createOpenRouter>["evaluationModel"]
  >["doEvaluate"]
>[0]["state"]

/** Jev's probability that `state` is worth interrupting the owner for: the likeliest of its reasons. */
export async function askGate(
  apiKey: string,
  state: GateState
): Promise<{ probability: number; spent: Spent }> {
  const started = Date.now()
  const result = await createOpenRouter({ apiKey })
    .evaluationModel(GATE.model)
    .doEvaluate({
      state,
      questions: Object.fromEntries(
        Object.entries(GATE.questions).map(([id, instructions]) => [
          id,
          { type: "boolean" as const, instructions },
        ])
      ),
      abortSignal: AbortSignal.timeout(GATE.timeoutMs),
    })
  const answers = Object.keys(GATE.questions).map(
    (id) => Object.entries(result.answers).find(([key]) => key === id)?.[1]
  )
  let probability = 0
  for (const answer of answers) {
    if (answer?.type !== "boolean") throw new Error("heartbeat.gate_unanswered")
    probability = Math.max(probability, answer.probability)
  }
  const input = result.usage?.inputTokens ?? 0
  return {
    probability,
    spent: {
      model: GATE.model,
      cost_usd:
        billed(result.providerMetadata) ?? (input * GATE.inputPrice) / 1e6,
      usage: {
        input_tokens: input,
        output_tokens: result.usage?.outputTokens ?? 0,
      },
      ms: Date.now() - started,
    },
  }
}

/** Jev's call at its worst, to reserve: two characters a token. */
export const worstGate = (state: GateState) =>
  (Math.ceil(
    (JSON.stringify(state).length +
      Object.values(GATE.questions).join("").length) /
      2
  ) *
    GATE.inputPrice) /
  1e6

/**
 * One reply from the writer model at low effort, with no tools, through the
 * same OpenRouter routing the CoS uses: capped at the table's price and kept
 * off the hosts it excludes. `data` goes in as the user turn, as JSON.
 */
export async function writeText(
  apiKey: string,
  system: string,
  data: unknown,
  timeoutMs: number = WRITER.timeoutMs
): Promise<{ text: string; spent: Spent }> {
  const entry = models.find((m) => m.id === WRITER.model)
  const routing = entry?.compat.openRouterRouting
  if (!entry || !routing) throw new Error("heartbeat.writer_unpriced")
  const started = Date.now()
  const result = await generateText({
    model: createOpenRouter({ apiKey }).chat(WRITER.model, {
      usage: { include: true },
      reasoning: { effort: "low" },
      provider: { ...routing },
    }),
    system,
    prompt: JSON.stringify(data),
    maxOutputTokens: WRITER.maxOutputTokens,
    abortSignal: AbortSignal.timeout(timeoutMs),
  })
  const input = result.usage.inputTokens ?? 0
  const output = result.usage.outputTokens ?? 0
  return {
    text: result.text,
    spent: {
      model: WRITER.model,
      cost_usd:
        billed(result.providerMetadata) ??
        (input * entry.cost.input + output * entry.cost.output) / 1e6,
      usage: { input_tokens: input, output_tokens: output },
      ms: Date.now() - started,
    },
  }
}

/** A `writeText` call at its worst, to reserve: two characters a token in, the whole output cap out. */
export function worstWrite(system: string, data: unknown): number {
  const cost = models.find((m) => m.id === WRITER.model)?.cost
  if (!cost) throw new Error("heartbeat.writer_unpriced")
  return (
    (Math.ceil((system.length + JSON.stringify(data).length) / 2) * cost.input +
      WRITER.maxOutputTokens * cost.output) /
    1e6
  )
}

/** Hard limits on a heartbeat message, checked in code. */
export const LIMITS = { sentences: 3, chars: 450, questions: 1 } as const

/** Who is speaking: the name the owner chose, else no name. */
const youAre = (name: string | null) =>
  name
    ? `You are ${name}, the assistant to the owner of a small service business.`
    : "You are the assistant to the owner of a small service business."

export type Reply =
  | { kind: "quiet"; reason: string }
  | { kind: "message"; text: string }
  | { kind: "error"; detail: string }

/** A line that is only the marker: `[quiet]` or `quiet`, any case, trailing stop allowed. */
const MARKER_LINE = /^\[?quiet\]?[.!:]?$/i
/** The marker opening the reply, then a reason: `[quiet] ...`, or `quiet:` / `quiet -` and a reason. */
const MARKER_PREFIX = /^(?:\[quiet\][\s:.\-–—]*|quiet\s*[:\-–—]\s*)/i

const reasonOf = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(0, 200)

/**
 * hermes' loose rule for its silence marker: the reply is quiet when the
 * marker is all of it, sits on its own first or last line, or opens it; a
 * marker mid-sentence is part of a message. Empty is an error, not silence.
 */
export function readReply(raw: string): Reply {
  const text = raw.trim()
  if (!text) return { kind: "error", detail: "empty" }
  const lines = text.split(/\r?\n/)
  const first = (lines[0] ?? "").trim()
  const last = (lines[lines.length - 1] ?? "").trim()
  if (MARKER_LINE.test(first))
    return { kind: "quiet", reason: reasonOf(lines.slice(1).join(" ")) }
  if (MARKER_LINE.test(last))
    return { kind: "quiet", reason: reasonOf(lines.slice(0, -1).join(" ")) }
  if (MARKER_PREFIX.test(text))
    return { kind: "quiet", reason: reasonOf(text.replace(MARKER_PREFIX, "")) }
  return { kind: "message", text }
}

/**
 * `readReply`, with a message's dashes made commas as the chat's are, a
 * message that breaks a limit read as an error, and so is one that carries
 * a link, an email address or a phone number that no fact the item vouches
 * for (`DigestItem.trusted`) holds exactly: text injected into a review or
 * a page can shape the message, never point the owner somewhere.
 */
export function replyOf(raw: string, items: DigestItem[] = []): Reply {
  const read = readReply(raw)
  if (read.kind !== "message") return read
  const reply = { ...read, text: dashesToCommas(read.text) }
  const over = overLimit(reply.text)
  if (over) return { kind: "error", detail: `over_limit:${over}` }
  return vouched(reply.text, trustedContacts(items))
    ? reply
    : { kind: "error", detail: "unsourced_contact" }
}

/** The contacts the items' trusted facts (`DigestItem.trusted`) hold, and only those. */
export const trustedContacts = (items: DigestItem[]) => [
  ...new Set(
    items.flatMap((item) =>
      (item.trusted ?? []).flatMap((name) => contactsIn(item.facts[name] ?? ""))
    )
  ),
]

/**
 * "Monday, 19 October 2026 at 2:00 PM", in `zone` (UTC when null): the writer
 * copies the times it reads, so they are in the app's 12-hour form.
 */
export const localTime = (at: Date, zone: string | null) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone ?? "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(at)
    .replace(/\b(am|pm)\b/, (period) => period.toUpperCase())

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/**
 * An item as the models read it: scrubbed of anything secret-shaped, and
 * every time in the owner's zone, so a date the writer copies is one the
 * owner reads. The key keeps only its kind.
 */
function forModel(item: DigestItem, zone: string | null) {
  const values = Object.fromEntries(
    Object.entries(item.facts).map(([k, v]) => [
      k,
      ISO.test(v) ? localTime(new Date(v), zone) : scrub(v),
    ])
  )
  return {
    kind: item.key.split(":")[0] ?? "",
    since: localTime(new Date(item.since), zone),
    ...values,
  }
}

/** What one beat shows Jev and the CoS: its new items and what it knows of the owner. */
export type Look = {
  zone: string | null
  now: Date
  items: DigestItem[]
  profile: string | null
}

/**
 * Jev's state for a beat, and the same items as the `cos.event` summary the
 * proactive turn reads, one line each; both scrubbed.
 */
export function modelInput(look: Look) {
  const items = look.items.map((item) => forModel(item, look.zone))
  const profile = look.profile ? scrub(look.profile).slice(0, 1_500) : null
  const lines = items.map(({ kind, since, ...facts }) =>
    [
      `${kind}, since ${since}`,
      ...Object.entries(facts).map(([k, v]) => `${k}: ${v}`),
    ].join("; ")
  )
  return {
    state: { items, ...(profile ? { owner_profile: profile } : {}) },
    summary: [
      "Your scheduled look found these, new since it last looked:",
      ...lines,
    ]
      .join("\n")
      .slice(0, 1_500),
  }
}

/** Sentences as a reader counts them: a stop followed by a space or the end. */
const sentencesIn = (text: string) =>
  text.split(/(?<=[.!?…])["'”’)]*\s+/).filter((s) => s.trim()).length

/** Null when the message keeps to `LIMITS`, else which limit it broke. */
export function overLimit(text: string): string | null {
  if (text.length > LIMITS.chars) return "chars"
  if (sentencesIn(text) > LIMITS.sentences) return "sentences"
  if ((text.match(/\?/g) ?? []).length > LIMITS.questions) return "questions"
  return null
}

/** Room for `amount` in the org's daily cap, reserved until `logSpend` settles it; null when there is none. */
export const reserve = (
  kit: Tenancy,
  orgId: string,
  job: string,
  amount: number
) => kit.withOrg({ orgId }, (db) => reserveSpend(db, orgId, job, amount))

/** A reserved call's cost as a `cos.background_step`, which the CoS's daily cap counts. A call that throws stays counted at its reservation. */
export const logSpend = (
  kit: Tenancy,
  orgId: string,
  reservation: string,
  job: string,
  outcome: string,
  spent: Spent
) => settleSpend(kit, { orgId }, reservation, { job, outcome, ...spent })

/**
 * An update that answers something the owner started (a site going live, a
 * domain connecting): what happened as `facts`, each value a string to be
 * quoted exactly, and today's fixed `template`, which is what the owner
 * gets whenever the model's text cannot be trusted.
 */
export type Update = { facts: Record<string, string>; template: string }

const updatePrompt = (name: string | null) =>
  [
    `${youAre(name)} Something the owner started has just moved on, and you are telling them.`,
    "You get the facts and a draft. Write the update in your own words as one short, warm message: the point first, then what happens next or what the owner can do.",
    "Use every value in the facts exactly as written, with no quotation marks around it. Add no number, date, name, web address or DNS value that is not in the facts. No greeting, no thanks, no sign-off.",
    `At most ${LIMITS.sentences} sentences and ${LIMITS.chars} characters, and at most one question.`,
  ].join("\n\n")

/** Updates run inside a Workflow step, so the model gets less time than a heartbeat. */
const UPDATE_TIMEOUT_MS = 15_000

const QUOTES = ['"', "“", "'", "‘", "«"]

/**
 * Whether `text` may stand in for the template: a message inside the limits,
 * every fact's value in it verbatim and not in quotation marks, no number the
 * facts do not hold, and no link or phone number other than theirs.
 */
export function faithful(text: string, facts: Record<string, string>): boolean {
  const values = Object.values(facts)
  const reply = replyOf(text, [
    { key: "update", since: "", facts, trusted: Object.keys(facts) },
  ])
  if (reply.kind !== "message") return false
  if (!values.every((value) => reply.text.includes(value))) return false
  if (
    values.some((value) => QUOTES.some((q) => reply.text.includes(q + value)))
  )
    return false
  const numbers = new Set(values.flatMap((value) => value.match(/\d+/g) ?? []))
  return (reply.text.match(/\d+/g) ?? []).every((n) => numbers.has(n))
}

/**
 * The owner's update in the model's words, or the template when there is no
 * key, the day's cap has no room, the call fails, or the text is not
 * `faithful`. Never throws. These answer the owner's own actions, so quiet
 * hours do not apply.
 */
export async function writeUpdate(
  env: { OPENROUTER_API_KEY?: string },
  kit: Tenancy,
  orgId: string,
  update: Update,
  write: typeof writeText = writeText
): Promise<string> {
  const key = env.OPENROUTER_API_KEY
  if (!key) return update.template
  try {
    const system = updatePrompt(
      await kit.withOrg({ orgId }, assistantName).catch(() => null)
    )
    const data = { facts: update.facts, draft: update.template }
    const reservation = await reserve(
      kit,
      orgId,
      "update",
      worstWrite(system, data)
    )
    if (!reservation) return update.template
    const written = await write(key, system, data, UPDATE_TIMEOUT_MS)
    const text = written.text.trim()
    const kept = faithful(text, update.facts)
    await logSpend(
      kit,
      orgId,
      reservation,
      "update",
      kept ? "written" : "template",
      written.spent
    ).catch(() => undefined)
    return kept ? text : update.template
  } catch (error) {
    console.error(
      JSON.stringify({ code: "update.write_failed", error: failureCode(error) })
    )
    return update.template
  }
}
