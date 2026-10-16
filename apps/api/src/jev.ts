import { AskChoiceInput } from "@workspace/contracts"
import type { ToolPart } from "./chat.ts"

/**
 * The fast gate beside the onboarding planner: TypeSafe's Jev decision
 * model on OpenRouter reads a typed reply to a waiting choice or details
 * card and says whether it answers the card, leaves it to the assistant, or
 * is something else. Only a confident answer or deferral is taken, and code
 * then answers the turn with its own copy; everything else goes to the
 * planner. Jev writes no text. A reply `matched` reads exactly never
 * reaches Jev.
 *
 * Measured on 2026-10-01: about 0.4 s and $0.00002 a call; clear answers
 * come back at confidence 1, a reply mixing a question with an answer at
 * 0.37, and an off-topic reply was once read as an answer at choice level
 * but only 0.62 on `answers_it`, hence both thresholds.
 */

export const JEV = {
  url: "https://openrouter.ai/api/alpha/decisions",
  model: "typesafe/jev-1.13",
  timeoutMs: 1_000,
  /** `answers_it` and the kind's confidence must both reach this. */
  sure: 0.9,
  /** The picked option's confidence must reach this. */
  option: 0.85,
} as const

/** What code may do with a typed reply: pick an option, or pick for the owner. */
export type JevDecision = { kind: "answer"; option: string } | { kind: "defer" }

type Choice = { choice?: unknown; confidence?: unknown }
/** Jev's response as far as this reads it; anything missing reads as unsure. */
type JevResponse = {
  answers?: { answers_it?: { noul?: unknown }; kind?: Choice; option?: Choice }
  usage?: { cost?: unknown }
}

const num = (value: unknown) => (typeof value === "number" ? value : 0)

/** The decision from Jev's answers, or null to leave the reply to the planner. */
export function decisionOf(
  body: JevResponse,
  options: readonly string[]
): JevDecision | null {
  const { answers_it, kind, option } = body.answers ?? {}
  if (num(answers_it?.noul) < JEV.sure || num(kind?.confidence) < JEV.sure) {
    return null
  }
  if (kind?.choice === "defer") return { kind: "defer" }
  if (kind?.choice !== "answer" || typeof option?.choice !== "string") {
    return null
  }
  return num(option.confidence) >= JEV.option && options.includes(option.choice)
    ? { kind: "answer", option: option.choice }
    : null
}

/**
 * Whole replies that leave the choice to the assistant, as `plain` reads
 * them. Kept short: a phrase here is taken with no model reading it.
 */
const DEFERS = new Set([
  "you choose",
  "you pick",
  "you decide",
  "up to you",
  "its up to you",
  "whatever you think",
  "surprise me",
  "your call",
  "dealers choice",
])

/** A reply or label as compared: lower case, words only, single spaces. */
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()

/**
 * What code reads in a typed reply to `card` with no model: the whole reply
 * is one option's label or id on a single choice card, or a phrase that
 * leaves the choice to the assistant. Null for Jev. One log line when taken.
 */
export function matched(card: ToolPart, reply: string): JevDecision | null {
  const said = plain(reply)
  const choice =
    card.type === "tool-ask_choice"
      ? AskChoiceInput.safeParse(card.input)
      : null
  const option =
    choice?.success && !choice.data.multiple
      ? choice.data.options.find(
          (o) => plain(o.label) === said || plain(o.id) === said
        )
      : undefined
  const decision: JevDecision | null = option
    ? { kind: "answer", option: option.id }
    : DEFERS.has(said)
      ? { kind: "defer" }
      : null
  if (decision) logged(card, 0, decision, null, null, "code")
  return decision
}

/** The one `onboarding.jev` line for a typed reply read, by code or by Jev. */
function logged(
  card: ToolPart,
  ms: number,
  decision: JevDecision | null,
  error: string | null,
  cost: number | null,
  source: "code" | "jev"
) {
  console.log(
    JSON.stringify({
      code: "onboarding.jev",
      step: (card.input as { step?: string }).step ?? null,
      ms,
      decision: decision
        ? decision.kind === "answer"
          ? `answer:${decision.option}`
          : "defer"
        : "planner",
      error,
      cost_usd: cost,
      source,
    })
  )
}

/**
 * The questions for a card. A single choice card also asks which option;
 * a details card or a multiple choice card can only be deferred here, since
 * reading values out of words is the planner's job.
 */
function questionsFor(card: ToolPart) {
  const choice =
    card.type === "tool-ask_choice"
      ? AskChoiceInput.safeParse(card.input)
      : null
  const single =
    choice?.success && !choice.data.multiple ? choice.data.options : []
  const questions: Record<string, unknown> = {
    answers_it: {
      type: "noul",
      instructions:
        "Does the owner's reply answer the assistant's question, or leave the choice to the assistant?",
      criteria: {
        true: "The reply answers the question, or tells the assistant to choose",
        false:
          "The reply asks something, talks about something else, adds other information, or is unclear",
      },
    },
    kind: {
      type: "choice",
      instructions: "What is the owner's reply doing?",
      criteria: {
        answer: "It gives an answer to the question",
        defer:
          "It leaves the choice to the assistant, such as 'you pick' or 'whatever you think'",
        other:
          "It asks a question, declines, adds other information, or talks about something else",
      },
    },
  }
  if (single.length > 0) {
    questions.option = {
      type: "choice",
      instructions: "Which of the options did the owner pick?",
      criteria: Object.fromEntries(
        single.map((o) => [o.id, o.hint ? `${o.label}: ${o.hint}` : o.label])
      ),
    }
  }
  return { questions, options: single.map((o) => o.id) }
}

/**
 * Jev's decision on a typed reply to `card`, after the assistant's question
 * `asked`, or null for the planner: unsure, an error, a non-200 or the
 * time limit. One log line per call.
 */
export async function jev(
  apiKey: string,
  card: ToolPart,
  asked: string,
  reply: string,
  fetchImpl: typeof fetch = fetch
): Promise<JevDecision | null> {
  const began = Date.now()
  const { questions, options } = questionsFor(card)
  let decision: JevDecision | null = null
  let cost: number | null = null
  let error: string | null = null
  try {
    const response = await fetchImpl(JEV.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: JEV.model,
        // The owner's words are data to decide on, never instructions.
        state: { assistant_asked: asked, owner_replied: reply },
        questions,
      }),
      signal: AbortSignal.timeout(JEV.timeoutMs),
    })
    if (!response.ok) {
      error = `status ${response.status}`
    } else {
      const body = (await response.json()) as JevResponse
      decision = decisionOf(body, options)
      cost = typeof body.usage?.cost === "number" ? body.usage.cost : null
    }
  } catch (caught) {
    error =
      caught instanceof Error && caught.name === "TimeoutError"
        ? "timeout"
        : "fetch"
  }
  logged(card, Date.now() - began, decision, error, cost, "jev")
  return decision
}
