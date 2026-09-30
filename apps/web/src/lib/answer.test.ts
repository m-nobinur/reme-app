import {
  type AskableFactKey,
  FactValue,
  FactValueKey,
} from "@workspace/contracts"
import {
  type AnswerSpec,
  answerSpecOf,
  answerValue,
  askable,
  FACT_INPUTS,
} from "@workspace/ui/lib/answer"
import { expect, it } from "vitest"

/**
 * How the panel asks a question and checks the answer before it is sent.
 * The check is the orchestrator's: an answer refused here would be refused
 * there, and one accepted here parses as `FactValue` or the question's text.
 */

const form =
  (values: Record<string, string>) =>
  (name: string): string =>
    values[name] ?? ""

it("asks a fact key with that key's inputs, whatever the schema says", () => {
  for (const key of FactValueKey.options.filter(askable)) {
    expect(
      answerSpecOf({
        field: key,
        answer_schema: { type: "object" },
        options: null,
      })
    ).toEqual({ kind: "fact", key })
  }
})

it("offers a closed choice where the team gave options", () => {
  expect(
    answerSpecOf({
      field: "visits.frequency",
      answer_schema: { type: "string" },
      options: ["Weekly", "Monthly"],
    })
  ).toEqual({ kind: "choice", options: ["Weekly", "Monthly"] })
})

it("holds text to the question's TextAnswerSchema", () => {
  expect(
    answerSpecOf({
      field: "bookings.inbox",
      answer_schema: { type: "string", maxLength: 80, format: "email" },
      options: null,
    })
  ).toEqual({ kind: "text", maxLength: 80, email: true })
})

it("falls back to plain text at the owner's cap for a schema it cannot read", () => {
  expect(
    answerSpecOf({
      field: "parking",
      answer_schema: { type: "string", pattern: "^.*$" },
      options: [],
    })
  ).toEqual({ kind: "text", maxLength: 500, email: false })
})

/** A value each fact's inputs accept, as an owner would type it. */
const TYPED: Record<AskableFactKey, Record<string, string>> = {
  "business.name": { name: "Brightclean" },
  "business.phone": { e164: "07700 900123" },
  "business.email": { address: "hello@example.com" },
  "hours.weekday": { open: "08:00", close: "17:30" },
  "service_area.radius": { centre: "Anytown", radius_km: "15" },
  "business.tagline": { tagline: "Homes left spotless" },
  "business.offerings": { items: "Deep cleans, end of tenancy" },
  "business.audience": { text: "Busy families" },
  "business.overview": { text: "Two crews, booked a week ahead" },
  "service_area.text": { text: "Anytown and the villages around it" },
  "assistant.name": { name: "Sam" },
  "owner.preferred_name": { name: "Jo" },
}

it("builds a FactValue from every fact's inputs", () => {
  for (const key of FactValueKey.options.filter(askable)) {
    const parsed = answerValue({ kind: "fact", key }, form(TYPED[key]))
    expect(parsed, key).toHaveProperty("value")
    if ("value" in parsed) {
      expect(FactValue.safeParse({ key, value: parsed.value }).success).toBe(
        true
      )
    }
  }
})

it("turns a UK number into E.164", () => {
  expect(
    answerValue(
      { kind: "fact", key: "business.phone" },
      form({ e164: "07700 900123" })
    )
  ).toEqual({ value: { e164: "+447700900123" } })
})

it("names the input a fact's answer failed on", () => {
  expect(
    answerValue(
      { kind: "fact", key: "hours.weekday" },
      form({ open: "08:00", close: "" })
    )
  ).toEqual({ error: "Check the closing time." })
  expect(
    answerValue({ kind: "fact", key: "business.phone" }, form({ e164: "soon" }))
  ).toEqual({ error: "Check the phone number." })
})

it("refuses a choice that is not one of the options", () => {
  const spec: AnswerSpec = { kind: "choice", options: ["Weekly"] }
  expect(answerValue(spec, form({ answer: "Daily" }))).toHaveProperty("error")
  expect(answerValue(spec, form({ answer: "Weekly" }))).toEqual({
    value: "Weekly",
  })
})

it("refuses blank, overlong and non-email text", () => {
  const text: AnswerSpec = { kind: "text", maxLength: 5, email: false }
  expect(answerValue(text, form({ answer: "  " }))).toHaveProperty("error")
  expect(answerValue(text, form({ answer: "too long" }))).toHaveProperty(
    "error"
  )
  expect(answerValue(text, form({ answer: " yes " }))).toEqual({
    value: "yes",
  })
  const email: AnswerSpec = { kind: "text", maxLength: 254, email: true }
  expect(answerValue(email, form({ answer: "not an address" }))).toHaveProperty(
    "error"
  )
})

it("has native inputs for every fact an owner types", () => {
  expect(Object.keys(FACT_INPUTS).sort()).toEqual(
    [...FactValueKey.options.filter(askable)].sort((a, b) => a.localeCompare(b))
  )
})

it("refuses hours that close before, or when, they open", () => {
  const hours: AnswerSpec = { kind: "fact", key: "hours.weekday" }
  const refused = { error: "Closing time has to be after opening time." }
  expect(answerValue(hours, form({ open: "17:00", close: "08:00" }))).toEqual(
    refused
  )
  expect(answerValue(hours, form({ open: "09:00", close: "09:00" }))).toEqual(
    refused
  )
  expect(answerValue(hours, form({ open: "09:00", close: "09:30" }))).toEqual({
    value: { open: "09:00", close: "09:30" },
  })
  // A close of 00:00 is midnight, the end of the day.
  expect(answerValue(hours, form({ open: "18:00", close: "00:00" }))).toEqual({
    value: { open: "18:00", close: "00:00" },
  })
  expect(answerValue(hours, form({ open: "", close: "08:00" }))).toEqual({
    error: "Check the opening time.",
  })
})

it("drops the UK trunk zero written after the country code", () => {
  const phone: AnswerSpec = { kind: "fact", key: "business.phone" }
  for (const typed of [
    "+44 (0)7700 900123",
    "+44(0)7700900123",
    "0044 (0) 7700 900123",
  ]) {
    expect(answerValue(phone, form({ e164: typed })), typed).toEqual({
      value: { e164: "+447700900123" },
    })
  }
})
