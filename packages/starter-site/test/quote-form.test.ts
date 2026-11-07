import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  QUOTE_FIELD_TYPES as CONTRACT_TYPES,
  QUOTE_NOT_SENT_PATH,
  QUOTE_PATH,
  QUOTE_SENT_PATH,
  QUOTE_TRAP_FIELD,
  QuoteFields,
} from "@workspace/contracts"
import { beforeAll, describe, expect, test } from "vitest"
import {
  QUOTE_ACTION,
  QUOTE_FIELD_TYPES,
  QUOTE_NOT_SENT_ID,
  QUOTE_SENT_ID,
  QUOTE_TRAP,
  quoteFormProblem,
} from "../src/quote-form"
import { type Built, build, type Page, ROOT, readPages } from "./build"
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

  test("post where the platform listens, and come back where it sends", () => {
    expect(QUOTE_ACTION).toBe(QUOTE_PATH)
    expect(QUOTE_TRAP).toBe(QUOTE_TRAP_FIELD)
    expect(`/quote/#${QUOTE_SENT_ID}`).toBe(QUOTE_SENT_PATH)
    expect(`/quote/#${QUOTE_NOT_SENT_ID}`).toBe(QUOTE_NOT_SENT_PATH)
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

/** A cleaner's list: the choices and photos the limousine firm does not ask. */
const CLEANER_FORM = {
  fields: [
    {
      key: "property",
      label: "Property",
      type: "select",
      required: true,
      hint: null,
      options: ["Flat", "House", "Office"],
    },
    {
      key: "extras",
      label: "Extras",
      type: "checkbox",
      required: false,
      hint: null,
      options: ["Oven", "Windows", "Fridge"],
    },
    {
      key: "photos",
      label: "Photos of the rooms",
      type: "photos",
      required: false,
      hint: "Helps us quote without a visit",
      options: null,
    },
  ],
}

let limousine: Built | undefined
let cleaner: Built | undefined

beforeAll(async () => {
  ;[limousine, cleaner] = await Promise.all([
    build({ site: FILLED, quoteForm: LIMOUSINE_FORM }),
    build({ site: FILLED, quoteForm: CLEANER_FORM }),
  ])
}, 120_000)
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
    expect([...new Set(asked)]).toEqual(LIMOUSINE_FORM.fields.map((f) => f.key))
    const labelled = (id: string) =>
      elements.some((el) => el.tag === "label" && el.attrs.for === id)
    for (const field of LIMOUSINE_FORM.fields) {
      const id = `quote-q-${field.key}`
      expect(texts, id).toContain(field.label)
      if (field.type === "radio") {
        // One labelled radio per option, each required.
        field.options?.forEach((option, i) => {
          const radio = elements.find((el) => el.attrs.id === `${id}-${i}`)
          expect(radio?.attrs, id).toMatchObject({
            type: "radio",
            value: option,
          })
          expect("required" in (radio?.attrs ?? {}), id).toBe(field.required)
          expect(labelled(`${id}-${i}`), id).toBe(true)
        })
        continue
      }
      const control = elements.find((el) => el.attrs.id === id)
      const tag =
        field.type === "select" || field.type === "textarea"
          ? field.type
          : "input"
      expect(control?.tag, id).toBe(tag)
      if (tag === "input") {
        expect(control?.attrs.type, id).toBe(
          field.type === "datetime" ? "datetime-local" : field.type
        )
      }
      expect("required" in (control?.attrs ?? {}), id).toBe(field.required)
      expect(labelled(id), id).toBe(true)
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

  test("takes photos as files the platform keeps, with links beside them", () => {
    const { elements, texts } = quotePage(cleaner)
    const form = elements.find((el) => el.tag === "form")
    expect(form?.attrs.enctype).toBe("multipart/form-data")
    const photos = elements.find((el) => el.attrs.id === "quote-q-photos")
    expect(photos?.attrs).toMatchObject({
      type: "file",
      name: "photos",
      accept: "image/jpeg,image/png,image/webp",
    })
    expect("required" in (photos?.attrs ?? {})).toBe(false)
    const links = elements.find((el) => el.attrs.id === "quote-q-photos-links")
    expect(links?.attrs.name).toBe("photos_links")
    expect(texts).toContain(FILLED.quotePhotoLinks)
    // A checkbox group lets the visitor tick any of its options.
    const extras = elements.filter((el) => el.attrs.name === "extras")
    expect(extras.map((el) => el.attrs.type)).toEqual([
      "checkbox",
      "checkbox",
      "checkbox",
    ])
  })

  test("draws a few short options as buttons over native radios, and a longer list as before", () => {
    const options = (el: Page["elements"][number]) =>
      el.tag === "div" && (el.attrs.class ?? "").includes("quote-options")
    // Elements come in document order, so a group is the last one opened before its first radio.
    const groupOf = (page: Page, key: string) =>
      page.elements
        .slice(
          0,
          page.elements.findIndex((el) => el.attrs.id === `quote-q-${key}-0`)
        )
        .findLast(options)
    const cleanerPage = quotePage(cleaner)
    const property = cleanerPage.elements.filter(
      (el) => el.attrs.name === "property"
    )
    expect(
      property.map((el) => [el.tag, el.attrs.type, el.attrs.value])
    ).toEqual([
      ["input", "radio", "Flat"],
      ["input", "radio", "House"],
      ["input", "radio", "Office"],
    ])
    for (const [i, radio] of property.entries()) {
      expect("required" in radio.attrs).toBe(true)
      expect(
        cleanerPage.elements.some(
          (el) => el.tag === "label" && el.attrs.for === `quote-q-property-${i}`
        )
      ).toBe(true)
    }
    expect(cleanerPage.texts).toContain("Property")
    expect(groupOf(cleanerPage, "property")?.attrs.class).toContain(
      "quote-buttons"
    )
    // Three short vehicles are buttons; four occasions stay a dropdown, and ticks stay chips.
    const limo = quotePage(limousine)
    expect(groupOf(limo, "vehicle")?.attrs.class).toContain("quote-buttons")
    expect(
      limo.elements.find((el) => el.attrs.id === "quote-q-occasion")?.tag
    ).toBe("select")
    expect(groupOf(cleanerPage, "extras")?.attrs.class).toBe("quote-options")
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
