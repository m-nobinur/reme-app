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
  brand: string
  swatches: string[]
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

/**
 * `brand` is the colour the site derives the rest from; `swatches` is what
 * the owner sees. The values are in `palettes.json`: colour literals are
 * data here, and the lint rule that keeps them out of code reads only code.
 */
export const PaletteId = z.enum([
  "ocean",
  "forest",
  "sunset",
  "midnight",
  "graphite",
])
export const PALETTES = PaletteId.options.map((id) => ({
  id,
  ...(palettes as Record<PaletteId, PaletteSpec>)[id],
}))

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

/** `home` and `quote` are always built; the rest are the owner's pick. */
export const PAGES = [
  { id: "home", label: "Home", hint: "Always included" },
  { id: "services", label: "Services", hint: "What you offer" },
  { id: "about", label: "About", hint: "Who is behind the business" },
  { id: "gallery", label: "Gallery", hint: "Photos of your work" },
  { id: "testimonials", label: "Reviews", hint: "What customers say" },
  { id: "faq", label: "FAQ", hint: "Answers to common questions" },
  { id: "service_area", label: "Areas we cover", hint: "Where you work" },
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

/** A preset's `id` for a choice that also takes the owner's own words. */
const orCustom = <T extends z.ZodEnum>(id: T) =>
  z.union([id, z.literal("custom")])

/** The choice-shaped facts' value shapes, for `FactValue` to spread in. */
export const choiceFacts = {
  industry: { name: Text(80), category: IndustryId.nullable() },
  pronouns: { id: PronounId },
  tone: { id: ToneId },
  buildMode: { mode: z.enum(["assistant", "manual"]) },
  template: { id: TemplateId },
  palette: { id: orCustom(PaletteId), custom: Text(200).optional() },
  font: { id: orCustom(FontId), custom: Text(200).optional() },
  pages: {
    ids: z.array(PageId).min(1).max(PAGES.length),
    custom: Text(200).optional(),
  },
  uploads: { items: z.array(Asset).min(1).max(UPLOAD_MAX_FILES) },
} as const

export type IndustryId = z.infer<typeof IndustryId>
export type PronounId = z.infer<typeof PronounId>
export type ToneId = z.infer<typeof ToneId>
export type TemplateId = z.infer<typeof TemplateId>
export type PaletteId = z.infer<typeof PaletteId>
export type FontId = z.infer<typeof FontId>
export type PageId = z.infer<typeof PageId>
export type Asset = z.infer<typeof Asset>
export type UploadedAssets = z.infer<typeof UploadedAssets>
