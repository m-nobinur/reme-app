import { describe, expect, it } from "vitest"
import {
  ASK_CHIEF_DESCRIPTION,
  answers,
  OPTIONS_MAX,
  refuseQuestion,
} from "../src/question.ts"

// The R exit's question, as staging logged it on 2026-09-25.
const rExit = {
  field: "hours.saturday",
  answer_schema: {
    type: "object",
    required: ["open", "close"],
    properties: { open: { type: "string" }, close: { type: "string" } },
    additionalProperties: false,
  },
  options: ["null"],
}

describe("the questions ask_chief refuses", () => {
  it("refuses the R exit's question", () => {
    expect(refuseQuestion(rExit)).toMatch(/option/)
    // With a text schema, the "null" option alone is still refused.
    expect(
      refuseQuestion({ ...rExit, answer_schema: { type: "string" } })
    ).toMatch(/option/)
  })

  it("refuses an empty, blank or null option in any case", () => {
    for (const option of ["", "  ", "null", " NULL ", "Null"]) {
      expect(
        refuseQuestion({
          field: "business.parking",
          answer_schema: { type: "string" },
          options: ["Street parking", option],
        })
      ).toMatch(/option/)
    }
  })

  it("refuses options on a FactValue key, and takes it without", () => {
    const ask = { field: "business.email", answer_schema: { type: "object" } }
    expect(
      refuseQuestion({ ...ask, options: ["hello@brightclean.invalid"] })
    ).toMatch(/business\.email/)
    expect(refuseQuestion({ ...ask, options: null })).toBeNull()
    expect(refuseQuestion(ask)).toBeNull()
  })

  it("refuses a schema other than text for any other key", () => {
    for (const answer_schema of [
      rExit.answer_schema,
      { type: "string", pattern: "^(a+)+$" },
      { type: "string", enum: ["Yes", "No"] },
      { type: "string", maxLength: 501 },
    ]) {
      expect(
        refuseQuestion({
          field: "hours.saturday",
          answer_schema,
          options: null,
        })
      ).toMatch(/answer_schema/)
    }
  })

  it("refuses an option the schema does not take, such as an instruction", () => {
    expect(
      refuseQuestion({
        field: "business.bookings_email",
        answer_schema: { type: "string", format: "email" },
        options: ["hello@brightclean.invalid", "Decline to publish an email"],
      })
    ).toMatch(/Decline to publish an email/)
    expect(
      refuseQuestion({
        field: "business.parking",
        answer_schema: { type: "string", maxLength: 5 },
        options: ["Street"],
      })
    ).toMatch(/Street/)
  })

  it("refuses more than ten options", () => {
    const ask = (n: number) =>
      refuseQuestion({
        field: "business.parking",
        answer_schema: { type: "string" },
        options: Array.from({ length: n }, (_, i) => `Bay ${i + 1}`),
      })
    expect(OPTIONS_MAX).toBe(10)
    expect(ask(10)).toBeNull()
    expect(ask(11)).toMatch(/at most 10/)
  })

  it("refuses an option longer than the text cap", () => {
    expect(
      refuseQuestion({
        field: "business.parking",
        answer_schema: { type: "string" },
        options: ["x".repeat(501)],
      })
    ).toMatch(/does not satisfy/)
  })

  it("takes a text question with literal options, or with none", () => {
    expect(
      refuseQuestion({
        field: "business.bookings_email",
        answer_schema: { type: "string", format: "email", maxLength: 254 },
        options: ["hello@brightclean.invalid", "book@brightclean.invalid"],
      })
    ).toBeNull()
    expect(
      refuseQuestion({
        field: "business.parking",
        answer_schema: { type: "string", maxLength: 200 },
      })
    ).toBeNull()
  })
})

describe("what ask_chief tells the model", () => {
  it("says options are literal values and spells out the text schema", () => {
    expect(ASK_CHIEF_DESCRIPTION).toContain("literal values")
    expect(ASK_CHIEF_DESCRIPTION).toContain("Never put an instruction")
    expect(ASK_CHIEF_DESCRIPTION).toContain('exactly {"type":"string"}')
    expect(ASK_CHIEF_DESCRIPTION).toContain("hours.weekday")
  })
})

describe("the answers /answer takes", () => {
  const text = (answer_schema: unknown, options: unknown = null) => ({
    field: "business.parking",
    answer_schema,
    options,
  })

  it("never takes a null or blank text, whatever the question", () => {
    for (const request of [
      text({ type: "string" }),
      rExit,
      { field: "business.parking" },
    ]) {
      for (const value of ["null", " NULL ", "", "   ", null]) {
        expect(answers(request, value)).toBe(false)
      }
    }
  })

  it("holds a text question to its length, format and options", () => {
    const short = text({ type: "string", maxLength: 6 })
    expect(answers(short, "Street")).toBe(true)
    expect(answers(short, "Street parking")).toBe(false)

    const email = text({ type: "string", format: "email" })
    expect(answers(email, "hello@brightclean.invalid")).toBe(true)
    expect(answers(email, "hello at brightclean")).toBe(false)
    // business.email's 254 cap, inside the 500 one.
    expect(answers(email, `${"a".repeat(64)}@${"b".repeat(190)}.invalid`)).toBe(
      false
    )

    // No maxLength never lifts the 500 cap.
    expect(answers(text({ type: "string" }), "x".repeat(500))).toBe(true)
    expect(answers(text({ type: "string" }), "x".repeat(501))).toBe(false)

    const picked = text({ type: "string" }, ["Street", "Driveway"])
    expect(answers(picked, "Driveway")).toBe(true)
    expect(answers(picked, "driveway")).toBe(false)
    expect(answers(picked, "Car park")).toBe(false)
  })

  it("reads an older schema as 1 to 500 characters of text, options aside", () => {
    const older = text(rExit.answer_schema, ["Provide the hours"])
    expect(answers(older, "09:00 to 13:00")).toBe(true)
    expect(answers(older, "x".repeat(500))).toBe(true)
    expect(answers(older, "x".repeat(501))).toBe(false)
    expect(answers(older, { open: "09:00", close: "13:00" })).toBe(false)
  })

  it("takes a FactValue key's value as that key's shape", () => {
    const request = {
      field: "hours.weekday",
      answer_schema: { type: "object" },
    }
    expect(answers(request, { open: "08:00", close: "18:00" })).toBe(true)
    expect(answers(request, "08:00 to 18:00")).toBe(false)
  })
})
