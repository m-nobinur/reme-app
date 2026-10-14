import { z } from "zod"
import { Uuid } from "./common.ts"
import palettes from "./palettes.json" with { type: "json" }
import { Text } from "./text.ts"

/**
 * The closed lists onboarding offers, in the order the owner sees them. The
 * api builds each `ask_choice` from these and checks the answer against
 * them; the web and the starter site read the same ids, so a preset cannot
 * exist on one side only.
 */

/** A choice the owner can make. `hint` is one short line under the label. */
type Preset<Id extends string> = { id: Id; label: string; hint?: string }

type PaletteSpec = Omit<Preset<string>, "id"> & {
  paper: string
  ink: string
  primary: string
  tint: string
  accent: string
  line: string
}

const ids = <T extends readonly { id: string }[]>(list: T) =>
  list.map((each) => each.id) as [T[number]["id"], ...T[number]["id"][]]

export const INDUSTRIES = [
  { id: "cleaning", label: "Cleaning and home services" },
  { id: "chauffeur", label: "Limousine and chauffeur hire" },
  { id: "legal", label: "Legal and consultancy" },
  { id: "health", label: "Health and wellbeing" },
  { id: "beauty", label: "Beauty and salon" },
  { id: "food", label: "Food and hospitality" },
  { id: "trades", label: "Trades and construction" },
  { id: "automotive", label: "Automotive and repair" },
  { id: "property", label: "Property and real estate" },
  { id: "education", label: "Education and coaching" },
  { id: "events", label: "Events and entertainment" },
  { id: "retail", label: "Retail and e-commerce" },
] as const satisfies readonly Preset<string>[]
export const IndustryId = z.enum(ids(INDUSTRIES))

export const PRONOUNS = [
  { id: "he_him", label: "he/him" },
  { id: "she_her", label: "she/her" },
  { id: "they_them", label: "they/them" },
] as const satisfies readonly Preset<string>[]
export const PronounId = z.enum(ids(PRONOUNS))

export const TONES = [
  { id: "friendly", label: "Friendly", hint: "Warm and approachable" },
  { id: "professional", label: "Professional", hint: "Polished and precise" },
  { id: "casual", label: "Casual", hint: "Relaxed and chatty" },
] as const satisfies readonly Preset<string>[]
export const ToneId = z.enum(ids(TONES))

export const TEMPLATES = [
  {
    id: "classic",
    label: "Classic",
    hint: "Trust first. Split header, service cards, clear steps.",
  },
  {
    id: "modern",
    label: "Modern",
    hint: "Light and image-led. Centred header, room to breathe.",
  },
  {
    id: "bold",
    label: "Bold",
    hint: "High contrast. Compact header, figures up front.",
  },
] as const satisfies readonly Preset<string>[]
export const TemplateId = z.enum(ids(TEMPLATES))

/** A colour as `#rrggbb`, lower case: what the starter site's theme takes. */
export const HexColour = z.string().regex(/^#[0-9a-f]{6}$/)

/**
 * Each palette is the six roles of `Palette` (design.ts); `brand` is its
 * `primary` and `swatches` the four the owner sees. The AA pairs
 * `PALETTE_AA_PAIRS` names hold for every palette. The values are in
 * `palettes.json`: colour literals are data here, and the lint rule that
 * keeps them out of code reads only code.
 */
export const PaletteId = z.enum([
  "ocean",
  "classic_blue",
  "harbour",
  "lagoon",
  "forest",
  "sage",
  "sunset",
  "mocha",
  "cardinal",
  "berry",
  "burgundy",
  "midnight",
  "damson",
  "ultra_violet",
  "graphite",
  "onyx",
  "mint",
  "royal",
  "meadow",
  "pebble",
  "counsel",
  "after_dark",
])
export const PALETTES = PaletteId.options.map((id) => {
  const spec = (palettes as Record<PaletteId, PaletteSpec>)[id]
  return {
    id,
    ...spec,
    /** The colour the site derives the rest from: the role `primary`. */
    brand: spec.primary,
    /** What the owner sees, in `PALETTE_SWATCH` order. */
    swatches: [spec.paper, spec.tint, spec.primary, spec.ink],
  }
})

/** System stacks only: the starter site ships no font files and no script. */
export const FONTS = [
  {
    id: "clean_sans",
    label: "Clean sans",
    hint: "Neutral and easy to read",
    family: "system-ui, sans-serif",
  },
  {
    id: "classic_serif",
    label: "Classic serif",
    hint: "Established and formal",
    family: "ui-serif, Georgia, serif",
  },
  {
    id: "soft_rounded",
    label: "Soft rounded",
    hint: "Friendly and open",
    family: "ui-rounded, system-ui, sans-serif",
  },
] as const satisfies readonly (Preset<string> & { family: string })[]
export const FontId = z.enum(ids(FONTS))

/**
 * `home` and `quote` are always built; the rest are the owner's pick. The
 * starter has no page of its own for gallery, testimonials or faq: each
 * becomes a section on the home page, so the hint says so.
 */
export const PAGES = [
  { id: "home", label: "Home", hint: "Always included" },
  { id: "services", label: "Services", hint: "What you offer" },
  { id: "about", label: "About", hint: "Who is behind the business" },
  {
    id: "gallery",
    label: "Gallery",
    hint: "Photos of your work, as a home page section",
  },
  {
    id: "testimonials",
    label: "Reviews",
    hint: "What customers say, as a home page section",
  },
  { id: "faq", label: "FAQ", hint: "Common questions, as a home page section" },
  {
    id: "service_area",
    label: "Areas we cover",
    hint: "The towns and areas you serve",
  },
  { id: "contact", label: "Contact", hint: "Phone, email and hours" },
  { id: "quote", label: "Request a quote", hint: "Always included" },
] as const satisfies readonly Preset<string>[]
export const PageId = z.enum(ids(PAGES))

/** The pages a site has whether or not the owner picks them. */
export const FIXED_PAGES = [
  "home",
  "quote",
] as const satisfies readonly z.infer<typeof PageId>[]

/** What an owner may upload in onboarding. Raster only: an SVG can carry script. */
export const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024
export const UPLOAD_MAX_FILES = 12

export const UploadType = z.enum(UPLOAD_TYPES)

/** One stored photo. `id` names the object in the org's uploads. */
export const Asset = z.strictObject({
  id: Uuid,
  name: Text(120),
  content_type: UploadType,
  bytes: z.int().positive().max(UPLOAD_MAX_BYTES),
  alt: Text(200).optional(),
})

/** `POST /assets` (multipart, field `files`): the photos it stored. */
export const UploadedAssets = z.strictObject({
  assets: z.array(Asset).min(1).max(UPLOAD_MAX_FILES),
})

/**
 * One question the quote request form asks a customer, beyond the contact
 * details the site always asks (name, email, phone). The owner and the
 * assistant decide these in onboarding from what the business needs to know
 * before it can quote; the starter renders exactly this list, so a limousine
 * firm can ask for a pick-up, a drop-off and passengers while a cleaner asks
 * for rooms and access. `key` names the input; `options` belong to `select`.
 */
export const QUOTE_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "tel",
  "email",
] as const
export const QuoteFieldType = z.enum(QUOTE_FIELD_TYPES)

export const QuoteField = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    label: Text(80),
    type: QuoteFieldType,
    required: z.boolean(),
    hint: Text(120).nullable(),
    options: z.array(Text(60)).min(2).max(12).nullable(),
  })
  .refine((field) => (field.type === "select") === (field.options !== null), {
    path: ["options"],
    message: "options belong to a select, and a select needs them",
  })

/** The most and fewest questions a request form may add. */
export const QUOTE_FIELDS_MIN = 2
export const QUOTE_FIELDS_MAX = 8

export const QuoteFields = z
  .array(QuoteField)
  .min(QUOTE_FIELDS_MIN)
  .max(QUOTE_FIELDS_MAX)
  .refine(
    (fields) => new Set(fields.map((f) => f.key)).size === fields.length,
    {
      message: "each question needs its own key",
    }
  )

/** A preset's `id` for a choice that also takes the owner's own words. */
const orCustom = <T extends z.ZodEnum>(id: T) =>
  z.union([id, z.literal("custom")])

/** The choice-shaped facts' value shapes, for `FactValue` to spread in. */
export const choiceFacts = {
  industry: { name: Text(80), category: IndustryId.nullable() },
  pronouns: { id: PronounId },
  tone: { id: ToneId },
  buildMode: { mode: z.enum(["assistant", "manual"]) },
  template: { id: TemplateId, custom: Text(200).optional() },
  /**
   * A preset, or `custom` with the owner's words, the colour they picked as
   * `brand`, or both. `owner.ts` checks the pairing.
   */
  palette: {
    id: orCustom(PaletteId),
    custom: Text(200).optional(),
    brand: HexColour.optional(),
  },
  font: { id: orCustom(FontId), custom: Text(200).optional() },
  pages: {
    ids: z.array(PageId).min(1).max(PAGES.length),
    custom: Text(200).optional(),
  },
  uploads: { items: z.array(Asset).min(1).max(UPLOAD_MAX_FILES) },
  quoteForm: { fields: QuoteFields },
} as const

export type IndustryId = z.infer<typeof IndustryId>
export type PronounId = z.infer<typeof PronounId>
export type ToneId = z.infer<typeof ToneId>
export type TemplateId = z.infer<typeof TemplateId>
export type PaletteId = z.infer<typeof PaletteId>
export type FontId = z.infer<typeof FontId>
export type PageId = z.infer<typeof PageId>
export type QuoteField = z.infer<typeof QuoteField>
export type Asset = z.infer<typeof Asset>
export type UploadedAssets = z.infer<typeof UploadedAssets>
