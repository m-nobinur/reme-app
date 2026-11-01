import {
  Block,
  type Blueprint,
  PageDocument,
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
import { z } from "zod"
import { blueprintLayout } from "./blueprint.ts"

/**
 * Page documents on a planned first build (design §3): each writer writes
 * its page's document from the page's content plan, section by section, in
 * the Blueprint's order, and code assembles and checks what they wrote. The
 * skeleton a writer fills is the starter's seed for its sections, so a
 * section reads its words and blocks where the starter looks for them. So
 * src/site-config.ts holds only the site's own settings and the service
 * catalogue, and everything after the writers (the lead, the gates, the
 * critic, every later change) reads and edits documents.
 */

/** Where a site keeps its documents. */
export const DOCUMENTS_DIR = "src/content/pages"

/** The slots whose words are a page's, which the seed reads for a page with no document. */
export const PAGE_FIELDS: ReadonlySet<string> = new Set(Object.keys(pageFields))

type Shape = {
  type?: string
  const?: unknown
  items?: Shape
  properties?: Record<string, Shape>
  required?: string[]
  anyOf?: Shape[]
  oneOf?: Shape[]
}
/** What every block has, named once before each type's own keys. */
const BLOCK_COMMON = new Set(["id", "type", "provenance", "eyebrow", "heading"])
const keysOf = (shape: Shape, skip: ReadonlySet<string>): string[] =>
  Object.entries(shape.properties ?? {})
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => {
      const name = `${key}${shape.required?.includes(key) ? "" : "?"}`
      return value.type === "string" ? name : `${name}: ${shapeText(value)}`
    })
const shapeText = (shape: Shape): string =>
  shape.type === "array"
    ? `[${shape.items ? shapeText(shape.items) : ""}]`
    : shape.type === "object"
      ? `{${keysOf(shape, new Set()).join(", ")}}`
      : "string"

/**
 * Each block type and its own keys, from the contract, for the writers'
 * prompt: `prose {markdown}; ... cta {body, label?, href?}`. Structured
 * output cannot hold them to it: Anthropic refuses the block union in even
 * one section ("The compiled grammar is too large", 2026-11-01).
 */
const blockSchema = z.toJSONSchema(Block, { io: "output" }) as Shape
export const BLOCK_SHAPES = (blockSchema.anyOf ?? blockSchema.oneOf ?? [])
  .map(
    (branch) =>
      `${String(branch.properties?.type?.const)} {${keysOf(branch, BLOCK_COMMON).join(", ")}}`
  )
  .join("; ")

/** The words a writer gives one section. */
export type Words = {
  eyebrow?: string
  heading?: string
  intro?: string
  blocks?: Block[]
}

/** What the writers have written of one page so far. */
export type Written = {
  title?: string
  description?: string
  sections: Record<string, Words>
}

/** Every page slot filled, so the seed lays out each section's every block. */
const FILLED: Record<string, string> = Object.fromEntries([
  ...[...PAGE_FIELDS].map((name) => [name, "x"]),
  ...["businessName", "tagline", "overview", "audience", "proof"].map(
    (name) => [name, "x"]
  ),
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [
    [`service${n}Name`, `s${n}`],
    [`service${n}Body`, "x"],
  ]),
])

/** Keys whose values say what a part is, never words a writer writes. */
const FIXED = new Set([
  "id",
  "type",
  "provenance",
  "kind",
  "variant",
  "name",
  "page",
  "slug",
  "icon",
])

const blank = (value: unknown, key = ""): unknown =>
  FIXED.has(key)
    ? value
    : typeof value === "string"
      ? ""
      : Array.isArray(value)
        ? value.map((v) => blank(v))
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, blank(v, k)])
            )
          : value

/**
 * Each planned page's skeleton, by the file a writer fills: the seed of the
 * Blueprint's sections with every word empty. A service's is
 * `services/<N>.json`, N its place in the offerings, until its name gives
 * the slug.
 */
export function skeletons(plan: Blueprint): Record<string, PageDocument> {
  const layout = blueprintLayout(plan)
  const docs = seedDocuments(
    FILLED,
    layout,
    plan.pages.some((p) => p.page === "about")
  )
  return Object.fromEntries(
    Object.entries(docs)
      .filter(([path]) =>
        path.startsWith("services/")
          ? "service" in layout
          : plan.pages.some(
              (p) =>
                p.page !== "service" && documentPath(p.page as Page) === path
            )
      )
      .map(([path, doc]) => [
        path.replace(/^services\/s(\d)\.json$/, "services/$1.json"),
        blank(doc) as PageDocument,
      ])
  )
}

/**
 * A page's document from its skeleton and what its writers wrote: the
 * Blueprint's sections in order with each writer's words, and the title and
 * description the page's writer gave. A section nobody wrote gives no words,
 * so the starter shows it from the seed until the lead writes them.
 */
export function assemble(
  skeleton: PageDocument,
  written: Written | undefined,
  slug?: string
): PageDocument {
  const { slug: _seeded, ...rest } = skeleton
  return {
    ...rest,
    ...(slug ? { slug } : {}),
    title: written?.title ?? "",
    description: written?.description ?? "",
    sections: skeleton.sections.map((section) => {
      const { id, kind } = section
      const variant = "variant" in section ? section.variant : undefined
      return {
        id,
        kind,
        ...(variant ? { variant } : {}),
        ...(written?.sections[id] ?? {}),
      } as PageDocument["sections"][number]
    }),
  }
}

/** What is wrong with one writer's words for its sections, a line per issue as the schema says it, or null. */
export function wordsProblem(
  skeleton: PageDocument,
  written: Written,
  sections: readonly string[]
): string | null {
  const own = {
    ...skeleton,
    sections: skeleton.sections.filter((s) => sections.includes(s.id)),
  }
  const parsed = PageDocument.safeParse(
    assemble(own, written, skeleton.page === "service" ? "x" : undefined)
  )
  return parsed.success
    ? null
    : parsed.error.issues
        .slice(0, 12)
        .map((i) => `- ${i.path.join(".")}: ${i.message}`)
        .join("\n")
}

/** A skeleton's file under DOCUMENTS_DIR, a service's by the slug its name makes, or null while it has none. */
export function documentFile(
  file: string,
  values: Readonly<Record<string, string>>
): { path: string; slug?: string } | null {
  const n = /^services\/(\d)\.json$/.exec(file)?.[1]
  if (!n) return { path: file }
  const slug = servicesOf(values).find((s) => s.n === Number(n) && s.name)?.slug
  return slug ? { path: documentPath("service", slug), slug } : null
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
