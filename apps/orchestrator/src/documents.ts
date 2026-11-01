import {
  type Blueprint,
  type PageDocument,
  SECTION_VARIANTS,
} from "@workspace/contracts"
import { pageFields } from "@workspace/starter-site/page-fields"
import {
  documentPath,
  PAGES,
  type Page,
  seedDocuments,
  servicesOf,
} from "@workspace/starter-site/page-seed"
import { blueprintLayout } from "./blueprint.ts"
import { STARTER_FILES } from "./seed.ts"

/**
 * Page documents on a planned first build (design §1, option A): the writers
 * fill the slots of the starter's src/page-fields.ts, as they always have,
 * and code writes their words into each planned page's document with the
 * Blueprint's sections. So src/site-config.ts holds only the site's own
 * settings, and everything after the writers (the lead, the gates, the
 * critic, every later change) reads and edits documents. A slot's place in
 * the documents comes from the seed itself, so the two cannot drift.
 */

/** Where a site keeps its documents. */
export const DOCUMENTS_DIR = "src/content/pages"

/** The slots whose words are a page's, which the writers fill. */
export const PAGE_FIELDS: ReadonlySet<string> = new Set(Object.keys(pageFields))

/** The slot sheet as the starter ships it: each slot's line, note and default. */
export const SLOT_SHEET = STARTER_FILES["src/page-fields.ts"] as string

/** Between src/site-config.ts and the slot sheet when the writers read both as one text. */
export const SHEET_MARK = "\n// The page slots, which become the documents.\n"

/** Every planned page's document for these values, settings and slots both, as JSON text by path under DOCUMENTS_DIR. */
export function documentFiles(
  values: Readonly<Record<string, string>>,
  plan: Blueprint
): Record<string, string> {
  const layout = blueprintLayout(plan)
  const planned = new Set<string>(
    plan.pages.flatMap(({ page }) =>
      page === "service" ? [] : [documentPath(page as Page)]
    )
  )
  const docs = seedDocuments(
    values,
    layout,
    plan.pages.some((p) => p.page === "about")
  )
  return Object.fromEntries(
    Object.entries(docs)
      .filter(
        ([path]) =>
          planned.has(path) ||
          (path.startsWith("services/") && "service" in layout)
      )
      .map(([path, doc]) => [path, `${JSON.stringify(doc, null, 2)}\n`])
  )
}

type Step = string | number
/** A slot's place: a document, then a section and block by id, then the keys within. */
export type Place = {
  file: string
  section?: string
  block?: string
  at: Step[]
}

const MARK = "\u0000slot\u0000"
/** Every page on every kind, so each slot lands somewhere it can be found. */
const EVERY = Object.fromEntries(
  [...PAGES, "service"].map((page) => [
    page,
    Object.keys(SECTION_VARIANTS).map((kind) => ({ kind })),
  ])
)

function marks(doc: PageDocument, file: string): Place[] {
  const found: Place[] = []
  const walk = (value: unknown, at: Step[], where: Omit<Place, "at">) => {
    if (value === MARK) found.push({ ...where, at })
    else if (Array.isArray(value))
      for (const [i, v] of value.entries()) walk(v, [...at, i], where)
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, [...at, k], where)
  }
  walk(doc.title, ["title"], { file })
  walk(doc.description, ["description"], { file })
  for (const section of doc.sections) {
    const { blocks = [], ...words } = section
    for (const key of ["eyebrow", "heading", "intro"] as const)
      walk(words[key], [key], { file, section: section.id })
    for (const block of blocks) {
      const { id, ...rest } = block
      walk(rest, [], { file, section: section.id, block: id })
    }
  }
  return found
}

let places: Map<string, Place[]> | undefined

/**
 * Where each slot's words land, found by seeding every page with every kind
 * and the slot alone marked; every other slot is filled, so a fallback to it
 * never stands in. A service's page is `services/<N>`, its number.
 */
export function slotPlaces(): Map<string, Place[]> {
  if (places) return places
  const base: Record<string, string> = Object.fromEntries(
    [...PAGE_FIELDS].map((name) => [name, "x"])
  )
  for (const name of [
    "businessName",
    "tagline",
    "overview",
    "audience",
    "proof",
  ])
    base[name] = "x"
  for (let n = 1; n <= 6; n++) {
    base[`service${n}Name`] = `s${n}`
    base[`service${n}Body`] = "x"
  }
  places = new Map()
  for (const slot of PAGE_FIELDS) {
    const docs = seedDocuments({ ...base, [slot]: MARK }, EVERY, true)
    places.set(
      slot,
      Object.entries(docs).flatMap(([path, doc]) =>
        marks(doc, path.replace(/^services\/s(\d)\.json$/, "services/$1"))
      )
    )
  }
  return places
}

/** A place as the lead reads it: `home.json, section faq, block faq-questions, items 3 answer`. */
const placeText = (p: Place) =>
  [
    p.file.replace(/^services\/(\d)$/, "services/<slug of service$1Name>.json"),
    p.section && `section ${p.section}`,
    p.block && `block ${p.block}`,
    p.at.map((s) => (typeof s === "number" ? String(s + 1) : s)).join(" "),
  ]
    .filter(Boolean)
    .join(", ")

/** Where a page slot is in the documents, in words, or null for a setting in src/site-config.ts. */
export function whereIs(slot: string): string | null {
  const [first] = slotPlaces().get(slot) ?? []
  return first ? `${DOCUMENTS_DIR}/${placeText(first)}` : null
}

/** A page slot's words as the documents hold them now, at its first place; undefined where they do not show it. */
export function slotValue(
  slot: string,
  documents: Readonly<Record<string, PageDocument>>,
  values: Readonly<Record<string, string>>
): string | undefined {
  const services = servicesOf(values)
  for (const place of slotPlaces().get(slot) ?? []) {
    const n = /^services\/(\d)$/.exec(place.file)?.[1]
    const slug = n && services.find((s) => s.n === Number(n))?.slug
    const doc = documents[n ? `services/${slug}.json` : place.file]
    const section = place.section
      ? doc?.sections.find((s) => s.id === place.section)
      : doc
    const holder = place.block
      ? (section as { blocks?: { id: string }[] } | undefined)?.blocks?.find(
          (b) => b.id === place.block
        )
      : section
    let value: unknown = holder
    for (const step of place.at)
      value = (value as Record<Step, unknown> | undefined)?.[step]
    if (typeof value === "string") return value
  }
  return undefined
}
