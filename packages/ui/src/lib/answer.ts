import {
  ANSWER_TEXT_MAX,
  type AskableFactKey,
  FactValue,
  FactValueKey,
  TextAnswerSchema,
} from "@workspace/contracts"

/**
 * How an owner answers one question, derived from the question and never
 * from free text: a `FactValue` key gets that key's native inputs, a closed
 * list of options gets a choice, and anything else gets a text box held to
 * the question's `TextAnswerSchema`. JSON, so it can cross a server function.
 */
export type AnswerSpec =
  | { kind: "fact"; key: AskableFactKey }
  | { kind: "choice"; options: string[] }
  | { kind: "text"; maxLength: number; email: boolean }

/** One native input of a fact's answer. `name` is the field of the fact's value. */
export type FactInput = {
  name: string
  label: string
  type: "text" | "tel" | "email" | "time" | "number"
  maxLength?: number
  min?: number
  max?: number
  step?: string
  autoComplete?: string
  /** The field's value from what the input holds. Trimmed text by default. */
  parse?: (raw: string) => unknown
}

/**
 * A UK number as the owner types it, to E.164. Anything it does not
 * recognise goes through unchanged, and `FactValue` refuses it.
 */
function toE164(raw: string): string {
  // "+44 (0)7700 900123": the bracketed trunk zero is dropped after a
  // country code, or it would land inside the number.
  const digits = raw
    .replace(/^(\s*(?:\+|00)\d{1,3})\s*\(0\)/, "$1")
    .replace(/[\s().-]/g, "")
  if (digits.startsWith("+")) return digits
  if (digits.startsWith("00")) return `+${digits.slice(2)}`
  if (digits.startsWith("0")) return `+44${digits.slice(1)}`
  return digits
}

const number = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw))

/** Items typed one to a line or separated by commas, as a list. */
const items = (raw: string) =>
  raw
    .split(/[\n,;]+/)
    .map((each) => each.trim())
    .filter(Boolean)

const line = (name: string, label: string, maxLength: number) =>
  [{ name, label, type: "text", maxLength }] as const

/**
 * The question and the inputs for each fact an owner types. Every
 * `AskableFactKey` has a row, so a key added to the contract without its
 * question and inputs here fails the build.
 */
export const FACT_INPUTS = {
  "business.name": {
    ask: "What is your business called?",
    fields: [
      {
        name: "name",
        label: "Business name",
        type: "text",
        maxLength: 120,
        autoComplete: "organization",
      },
    ],
  },
  "business.phone": {
    ask: "What number should customers ring?",
    fields: [
      {
        name: "e164",
        label: "Phone number",
        type: "tel",
        autoComplete: "tel",
        parse: toE164,
      },
    ],
  },
  "business.email": {
    ask: "Which email address should enquiries go to?",
    fields: [
      {
        name: "address",
        label: "Email address",
        type: "email",
        maxLength: 254,
        autoComplete: "email",
      },
    ],
  },
  "hours.weekday": {
    ask: "What are your hours on weekdays?",
    fields: [
      { name: "open", label: "Opening time", type: "time" },
      { name: "close", label: "Closing time", type: "time" },
    ],
  },
  "service_area.radius": {
    ask: "Where do you work from, and how far do you travel?",
    fields: [
      {
        name: "centre",
        label: "Town or postcode you work from",
        type: "text",
        maxLength: 80,
      },
      {
        name: "radius_km",
        label: "Distance you travel, in km",
        type: "number",
        min: 1,
        max: 200,
        step: "1",
        parse: number,
      },
    ],
  },
  "business.tagline": {
    ask: "How would you sum up your business in one line?",
    fields: [
      { name: "tagline", label: "Tagline", type: "text", maxLength: 120 },
    ],
  },
  "business.offerings": {
    ask: "What do you sell or offer?",
    fields: [
      {
        name: "items",
        label: "Products or services, separated by commas",
        type: "text",
        parse: items,
      },
    ],
  },
  "business.audience": {
    ask: "Who are your customers?",
    fields: line("text", "Your customers", 500),
  },
  "business.overview": {
    ask: "How does the business run day to day?",
    fields: line("text", "How you work", 800),
  },
  "service_area.text": {
    ask: "Where do you work?",
    fields: line("text", "Towns, regions or postcodes", 200),
  },
  "assistant.name": {
    ask: "What would you like to call your assistant?",
    fields: line("name", "Assistant's name", 40),
  },
  "owner.preferred_name": {
    ask: "What should your assistant call you?",
    fields: line("name", "Your name", 60),
  },
} satisfies Record<
  AskableFactKey,
  {
    /** How onboarding asks for it. */
    ask: string
    fields: readonly FactInput[]
  }
>

/** Whether an owner types this fact, as opposed to picking or uploading it. */
export const askable = (key: FactValueKey): key is AskableFactKey =>
  key in FACT_INPUTS

/** The spec for one `InformationRequest`, from its own fields. */
export function answerSpecOf(request: {
  field: string
  answer_schema: unknown
  options: string[] | null
}): AnswerSpec {
  const key = FactValueKey.safeParse(request.field)
  if (key.success && askable(key.data)) return { kind: "fact", key: key.data }
  if (request.options?.length) {
    return { kind: "choice", options: request.options }
  }
  const schema = TextAnswerSchema.safeParse(request.answer_schema)
  return {
    kind: "text",
    maxLength: schema.data?.maxLength ?? ANSWER_TEXT_MAX,
    email: schema.data?.format === "email",
  }
}

type Parsed = { value: unknown } | { error: string }

const isEmail = (address: string) =>
  FactValue.safeParse({ key: "business.email", value: { address } }).success

/**
 * The answer a filled-in form gives, checked the way the orchestrator will
 * check it, so a wrong value is refused here with a reason rather than by a
 * 400 after a round trip. `read` returns what the named input holds.
 */
export function answerValue(
  spec: AnswerSpec,
  read: (name: string) => string
): Parsed {
  if (spec.kind === "choice") {
    const picked = read("answer")
    return spec.options.includes(picked)
      ? { value: picked }
      : { error: "Pick one of the answers." }
  }
  if (spec.kind === "text") {
    const text = read("answer").trim()
    if (!text) return { error: "Write an answer first." }
    if (text.length > spec.maxLength) {
      return { error: `Keep it to ${spec.maxLength} characters.` }
    }
    if (spec.email && !isEmail(text)) {
      return { error: "Enter an email address, like name@example.com." }
    }
    return { value: text }
  }
  const { fields } = FACT_INPUTS[spec.key]
  const value = Object.fromEntries(
    fields.map((input: FactInput) => {
      const raw = read(input.name)
      return [input.name, input.parse ? input.parse(raw) : raw.trim()]
    })
  )
  const parsed = FactValue.safeParse({ key: spec.key, value })
  if (parsed.success) return { value }
  const issue = parsed.error.issues[0]
  const name = issue?.path[1]
  // `FactValue`'s order check on the hours, which runs once both times parse.
  if (
    spec.key === "hours.weekday" &&
    name === "close" &&
    issue?.code === "custom"
  ) {
    return { error: "Closing time has to be after opening time." }
  }
  const field = fields.find((each: FactInput) => each.name === name)
  return {
    error: field
      ? `Check the ${field.label.toLowerCase()}.`
      : "Check the answer.",
  }
}
