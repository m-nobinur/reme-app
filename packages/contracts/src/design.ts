import { z } from "zod"
import { Uuid } from "./common.ts"
import fonts from "./fonts.json" with { type: "json" }
import {
  type FontId,
  HexColour,
  IndustryId,
  PageId,
  PaletteId,
  PaletteRoles,
  type TemplateId,
} from "./onboarding.ts"
import { Text } from "./text.ts"

/**
 * What the builder plans with and the owner reviews: fonts, palettes with
 * roles, section variants, design directions, the Blueprint and its image
 * slots. Only shapes live here. The direction library, the variants'
 * components and the pair files are the starter site's; a Blueprint validates
 * against these unions without importing it.
 */

const lowerSlug = (max: number) =>
  z.string().regex(new RegExp(`^[a-z][a-z0-9_]{2,${max - 1}}$`))

/** A font weight as a CSS number: 100 to 900 in hundreds. */
const Weight = z.union([
  z.literal(100),
  z.literal(200),
  z.literal(300),
  z.literal(400),
  z.literal(500),
  z.literal(600),
  z.literal(700),
  z.literal(800),
  z.literal(900),
])

/** A family as the font vendor names it, e.g. `Plus Jakarta Sans`. */
const Family = z.string().regex(/^[A-Z][A-Za-z0-9 ]{1,39}$/)

type FontPairKey = keyof typeof fonts

/**
 * The ids are the keys of `fonts.json`, so adding a pair is a data change and
 * the enum follows. `display` is the face headings use; `italic` says the
 * pair's italic of that face carries the accented word of a headline.
 * `body` has no italic: running text never needs one here.
 */
export const FontPairId = z.enum(
  Object.keys(fonts) as [FontPairKey, ...FontPairKey[]]
)

export const FontPair = z.strictObject({
  id: FontPairId,
  label: Text(60),
  display: z.strictObject({
    family: Family,
    weights: z.array(Weight).min(1).max(3),
    italic: z.boolean(),
  }),
  body: z.strictObject({
    family: Family,
    weights: z.array(Weight).min(1).max(3),
  }),
})

export const FONT_PAIRS = FontPairId.options.map((id) =>
  FontPair.parse({ id, ...fonts[id] })
)

/**
 * A palette as six roles, each `#rrggbb`. The owner sees four of them as the
 * swatch strip, in `PALETTE_SWATCH` order. These pairs must read at WCAG AA,
 * 4.5:1, and `PALETTE_AA_PAIRS` names them so the starter's colour tests and
 * the "your own colour" derivation check the same list:
 *
 * - `ink` on `paper`: body text.
 * - `paper` on `primary`: button labels and dark bands.
 * - `ink` on `tint`: text on a tinted band.
 * - `primary` on `paper`: links and headings in the brand colour.
 * - `primary` on `tint`: the same links, eyebrows and numerals on a tinted band.
 *
 * `accent` is for marks and underlines, not text, and `line` for hairlines;
 * neither carries a contrast rule. The JSON Schema cannot compute contrast, so
 * the pairs are a list a test reads, not a refinement.
 */
export const Palette = z.strictObject({
  id: PaletteId,
  label: Text(40),
  paper: HexColour,
  ink: HexColour,
  primary: HexColour,
  tint: HexColour,
  accent: HexColour,
  line: HexColour,
})

export const PALETTE_SWATCH = ["paper", "tint", "primary", "ink"] as const

export const PALETTE_AA_PAIRS = [
  { text: "ink", on: "paper" },
  { text: "paper", on: "primary" },
  { text: "ink", on: "tint" },
  { text: "primary", on: "paper" },
  { text: "primary", on: "tint" },
] as const

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

type SectionKindKey = keyof typeof SECTION_VARIANTS
const SECTION_KINDS = Object.keys(SECTION_VARIANTS) as [
  SectionKindKey,
  ...SectionKindKey[],
]

export const SectionKind = z.enum(SECTION_KINDS)

/** Every variant name, for a place that does not know the kind yet. */
export const SectionVariant = z.enum([
  ...new Set(Object.values(SECTION_VARIANTS).flat()),
] as [string, ...string[]])

const variantOf = <K extends SectionKindKey>(kind: K) =>
  z.enum(SECTION_VARIANTS[kind])

/** A direction id: `calm_daylight`. VS's `directions.json` holds the library. */
export const DirectionId = lowerSlug(32)

/**
 * One complete, tested combination of type, colour, section variants and
 * mood. Data, not code: a direction is a row the planner picks and may adjust
 * on at most two axes. `bands` is how many sections sit on a dark ground:
 * none, one, two, or `inverted` for a dark page with one light band.
 * `ornament`, `image_style` and `voice` are prose the planner and the photo
 * director read; code never branches on them.
 */
export const DesignDirection = z.strictObject({
  id: DirectionId,
  label: Text(40),
  industries: z.array(IndustryId).min(1).max(12),
  fonts: FontPairId,
  palettes: z.array(PaletteId).min(1).max(6),
  hero: variantOf("hero"),
  services: variantOf("service_cards"),
  steps: variantOf("steps"),
  faq: variantOf("faq"),
  cta: variantOf("cta_band"),
  radius: z.enum(["square", "soft", "round"]),
  bands: z.enum(["light", "one_dark", "two_dark", "inverted"]),
  ornament: Text(80),
  image_style: Text(200),
  voice: Text(300),
})

export const IMAGE_ASPECTS = ["16:9", "4:3", "3:4", "1:1", "21:9"] as const

const imageSlot = {
  id: lowerSlug(40),
  page: PageId,
  section: SectionKind,
  aspect: z.enum(IMAGE_ASPECTS),
  resolution: z.enum(["1K", "2K"]),
  /** What the picture shows, in words a photo director can act on. */
  subject: Text(300),
  /** The side copy sits on, so the subject keeps to the other. */
  text_side: z.enum(["left", "right", "none"]).optional(),
  alt: Text(200),
}

/**
 * One picture the site has a place for. `source` is how the review screen and
 * the claims rules tell an owner's photo from a generated one: an upload
 * always names its asset, a generated slot gets its asset once it exists.
 */
export const ImageSlot = z.discriminatedUnion("source", [
  z.strictObject({
    ...imageSlot,
    source: z.literal("upload"),
    asset_id: Uuid,
  }),
  z.strictObject({
    ...imageSlot,
    source: z.literal("generated"),
    asset_id: Uuid.optional(),
  }),
])

/** One section as the planner plans it. The variant is checked against the kind. */
type PlannedSection = z.ZodObject<{
  kind: z.ZodLiteral<SectionKindKey>
  variant: z.ZodEnum<{ [V in string]: V }>
  purpose: z.ZodString
  content_notes: z.ZodNullable<z.ZodString>
}>

const BlueprintSection = z.discriminatedUnion(
  "kind",
  SECTION_KINDS.map((kind) =>
    z.strictObject({
      kind: z.literal(kind),
      variant: variantOf(kind),
      purpose: Text(200),
      content_notes: Text(400).nullable(),
    })
  ) as unknown as [PlannedSection, ...PlannedSection[]]
)

/** The most and fewest lines the owner's card carries. */
export const BLUEPRINT_FEATURES_MIN = 4
export const BLUEPRINT_FEATURES_MAX = 10
export const BLUEPRINT_FEATURE_MAX = 140

/** At most this many sections the builder writes beyond the starter's. */
export const CUSTOM_SECTIONS_MAX = 2

/**
 * What the planner returns and the owner reviews before anything is built.
 * `palette` is a preset, the owner's own colour, which the starter derives
 * the six roles from, or the owner's own palette with all six. Whether pages repeat, `home` and `quote` are present and
 * slot ids are unique is the planner step's check, in code, not a schema
 * rule: a JSON Schema cannot say it and the check needs the fact list anyway.
 * `features` is the card's plain-language list, one line each.
 */
export const Blueprint = z.strictObject({
  direction: DirectionId,
  fonts: FontPairId,
  palette: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("preset"), id: PaletteId }),
    z.strictObject({ kind: z.literal("brand"), brand: HexColour }),
    /** The owner's own palette, read from their logo or a picture, used as it is. */
    z.strictObject({
      kind: z.literal("roles"),
      name: Text(40),
      roles: PaletteRoles,
    }),
  ]),
  pages: z
    .array(
      z.strictObject({
        page: PageId,
        sections: z.array(BlueprintSection).min(1).max(16),
      })
    )
    .min(1)
    .max(9),
  images: z.array(ImageSlot).max(24),
  voice: Text(300),
  features: z
    .array(Text(BLUEPRINT_FEATURE_MAX))
    .min(BLUEPRINT_FEATURES_MIN)
    .max(BLUEPRINT_FEATURES_MAX),
  /** `src/components/custom/<name>.astro`, so the name is a component name. */
  custom_sections: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Z][A-Za-z0-9]{2,39}$/),
        purpose: Text(200),
      })
    )
    .max(CUSTOM_SECTIONS_MAX)
    .optional(),
})

/**
 * The packs a build starts from: copy, recipe and defaults per industry.
 * Three have their own; every other industry reads `service_business`.
 */
export const IndustryPackId = z.enum([
  "cleaning",
  "legal",
  "limousine",
  "service_business",
])

export const INDUSTRY_PACK = {
  cleaning: "cleaning",
  chauffeur: "limousine",
  legal: "legal",
  health: "service_business",
  beauty: "service_business",
  food: "service_business",
  trades: "service_business",
  automotive: "service_business",
  property: "service_business",
  education: "service_business",
  events: "service_business",
  retail: "service_business",
} as const satisfies Record<IndustryId, z.infer<typeof IndustryPackId>>

/**
 * Stored facts hold `template` and `font` ids from before directions and
 * pairs. Both old enums stay accepted input; these maps say what each means
 * now. Total by type, and a test reads every old value. A target direction
 * must exist in the starter's library: VS6 ships `directions.json` with
 * these three, and its test fails if one is missing.
 */
export const LEGACY_TEMPLATE_DIRECTION = {
  classic: "fresh_modern",
  modern: "calm_daylight",
  bold: "bold_young",
} as const satisfies Record<TemplateId, string>

export const LEGACY_FONT_PAIR = {
  clean_sans: "outfit_figtree",
  classic_serif: "newsreader_inter",
  soft_rounded: "fraunces_figtree",
} as const satisfies Record<FontId, FontPairId>

export type FontPairId = z.infer<typeof FontPairId>
export type FontPair = z.infer<typeof FontPair>
export type Palette = z.infer<typeof Palette>
export type SectionKind = z.infer<typeof SectionKind>
export type SectionVariant = z.infer<typeof SectionVariant>
export type DirectionId = z.infer<typeof DirectionId>
export type DesignDirection = z.infer<typeof DesignDirection>
export type ImageSlot = z.infer<typeof ImageSlot>
export type Blueprint = z.infer<typeof Blueprint>
export type IndustryPackId = z.infer<typeof IndustryPackId>
