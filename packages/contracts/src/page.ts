import { z } from "zod"

/**
 * One page of a built site as typed data (design §1): ordered sections, each
 * holding typed blocks with stable ids, so the builder, the owner's assistant
 * and a later change can all name "the FAQ on the home page" or "the second
 * card". The starter keeps a copy of this file as src/page-document.ts,
 * importing zod from astro, and validates every document at build; a test
 * holds the two to the same text. So this file imports nothing but zod.
 *
 * Global settings (name, contact, theme) and the photos the build places stay
 * in the site's src/site-config.ts.
 */

/**
 * The variants each section kind has. A kind with one look has `default`.
 * The starter's manifests are the source of truth for this table and VS's
 * drift test fails when they disagree, so a variant is added in both in one
 * change. Kinds are the starter's page-level components; the header and
 * footer belong to the layout, not to a page's section list.
 */
export const SECTION_VARIANTS = {
  hero: ["wash", "split_arch", "split_frame", "dark_center", "text_led"],
  // "phrases" is kept so a stored plan that names it parses; the strip draws icons for both.
  trust_strip: ["icons", "phrases"],
  service_cards: [
    "photo_cards",
    "numbered_rows",
    "alternating",
    "fleet",
    "practice_list",
  ],
  value_props: ["default"],
  steps: ["circles", "dark_band", "timeline"],
  about: ["default"],
  testimonials: ["featured", "wall"],
  gallery: ["default"],
  service_area: ["default"],
  faq: ["split", "stacked"],
  cta_band: ["solid", "photo"],
  contact: ["default"],
  quote_form: ["default"],
} as const

/** The pages a site has a document for; `service` is one per service, by slug. */
export const DOCUMENT_PAGES = [
  "home",
  "about",
  "services",
  "service",
  "service_area",
  "contact",
  "quote",
] as const

/**
 * Who a block's words come from. `owner`: the owner's own words, which
 * support themselves before the claims gate, except a rating, an award or a
 * review, which still needs its source. `facts`: written from the facts.
 * `trade`: the trade's usual practice, labelled as typical.
 */
export const BLOCK_PROVENANCE = ["owner", "facts", "trade"] as const

export const BLOCK_TYPES = [
  "prose",
  "checklist",
  "table",
  "faq",
  "steps",
  "cards",
  "media",
  "callout",
  "cta",
  "quote",
] as const

/** A section or block id: lowercase words joined by hyphens, as "faq" or "deep-clean-checklist". */
export const ContentId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(60)

/** Words on one line; empty leaves that part out. */
const Line = (max: number) => z.string().max(max)

/** A link a visitor may follow: a page of the site, an anchor, the web, an email or a phone. */
export const SafeHref = z
  .string()
  .max(500)
  .regex(/^(?:\/(?!\/)|#|https?:\/\/|mailto:|tel:)\S*$/)

/** What every block has, in the order a document lists it. */
const block = <T extends (typeof BLOCK_TYPES)[number]>(type: T) => ({
  id: ContentId,
  type: z.literal(type),
  provenance: z.enum(BLOCK_PROVENANCE),
  /** A short label above the block's heading. */
  eyebrow: Line(60).optional(),
  heading: Line(200).optional(),
})

const Table = z
  .strictObject({
    ...block("table"),
    caption: Line(200).optional(),
    columns: z.array(Line(120)).min(1).max(8),
    rows: z.array(z.array(Line(500))).max(60),
  })
  .refine((t) => t.rows.every((row) => row.length === t.columns.length), {
    message: "every row has one cell per column",
    path: ["rows"],
  })

/**
 * One block. `prose` is a safe markdown subset (h2, h3, paragraphs, lists,
 * bold, italic, links, tables), rendered with no raw HTML: a tag in it shows
 * as text.
 */
export const Block = z.discriminatedUnion("type", [
  z.strictObject({
    ...block("prose"),
    markdown: z.string().max(20_000),
  }),
  z.strictObject({
    ...block("checklist"),
    items: z.array(Line(300)).max(40),
  }),
  Table,
  z.strictObject({
    ...block("faq"),
    items: z
      .array(z.strictObject({ question: Line(300), answer: Line(2_000) }))
      .max(20),
  }),
  z.strictObject({
    ...block("steps"),
    items: z
      .array(z.strictObject({ title: Line(120), body: Line(1_000) }))
      .max(12),
  }),
  z.strictObject({
    ...block("cards"),
    items: z
      .array(
        z.strictObject({
          title: Line(120),
          body: Line(1_000),
          /** A key of the starter's src/icons.ts; empty picks one from the words. */
          icon: Line(40).optional(),
        })
      )
      .max(12),
  }),
  z.strictObject({
    ...block("media"),
    /** A photo the build placed, as "/uploads/<id>.jpg". */
    src: z
      .string()
      .max(300)
      .regex(/^\/(?!\/)[\w./-]+$/),
    alt: Line(200),
    caption: Line(200).optional(),
  }),
  z.strictObject({
    ...block("callout"),
    text: Line(600),
  }),
  z.strictObject({
    ...block("cta"),
    body: Line(600),
    /** The button's words; empty is the site's call to action. */
    label: Line(60).optional(),
    /** Where the button goes; empty is the site's primary action. */
    href: SafeHref.optional(),
  }),
  z.strictObject({
    ...block("quote"),
    text: Line(1_000),
    author: Line(120),
  }),
])

/** A component name under src/components/custom/, as "Callout". */
export const CustomSectionName = z.string().regex(/^[A-Z][A-Za-z0-9]{2,39}$/)

/**
 * A section's own words. A section that gives none of these keys takes its
 * words from the site's seed (src/site-config.ts's page fields), which is
 * how a site built before documents keeps its copy until its next build
 * writes them out; one that gives any of them is whole as written.
 */
const sectionWords = {
  eyebrow: Line(60).optional(),
  heading: Line(200).optional(),
  /** The lede under the heading, plain words. */
  intro: Line(1_000).optional(),
  blocks: z.array(Block).max(24).optional(),
}

type StarterKind = keyof typeof SECTION_VARIANTS
const STARTER_KINDS = Object.keys(SECTION_VARIANTS) as StarterKind[]

type SectionWords = {
  id: string
  eyebrow?: string
  heading?: string
  intro?: string
  blocks?: Block[]
}

/**
 * One section: a starter kind and its variant (an empty variant takes the
 * direction's), `content`, which shows its blocks under its heading, or
 * `custom`, a section the builder wrote as src/components/custom/<name>.astro,
 * which gets the section as its props.
 */
export type PageSection = SectionWords &
  (
    | {
        [K in StarterKind]: {
          kind: K
          variant?: (typeof SECTION_VARIANTS)[K][number]
        }
      }[StarterKind]
    | { kind: "content" }
    | { kind: "custom"; name: string }
  )

export const PageSection = z.discriminatedUnion("kind", [
  ...STARTER_KINDS.map((kind) =>
    z.strictObject({
      id: ContentId,
      kind: z.literal(kind),
      variant: z.enum(SECTION_VARIANTS[kind]).optional(),
      ...sectionWords,
    })
  ),
  z.strictObject({
    id: ContentId,
    kind: z.literal("content"),
    ...sectionWords,
  }),
  z.strictObject({
    id: ContentId,
    kind: z.literal("custom"),
    name: CustomSectionName,
    ...sectionWords,
  }),
] as unknown as [
  z.ZodObject,
  ...z.ZodObject[],
]) as unknown as z.ZodType<PageSection>

/**
 * One page's document, `src/content/pages/<page>.json`, or
 * `services/<slug>.json` for a service's own page. An empty title or
 * description takes the seed's. Section ids are unique on the page, and so
 * are block ids, so either names one thing.
 */
export const PageDocument = z
  .strictObject({
    page: z.enum(DOCUMENT_PAGES),
    /** A service page's path segment, as "end-of-tenancy"; only on `service`. */
    slug: ContentId.optional(),
    title: Line(120).optional(),
    description: Line(320).optional(),
    sections: z.array(PageSection).max(24),
  })
  .superRefine((doc, ctx) => {
    if ((doc.page === "service") !== (doc.slug !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["slug"],
        message: "a service page has a slug and no other page does",
      })
    const seen = new Set<string>()
    const ids = doc.sections.flatMap((section, i) => [
      { id: section.id, path: ["sections", i, "id"] },
      ...(section.blocks ?? []).map((b, j) => ({
        id: b.id,
        path: ["sections", i, "blocks", j, "id"],
      })),
    ])
    for (const { id, path } of ids) {
      if (seen.has(id))
        ctx.addIssue({ code: "custom", path, message: `id "${id}" repeats` })
      seen.add(id)
    }
  })

export type Block = z.infer<typeof Block>
export type BlockType = Block["type"]
export type PageDocument = z.infer<typeof PageDocument>
