import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  FactValueKey,
  INDUSTRY_PACK,
  SECTION_VARIANTS,
} from "@workspace/contracts"
import { describe, expect, test } from "vitest"
import { loadManifests, ROOT } from "../scripts/manifests"
import { ICONS } from "../src/icons"
import { quoteFormProblem } from "../src/quote-form"
import { fields, layout, site } from "../src/site-config"

type Entry = { kind: string; variant?: string }
const recipes = JSON.parse(
  readFileSync(join(ROOT, "src/recipes.json"), "utf8")
) as {
  pages: Record<string, { page: string; kinds: string[]; fields: string[] }>
  packs: Record<
    string,
    {
      order: Record<string, Entry[]>
      cta?: string
      headings?: Record<string, string>
      icons?: string[]
      quoteForm?: unknown[]
    }
  >
}
const variants: Record<string, readonly string[]> = SECTION_VARIANTS
const problems = (page: string, entries: Entry[], allowed: string[]) =>
  entries.flatMap(({ kind, variant }) => [
    ...(allowed.includes(kind) ? [] : [`${page}: ${kind} is not allowed`]),
    ...(variant === undefined || variants[kind]?.includes(variant)
      ? []
      : [`${page}: ${kind} has no variant ${variant}`]),
  ])

describe("the section variants", () => {
  // The contract names each kind's variants and the starter's components
  // implement them; a variant added to one and not the other fails here. A
  // kind with only `default` has one look, so its component has no variant prop.
  const COMPONENT: Record<string, string> = {
    hero: "Hero",
    trust_strip: "TrustStrip",
    service_cards: "ServiceCards",
    steps: "Steps",
    testimonials: "Testimonials",
    faq: "Faq",
    cta_band: "CtaBand",
  }
  const { manifests } = loadManifests()

  test.each(Object.entries(COMPONENT))(
    "%s matches %s's variant prop",
    (kind, name) => {
      const prop = manifests
        .find((manifest) => manifest.component === name)
        ?.props.find((each) => each.name === "variant")
      const declared = [...(prop?.type.matchAll(/"([a-z_]+)"/g) ?? [])].map(
        (match) => String(match[1])
      )
      expect(declared.sort(), name).toEqual([...(variants[kind] ?? [])].sort())
    }
  )

  test("every kind with a variant list is covered above", () => {
    const several = Object.entries(variants)
      .filter(([, list]) => list.length > 1)
      .map(([kind]) => kind)
    expect(several.sort()).toEqual(Object.keys(COMPONENT).sort())
  })
})

describe("the layout", () => {
  test("names kinds and variants the contract knows, on pages that exist", () => {
    for (const [page, entries] of Object.entries(layout)) {
      expect(problems(page, entries, Object.keys(variants))).toEqual([])
      expect(entries[0]?.kind, page).toBe("hero")
    }
    expect(Object.keys(layout).sort()).toEqual(
      Object.keys(recipes.pages).sort()
    )
  })
})

describe("the page recipes", () => {
  test("name a page file that exists and fields that exist", () => {
    for (const recipe of Object.values(recipes.pages)) {
      expect(existsSync(join(ROOT, recipe.page)), recipe.page).toBe(true)
      for (const field of recipe.fields) {
        expect(Object.keys(site), recipe.page).toContain(field)
      }
    }
  })

  test("have a pack for every industry pack, each starting inside its allowed kinds", () => {
    expect(Object.keys(recipes.packs).sort()).toEqual(
      [...new Set(Object.values(INDUSTRY_PACK))].sort()
    )
    for (const [pack, { order }] of Object.entries(recipes.packs)) {
      expect(Object.keys(order).sort(), pack).toEqual(
        Object.keys(recipes.pages).sort()
      )
      for (const [page, entries] of Object.entries(order)) {
        expect(
          problems(
            `${pack}/${page}`,
            entries,
            recipes.pages[page]?.kinds ?? []
          ),
          pack
        ).toEqual([])
        expect(entries[0]?.kind).toBe("hero")
      }
    }
  })

  test("the industry packs carry real headings, icons, a CTA and a valid quote form", () => {
    for (const pack of ["cleaning", "legal", "limousine"]) {
      const p = recipes.packs[pack]
      expect(p.cta, pack).toMatch(/^[A-Z][a-z]+( [a-z]+)+$/)
      for (const [key, value] of Object.entries(p.headings ?? {})) {
        expect(Object.keys(site), `${pack}.${key}`).toContain(key)
        expect(value, `${pack}.${key}`).not.toMatch(
          /[—!]|^(What we do|Services)$/
        )
      }
      expect(Object.keys(p.headings ?? {}).length, pack).toBeGreaterThan(8)
      for (const icon of p.icons ?? []) expect(ICONS, pack).toHaveProperty(icon)
      expect(quoteFormProblem({ fields: p.quoteForm }), pack).toBeNull()
    }
  })

  test("service_business starts where the shipped layout does", () => {
    expect(recipes.packs.service_business.order).toEqual(layout)
  })
})

describe("the facts the site reads", () => {
  // Every fact field names a key the platform can store (FactValue), the
  // reviews included: a key outside it is a field the site can never fill.
  test("are keys FactValue holds", () => {
    const unknown = Object.values(fields).flatMap((field) =>
      field.kind === "fact" && !FactValueKey.safeParse(field.fact_key).success
        ? [field.fact_key]
        : []
    )
    expect(unknown).toEqual([])
  })
})
