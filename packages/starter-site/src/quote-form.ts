/**
 * The questions the quote form asks after the visitor's contact details,
 * read from `quote-form.json`. The platform writes that file from the
 * owner's approved `quote.form` fact; it ships a general set for a business
 * that has not chosen its own. The Developer never edits it.
 *
 * The checks copy the contract's `QuoteFields`, because the site imports
 * nothing outside itself; the starter's tests fail when the copies drift. A
 * file that fails them fails the build, so a site never renders a form
 * nobody approved.
 */
import file from "./quote-form.json"

export const QUOTE_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "date",
  "datetime",
  "select",
  "radio",
  "checkbox",
  "photos",
  "tel",
  "email",
] as const

/** The types a question offers options for. */
export const QUOTE_CHOICE_TYPES: readonly string[] = [
  "select",
  "radio",
  "checkbox",
]

export type QuoteField = {
  key: string
  label: string
  type: (typeof QUOTE_FIELD_TYPES)[number]
  required: boolean
  hint: string | null
  options: string[] | null
}

const KEYS = ["key", "label", "type", "required", "hint", "options"]

/** Non-blank text of at most `max` characters, as the contract's `Text`. */
const text = (value: unknown, max: number) =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= max &&
  /\S/.test(value)

function problem(field: unknown): string | null {
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    return "is not an object"
  }
  const f = field as Record<string, unknown>
  const extra = Object.keys(f).filter((k) => !KEYS.includes(k))
  if (extra.length > 0) return `has unknown keys ${extra.join(", ")}`
  if (typeof f.key !== "string" || !/^[a-z][a-z0-9_]{1,30}$/.test(f.key)) {
    return "needs a key of lower case letters, digits and underscores"
  }
  if (!text(f.label, 80)) return "needs a label of 1 to 80 characters"
  if (!(QUOTE_FIELD_TYPES as readonly unknown[]).includes(f.type)) {
    return `has a type other than ${QUOTE_FIELD_TYPES.join(", ")}`
  }
  if (typeof f.required !== "boolean") return "needs required as true or false"
  if (f.hint !== null && !text(f.hint, 120)) {
    return "needs a hint of 1 to 120 characters, or null"
  }
  if (f.options !== null) {
    if (
      !Array.isArray(f.options) ||
      f.options.length < 2 ||
      f.options.length > 12 ||
      !f.options.every((o) => text(o, 60))
    ) {
      return "needs 2 to 12 options of 1 to 60 characters, or null"
    }
  }
  if (QUOTE_CHOICE_TYPES.includes(f.type as string) !== (f.options !== null)) {
    return "options belong to a select, radio or checkbox, and each of those needs them"
  }
  return null
}

/** Why `value` is not a valid `{ fields }` file, or null when it is. */
export function quoteFormProblem(value: unknown): string | null {
  const fields = (value as { fields?: unknown } | null)?.fields
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(fields)
  ) {
    return "it must be { fields: [...] } and nothing else"
  }
  if (fields.length < 2 || fields.length > 8) {
    return "it needs 2 to 8 questions"
  }
  for (const [i, field] of fields.entries()) {
    const found = problem(field)
    if (found) return `question ${i + 1} ${found}`
  }
  const keys = fields.map((f: QuoteField) => f.key)
  if (new Set(keys).size !== keys.length) {
    return "each question needs its own key"
  }
  return null
}

const refused = quoteFormProblem(file)
if (refused) throw new Error(`src/quote-form.json is not valid: ${refused}.`)

export const quoteFields = (file as { fields: QuoteField[] }).fields
