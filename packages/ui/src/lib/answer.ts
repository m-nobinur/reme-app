import {
  ANSWER_TEXT_MAX,
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
  | { kind: "fact"; key: FactValueKey }
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

/** Pounds as typed to pence. `Math.round`, so 12.5 is 1250 and not 1249.99. */
const pence = (raw: string) => Math.round(number(raw) * 100)

/**
 * The question and the inputs for each fact an owner can state. Every
 * `FactValueKey` has a row, so a key added to the contract without its
 * question and inputs here fails the build. Prices are pounds: the owner is a
 * UK sole trader.
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
  "pricing.standard_clean_hourly": {
    ask: "What do you charge an hour for a standard clean?",
    fields: [
      {
        name: "amount_minor",
        label: "Hourly price, in pounds",
        type: "number",
        min: 0.01,
        step: "0.01",
        parse: pence,
      },
    ],
    fixed: { currency: "GBP" },
  },
  "business.tagline": {
    ask: "How would you sum up your business in one line?",
    fields: [
      { name: "tagline", label: "Tagline", type: "text", maxLength: 120 },
    ],
  },
} satisfies Record<
  FactValueKey,
  {
    /** How onboarding asks for it. */
    ask: string
    fields: readonly FactInput[]
    fixed?: Record<string, unknown>
  }
>

/** The spec for one `InformationRequest`, from its own fields. */
export function answerSpecOf(request: {
  field: string
  answer_schema: unknown
  options: string[] | null
}): AnswerSpec {
  const key = FactValueKey.safeParse(request.field)
  if (key.success) return { kind: "fact", key: key.data }
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
  const { fields, ...rest } = FACT_INPUTS[spec.key]
  const value = {
    ...Object.fromEntries(
      fields.map((input: FactInput) => {
        const raw = read(input.name)
        return [input.name, input.parse ? input.parse(raw) : raw.trim()]
      })
    ),
    ...("fixed" in rest ? rest.fixed : {}),
  }
  const parsed = FactValue.safeParse({ key: spec.key, value })
  if (parsed.success) return { value }
  // A format issue comes first; the only custom one is hours out of order.
  if (parsed.error.issues[0]?.code === "custom") {
    return { error: "Closing time has to be after opening time." }
  }
  const name = parsed.error.issues[0]?.path[1]
  const field = fields.find((each: FactInput) => each.name === name)
  return {
    error: field
      ? `Check the ${field.label.toLowerCase()}.`
      : "Check the answer.",
  }
}
