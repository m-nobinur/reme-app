import {
  FactValue,
  FactValueKey,
  OwnerAnswerText,
  TextAnswerSchema,
} from "@workspace/contracts"

/**
 * What a Developer's question may ask, and what an owner's answer to it must
 * be (open item 70). A `FactValue` key's answer is that key's shape, so its
 * question offers no options. Any other key's answer is text: its schema is
 * a `TextAnswerSchema` and its options are literal values from a closed list.
 */

type Question = { field: string; answer_schema?: unknown; options?: unknown }

/** Blank, or the word "null": never a value an owner meant. */
const placeholder = (text: string) =>
  !text.trim() || text.trim().toLowerCase() === "null"

const isFactKey = (field: string) => FactValueKey.safeParse(field).success

/** The most options one question offers. */
export const OPTIONS_MAX = 10

/** `FactValue`'s own `business.email` rule, so the two never differ. */
const isEmail = (address: string) =>
  FactValue.safeParse({ key: "business.email", value: { address } }).success

/**
 * The check a `TextAnswerSchema` stands for, or null for any other schema.
 * It starts from `OwnerAnswerText`, so `maxLength` can only lower the cap.
 */
function textCheck(schema: unknown) {
  const parsed = TextAnswerSchema.safeParse(schema)
  if (!parsed.success) return null
  const { maxLength, format } = parsed.data
  const text = maxLength ? OwnerAnswerText.max(maxLength) : OwnerAnswerText
  return format === "email" ? text.refine(isEmail) : text
}

/** What `ask_chief` tells the model it may ask, in the words `refuseQuestion` enforces. */
export const ASK_CHIEF_DESCRIPTION = [
  "Ask the Chief of Staff for one canonical fact the site needs and does not have. Name the fact key (for example business.phone) and why the site needs it. This ends your turn; the answer comes back as a new message.",
  `For ${FactValueKey.options.join(", ")} the answer has a fixed shape: send answer_schema {"type":"object"} and no options.`,
  'For any other key the owner answers in text. answer_schema is exactly {"type":"string"}, optionally with "maxLength" (1 to 500) and "format":"email", and no other keyword or object wrapper.',
  `options is a closed list of literal values the owner picks exactly as written: at most ${OPTIONS_MAX}, each a valid answer under answer_schema. Never put an instruction, a question, an empty string or "null" in options. Leave options out unless the answer is a choice among known values.`,
].join("\n")

/** Why `ask_chief` refuses this question, for the model to read; null when it may be asked. */
export function refuseQuestion(q: {
  field: string
  answer_schema: unknown
  options?: string[] | null
}): string | null {
  const options = q.options ?? []
  if (options.length > OPTIONS_MAX) {
    return `Offer at most ${OPTIONS_MAX} options.`
  }
  if (options.some(placeholder)) {
    return 'An option is a value the owner picks as written; leave out empty and "null" options.'
  }
  if (isFactKey(q.field)) {
    return options.length
      ? `${q.field} has a fixed shape; ask for it with no options.`
      : null
  }
  const check = textCheck(q.answer_schema)
  if (!check) {
    return `The answer_schema for ${q.field} must be {"type":"string"}, with an optional maxLength of 1 to 500 and an optional "format":"email", and nothing else.`
  }
  const bad = options.find((o) => !check.safeParse(o).success)
  return bad === undefined
    ? null
    : `The option "${bad}" does not satisfy the answer_schema. An option is a literal value the owner picks, never an instruction.`
}

/**
 * Whether an owner's value answers this question, as sent. A question raised
 * before the text rule falls back to 1 to 500 characters with its options
 * ignored, since those options were instructions rather than values.
 */
export function answers(q: Question, value: unknown): boolean {
  if (isFactKey(q.field)) {
    return FactValue.safeParse({ key: q.field, value }).success
  }
  const check = textCheck(q.answer_schema)
  if (!(check ?? OwnerAnswerText).safeParse(value).success) return false
  if (placeholder(value as string)) return false
  const options = Array.isArray(q.options) ? q.options : []
  return !check || options.length === 0 || options.includes(value)
}
