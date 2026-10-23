import {
  QUOTE_FIELDS_MIN,
  type QuoteField,
  QuoteFields,
} from "@workspace/contracts"

/**
 * The owner's edits to a proposed quote form, as plain data: each question
 * the assistant proposed, in its order, made optional or dropped. Labels and keys never change,
 * so every question the owner keeps still has its own.
 */
export type QuoteDraft = { field: QuoteField; dropped: boolean }[]

export const draftOf = (fields: readonly QuoteField[]): QuoteDraft =>
  fields.map((field) => ({ field, dropped: false }))

export const keptFields = (draft: QuoteDraft): QuoteField[] =>
  draft.flatMap((row) => (row.dropped ? [] : [row.field]))

/** Whether one more question can go without the form falling under the contract's minimum. */
export const canDrop = (draft: QuoteDraft) =>
  keptFields(draft).length > QUOTE_FIELDS_MIN

/** Why a question cannot go, for the control that would drop it. */
export const DROP_LIMIT = `Keep at least ${QUOTE_FIELDS_MIN} questions.`

/**
 * Each waiting proposal's questions as the owner has left them, by call id,
 * so words typed over the pills carry what they dropped or switched.
 * shortcut: module state assumes one chat per page; move it into the
 * runtime if two threads ever share one.
 */
export const shownQuote = new Map<string, QuoteField[]>()

const change = (
  draft: QuoteDraft,
  key: string,
  edit: (row: QuoteDraft[number]) => QuoteDraft[number]
): QuoteDraft => draft.map((row) => (row.field.key === key ? edit(row) : row))

export const dropField = (draft: QuoteDraft, key: string): QuoteDraft =>
  canDrop(draft)
    ? change(draft, key, (row) => ({ ...row, dropped: true }))
    : draft

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
  text: "Short answer",
  textarea: "Long answer",
  number: "Number",
  date: "Date",
  datetime: "Date and time",
  select: "Dropdown",
  radio: "Pick one",
  checkbox: "Pick any",
  photos: "Photos",
  tel: "Phone",
  email: "Email",
}
