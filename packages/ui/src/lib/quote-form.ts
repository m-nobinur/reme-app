import {
  QUOTE_FIELDS_MIN,
  type QuoteField,
  QuoteFields,
} from "@workspace/contracts"

/**
 * The owner's edits to a proposed quote form, as plain data: each question
 * the assistant proposed, in its order, renamed, made optional or dropped.
 * A dropped question keeps its place so it can come back. Keys never change,
 * so every question the owner keeps still has its own.
 */
export type QuoteDraft = { field: QuoteField; dropped: boolean }[]

/** The longest label the contract takes. */
export const QUOTE_LABEL_MAX = 80

export const draftOf = (fields: readonly QuoteField[]): QuoteDraft =>
  fields.map((field) => ({ field, dropped: false }))

export const keptFields = (draft: QuoteDraft): QuoteField[] =>
  draft.flatMap((row) => (row.dropped ? [] : [row.field]))

/** Whether one more question can go without the form falling under the contract's minimum. */
export const canDrop = (draft: QuoteDraft) =>
  keptFields(draft).length > QUOTE_FIELDS_MIN

/** Why a question cannot go, for the control that would drop it. */
export const DROP_LIMIT = `A quote form needs at least ${QUOTE_FIELDS_MIN} questions.`

const change = (
  draft: QuoteDraft,
  key: string,
  edit: (row: QuoteDraft[number]) => QuoteDraft[number]
): QuoteDraft => draft.map((row) => (row.field.key === key ? edit(row) : row))

export const dropField = (draft: QuoteDraft, key: string): QuoteDraft =>
  canDrop(draft)
    ? change(draft, key, (row) => ({ ...row, dropped: true }))
    : draft

export const restoreField = (draft: QuoteDraft, key: string): QuoteDraft =>
  change(draft, key, (row) => ({ ...row, dropped: false }))

export const renameField = (
  draft: QuoteDraft,
  key: string,
  label: string
): QuoteDraft =>
  change(draft, key, (row) => ({
    ...row,
    field: { ...row.field, label: label.slice(0, QUOTE_LABEL_MAX) },
  }))

export const setRequired = (
  draft: QuoteDraft,
  key: string,
  required: boolean
): QuoteDraft =>
  change(draft, key, (row) => ({ ...row, field: { ...row.field, required } }))

/** Why a kept question's label cannot stand, or null. */
export function labelProblem(draft: QuoteDraft, key: string): string | null {
  const kept = keptFields(draft)
  const field = kept.find((each) => each.key === key)
  if (!field) return null
  const label = field.label.trim()
  if (!label) return "Give this question a label."
  const same = kept.filter(
    (each) => each.label.trim().toLowerCase() === label.toLowerCase()
  )
  return same.length > 1 ? "Two questions have this label." : null
}

/**
 * The list to confirm, labels trimmed, or why it cannot be confirmed yet.
 * The contract checks it too, so nothing the api would refuse is sent.
 */
export function confirmedFields(
  draft: QuoteDraft
): { fields: QuoteField[] } | { problem: string } {
  const kept = keptFields(draft)
  for (const field of kept) {
    const problem = labelProblem(draft, field.key)
    if (problem) return { problem: `${problem} Fix it before you confirm.` }
  }
  const fields = kept.map((field) => ({ ...field, label: field.label.trim() }))
  return QuoteFields.safeParse(fields).success
    ? { fields }
    : { problem: "These questions cannot be used as they are." }
}

/** A question's type as the owner reads it. */
export const QUOTE_TYPE_LABEL: Record<QuoteField["type"], string> = {
  text: "Text",
  textarea: "Long text",
  number: "Number",
  date: "Date",
  select: "Choice",
  tel: "Phone",
  email: "Email",
}

/** The confirmed list read back: how many questions, and which. */
export const quoteSummary = (fields: readonly QuoteField[]) =>
  `Your quote form asks ${fields.length} ${fields.length === 1 ? "question" : "questions"}: ${fields.map((f) => f.label).join(", ")}.`

/**
 * What the composer suggests while a proposed form waits: a message sent
 * then is the owner's change to it, not a new subject.
 */
export const QUOTE_CHANGES_PLACEHOLDER =
  "Say what to change about these questions…"

/**
 * Whether these parts, a message's, hold a proposed form still waiting on
 * the owner. Read from the thread's own part shape.
 */
export const waitsOnQuoteForm = (parts: readonly object[] | undefined) =>
  (parts ?? []).some((part) => {
    const p = part as {
      type?: string
      toolName?: string
      result?: unknown
      isError?: boolean
    }
    return (
      p.type === "tool-call" &&
      p.toolName === "review_quote_form" &&
      p.result === undefined &&
      !p.isError
    )
  })
