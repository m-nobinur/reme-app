import {
  type AskableFactKey,
  dialable,
  FactValue,
  type FactValueKey,
  toE164,
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
  /** An example answer, shown in the empty input. */
  placeholder?: string
  /** What to say when the value is wrong, in place of "Check the {label}." */
  invalid?: string
  /** A check of its own beyond the contract's, on the parsed value. */
  check?: (value: unknown) => boolean
  /** The field's value from what the input holds. Trimmed text by default. */
  parse?: (raw: string) => unknown
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
        placeholder: "+44 161 496 0000",
        invalid: "Enter a valid number customers can ring.",
        check: (value) => typeof value === "string" && dialable(value),
        // What cannot be read stays as typed, for the check to name.
        parse: (raw) => toE164(raw) ?? raw,
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
        placeholder: "hello@yourbusiness.co.uk",
        invalid: "Enter a valid email address.",
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
    ask: "Where are you based, and how far do you travel?",
    fields: [
      {
        name: "centre",
        label: "Town or postcode you work from",
        type: "text",
        maxLength: 80,
        placeholder: "Leeds, or LS1 4AP",
      },
      {
        name: "radius_km",
        label: "Distance you travel, in km",
        type: "number",
        min: 1,
        max: 200,
        step: "1",
        placeholder: "25",
        invalid: "Enter a distance between 1 and 200 km.",
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
  "business.proof": {
    ask: "What helps new customers trust you?",
    fields: line("text", "Years trading, accreditations, guarantees", 600),
  },
  "business.disclaimer": {
    ask: "What regulatory notice must your site carry?",
    fields: line("text", "For example: authorised and regulated by ...", 400),
  },
  "service_area.text": {
    ask: "Which areas do you cover?",
    fields: line("text", "Your town or city, and the areas nearby", 200),
  },
  "assistant.name": {
    ask: "What would you like to call your assistant?",
    fields: [
      {
        name: "name",
        label: "Assistant's name",
        type: "text",
        maxLength: 40,
        placeholder: "Reme",
      },
    ],
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

/**
 * Whether the owner simply says this fact in the chat: one plain text field,
 * with nothing a native input checks. Those get no card.
 */
export const saidInChat = (key: AskableFactKey) => {
  const fields: readonly FactInput[] = FACT_INPUTS[key].fields
  return fields.length === 1 && fields[0]?.type === "text"
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
  const fields: readonly FactInput[] = FACT_INPUTS[spec.key].fields
  const value = Object.fromEntries(
    fields.map((input: FactInput) => {
      const raw = read(input.name)
      return [input.name, input.parse ? input.parse(raw) : raw.trim()]
    })
  )
  // A field's own check first, so its message is the one the owner reads.
  const failed = fields.find(
    (input: FactInput) => input.check && !input.check(value[input.name])
  )
  if (failed) return { error: failed.invalid ?? "Check the answer." }
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
      ? (field.invalid ?? `Check the ${field.label.toLowerCase()}.`)
      : "Check the answer.",
  }
}
