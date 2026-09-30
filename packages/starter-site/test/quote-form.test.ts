import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  QUOTE_FIELD_TYPES as CONTRACT_TYPES,
  QuoteFields,
} from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { QUOTE_FIELD_TYPES, quoteFormProblem } from "../src/quote-form"
import { type Built, build, clean, type Page, ROOT, readPages } from "./build"
import { FILLED, LIMOUSINE_FORM } from "./fixture"

const SHIPPED = JSON.parse(
  readFileSync(join(ROOT, "src/quote-form.json"), "utf8")
) as { fields: Record<string, unknown>[] }

const one = LIMOUSINE_FORM.fields[0] as Record<string, unknown>
const two = LIMOUSINE_FORM.fields[1] as Record<string, unknown>
const withFirst = (patch: Record<string, unknown>) => ({
  fields: [{ ...one, ...patch }, two],
})

/** Files the site must take or refuse exactly as the contract does. */
const CASES: [string, unknown][] = [
  ["the shipped default", SHIPPED],
  ["a limousine firm's list", LIMOUSINE_FORM],
  ["one question", { fields: [one] }],
  [
    "nine questions",
    {
      fields: Array.from({ length: 9 }, (_, i) => ({ ...one, key: `q_${i}` })),
    },
  ],
  ["a repeated key", { fields: [one, one] }],
  ["a key with a capital", withFirst({ key: "Pickup" })],
  ["a one-letter key", withFirst({ key: "p" })],
  ["a blank label", withFirst({ label: "   " })],
  ["a long label", withFirst({ label: "x".repeat(81) })],
  ["an 80 character label", withFirst({ label: "x".repeat(80) })],
  ["a long hint", withFirst({ hint: "x".repeat(121) })],
  ["an unknown type", withFirst({ type: "url" })],
  ["a select with no options", withFirst({ type: "select" })],
  ["options on a text field", withFirst({ options: ["A", "B"] })],
  ["a select with one option", withFirst({ type: "select", options: ["A"] })],
  [
    "a select with a blank option",
    withFirst({ type: "select", options: ["A", " "] }),
  ],
  ["a string for required", withFirst({ required: "yes" })],
  [
    "a missing hint",
    {
      fields: [
        Object.fromEntries(Object.entries(one).filter(([k]) => k !== "hint")),
        two,
      ],
    },
  ],
  ["an extra property", withFirst({ placeholder: "x" })],
  ["a bare array", LIMOUSINE_FORM.fields],
]

describe("the quote form checks", () => {
  test("offer the contract's input types", () => {
    expect([...QUOTE_FIELD_TYPES]).toEqual([...CONTRACT_TYPES])
  })

  for (const [name, value] of CASES) {
    test(`agree with the contract on ${name}`, () => {
      const contract =
        QuoteFields.safeParse((value as { fields?: unknown }).fields).success &&
        !Array.isArray(value)
      expect(
        quoteFormProblem(value) === null,
        String(quoteFormProblem(value))
      ).toBe(contract)
    })
  }
})

let limousine: Built | undefined

beforeAll(async () => {
  limousine = await build({ site: FILLED, quoteForm: LIMOUSINE_FORM })
}, 120_000)

afterAll(() => clean(limousine))

const quotePage = (built: Built | undefined): Page => {
  if (!built) throw new Error("the build did not run")
  const page = readPages(built.dist).find((p) => p.file === "quote/index.html")
  if (!page) throw new Error("no quote page")
  return page
}

describe("a site built with the owner's own questions", () => {
  test("asks exactly those, each a labelled control of its type", () => {
    const { elements, texts } = quotePage(limousine)
    const asked = elements
      .filter(
        (el) => el.attrs.name && (el.attrs.id ?? "").startsWith("quote-q-")
      )
      .map((el) => el.attrs.name)
    expect(asked).toEqual(LIMOUSINE_FORM.fields.map((f) => f.key))
    for (const field of LIMOUSINE_FORM.fields) {
      const id = `quote-q-${field.key}`
      const control = elements.find((el) => el.attrs.id === id)
      const tag =
        field.type === "select" || field.type === "textarea"
          ? field.type
          : "input"
      expect(control?.tag, id).toBe(tag)
      if (tag === "input") expect(control?.attrs.type, id).toBe(field.type)
      expect("required" in (control?.attrs ?? {}), id).toBe(field.required)
      expect(
        elements.some((el) => el.tag === "label" && el.attrs.for === id),
        id
      ).toBe(true)
      expect(texts, id).toContain(field.label)
      if (field.hint) {
        expect(control?.attrs["aria-describedby"], id).toBe(`${id}-hint`)
        expect(texts, id).toContain(field.hint)
      }
    }
    expect(texts).toEqual(
      expect.arrayContaining([
        "Wedding",
        "Airport transfer",
        "Night out",
        "Business",
      ])
    )
  })

  test("drops the starter's questions", () => {
    const { texts } = quotePage(limousine)
    for (const field of SHIPPED.fields) {
      expect(texts).not.toContain(field.label)
    }
    expect(texts).toContain(FILLED.quoteNameLabel)
  })
})

test("a quote-form.json the contract refuses fails the build", async () => {
  await expect(
    build({ site: FILLED, quoteForm: { fields: [one] } })
  ).rejects.toThrow(/quote-form\.json is not valid: it needs 2 to 8 questions/)
}, 120_000)
