import {
  ANSWER_TEXT_MAX,
  FactValue,
  FactValueKey,
  InformationRequest,
  OwnerAnswerText,
  TextAnswerSchema,
} from "@workspace/contracts"
import { z } from "zod"

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

/**
 * `ask_chief`'s input: the request's own fields, with the option cap and
 * item length stated in the schema the model reads. The contract is not
 * narrowed; older requests keep parsing.
 */
export const AskChiefInput = InformationRequest.pick({
  field: true,
  why: true,
  answer_schema: true,
  blocking: true,
}).extend({
  options: z
    .array(z.string().min(1).max(ANSWER_TEXT_MAX))
    .max(OPTIONS_MAX)
    .nullable(),
})

/** The options a request stores: null for a `FactValue` key or an empty list. */
export function askedOptions(q: {
  field: string
  options?: string[] | null
}): string[] | null {
  return isFactKey(q.field) || !q.options?.length ? null : q.options
}

/** What `ask_chief` tells the model it may ask, in the words `refuseQuestion` enforces. */
export const ASK_CHIEF_DESCRIPTION = [
  "Ask the Chief of Staff for one canonical fact the site needs and does not have, naming the fact key (for example business.phone) and why. This ends your turn; the answer comes back as a new message.",
  `For ${FactValueKey.options.join(", ")} the answer has a fixed shape: send answer_schema {"type":"object"} and no options.`,
  `For any other key the owner answers in text: answer_schema is exactly {"type":"string"}, optionally with "maxLength" (1 to ${ANSWER_TEXT_MAX}) and "format":"email", and no other keyword or object wrapper.`,
  `options is a closed list of literal values the owner picks exactly as written, at most ${OPTIONS_MAX}, each valid under answer_schema, and only when the answer is a choice among known values. Never put an instruction, a question, an empty string or "null" in it.`,
  "Ask only about the business. The build, its files and its tools are yours: never ask the owner to fix them.",
].join("\n")

/**
 * Words that put a question about our build in front of the owner: a path,
 * git, a commit hash, the sandbox. Logged 2026-10-25, after a lost container:
 * "The workspace at /workspace/site is now empty and is not a git repository".
 */
const INTERNALS =
  /\/(?:workspace|opt|tmp)\b|\bgit\b|\brepository\b|\bsandbox\b|\bcontainer\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i

/** Why `ask_chief` refuses this question, for the model to read; null when it may be asked. */
export function refuseQuestion(q: {
  field: string
  why?: string
  answer_schema?: unknown
  options?: string[] | null
}): string | null {
  if (q.why && INTERNALS.test(q.why)) {
    return "Ask the owner only about their business. A problem with the build, its files or its tools is not theirs to fix: carry on, or stop and say so in your report."
  }
  const options = q.options ?? []
  if (isFactKey(q.field)) {
    return options.length
      ? `${q.field} has a fixed shape; ask for it with no options.`
      : null
  }
  if (options.length > OPTIONS_MAX) {
    return `Offer at most ${OPTIONS_MAX} options.`
  }
  if (options.some(placeholder)) {
    return 'An option is a value the owner picks as written; leave out empty and "null" options.'
  }
  const check = textCheck(q.answer_schema)
  if (!check) {
    return `The answer_schema for ${q.field} must be {"type":"string"}, with an optional maxLength of 1 to ${ANSWER_TEXT_MAX} and an optional "format":"email", and nothing else.`
  }
  const bad = options.find((o) => !check.safeParse(o).success)
  return bad === undefined
    ? null
    : `The option "${bad.slice(0, 80)}" does not satisfy the answer_schema. An option is a literal value the owner picks, never an instruction.`
}

/**
 * Whether an owner's value answers this question, as sent. A stored question
 * `ask_chief` would now refuse keeps only what still holds: a schema that
 * parses still checks the text, and its options are dropped, since they were
 * instructions or placeholders rather than values. Any other schema falls
 * back to `OwnerAnswerText`.
 */
export function answers(q: Question, value: unknown): boolean {
  if (isFactKey(q.field)) {
    return FactValue.safeParse({ key: q.field, value }).success
  }
  const check = textCheck(q.answer_schema)
  if (!(check ?? OwnerAnswerText).safeParse(value).success) return false
  if (placeholder(value as string)) return false
  const options =
    Array.isArray(q.options) && q.options.every((o) => typeof o === "string")
      ? (q.options as string[])
      : []
  const held = refuseQuestion({ ...q, options }) === null
  return !held || options.length === 0 || options.includes(value as string)
}
