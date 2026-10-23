import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"
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
  /** The four the owner sees, where they are not paper, tint, primary and ink. */
  swatches?: [string, string, string, string]
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

/**
 * The assistant's face: Reme's own first, then three for each pronoun. Each
 * has a drawn idle loop in `packages/ui`; the label is its alt text.
 */
export const AVATARS = [
  { id: "reme", label: "Reme, a robot in a headset", pronouns: null },
  {
    id: "she_1",
    label: "Wavy copper hair and round glasses",
    pronouns: "she_her",
  },
  { id: "she_2", label: "Curly updo and a navy blazer", pronouns: "she_her" },
  { id: "she_3", label: "Black bob and a sage jacket", pronouns: "she_her" },
  {
    id: "he_1",
    label: "Brown hair, glasses and a knit vest",
    pronouns: "he_him",
  },
  { id: "he_2", label: "Short beard and an olive jacket", pronouns: "he_him" },
  { id: "he_3", label: "Blond curls and a red jumper", pronouns: "he_him" },
  {
    id: "they_1",
    label: "Lilac undercut and a grey hoodie",
    pronouns: "they_them",
  },
  {
    id: "they_2",
    label: "Dark curls and round glasses",
    pronouns: "they_them",
  },
  {
    id: "they_3",
    label: "Teal hair and a lavender jumper",
    pronouns: "they_them",
  },
] as const satisfies readonly (Preset<string> & {
  pronouns: (typeof PRONOUNS)[number]["id"] | null
})[]
export const AvatarId = z.enum(ids(AVATARS))

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
  "terracotta",
  "ember",
  "fern",
  "sage_slate",
  "seafoam",
  "evergreen",
  "ocean_deep",
  "mineral",
  "olive_clay",
  "dusty_rose",
  "caramel",
  "charcoal",
  "harbor_blue",
  "slate_mist",
  "garden",
  "teal_tide",
  "mist_teal",
  "stone_sage",
  "night_forest",
  "olive_grove",
  "lagoon_blue",
  "deep_sea",
  "forest_calm",
  "steel_teal",
])

/**
 * The calm palettes the design tray offers first, in an order seeded by
 * org: the palette question shows four, the logo page six, and its Random
 * picks from the rest, never the warm oranges.
 */
export const CALM_PALETTES: readonly PaletteId[] = [
  "mint",
  "mist_teal",
  "garden",
  "stone_sage",
  "slate_mist",
  "harbor_blue",
  "teal_tide",
  "night_forest",
  "olive_grove",
  "lagoon_blue",
  "deep_sea",
  "forest_calm",
  "steel_teal",
  "fern",
  "sage_slate",
  "seafoam",
  "evergreen",
  "ocean_deep",
  "mineral",
  "olive_clay",
  "dusty_rose",
  "caramel",
  "charcoal",
  "royal",
  "meadow",
  "pebble",
]

export const PALETTES = PaletteId.options.map((id) => {
  const spec = (palettes as Record<PaletteId, PaletteSpec>)[id]
  return {
    id,
    ...spec,
    /** The colour the site derives the rest from: the role `primary`. */
    brand: spec.primary,
    /** What the owner sees, in `PALETTE_SWATCH` order. */
    swatches: spec.swatches ?? [spec.paper, spec.tint, spec.primary, spec.ink],
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

/**
 * Every page a Blueprint may plan: the owner's picks and `service`, one page
 * per service at /services/<slug>/, which comes with the services page and is
 * never picked on its own.
 */
export const PLANNED_PAGES = [
  ...PAGES,
  {
    id: "service",
    label: "Each service",
    hint: "A page for each service, with the services page",
  },
] as const satisfies readonly Preset<string>[]
export const PageId = z.enum(ids(PLANNED_PAGES))

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

/**
 * The photos a site asks its owner for, in the order the guide lists them:
 * one wide shot of a finished job for the home page's top, a few of the work
 * for the services, and, if they like, one of them or their team for About.
 * `generated` says whether the builder may draw one the owner did not send;
 * a person is a claim, so the team photo never is. The guide's words are the
 * web's.
 */
export const PHOTO_NEEDS = [
  { id: "hero", count: 1, optional: false, generated: true },
  { id: "work", count: 3, optional: false, generated: true },
  { id: "team", count: 1, optional: true, generated: false },
] as const
export const PhotoNeed = z.enum(ids(PHOTO_NEEDS))

/** What one stored image is for: the business's logo, or the photo need it fills. */
export const AssetUse = z.enum(["logo", ...PhotoNeed.options])

/**
 * One stored image. `id` names the object in the org's uploads. `use` is
 * set by the logo step and by the photo review, never by the client.
 */
export const Asset = z.strictObject({
  id: Uuid,
  name: Text(120),
  content_type: UploadType,
  bytes: z.int().positive().max(UPLOAD_MAX_BYTES),
  alt: Text(200).optional(),
  use: AssetUse.optional(),
})

/** `POST /assets` (multipart, field `files`): the photos it stored. */
export const UploadedAssets = z.strictObject({
  assets: z.array(Asset).min(1).max(UPLOAD_MAX_FILES),
})

/** `POST /assets/review`: the stored photos to read against `PHOTO_NEEDS`. */
export const ReviewPhotosRequest = z.strictObject({
  asset_ids: z.array(Uuid).min(1).max(UPLOAD_MAX_FILES),
})

/**
 * `POST /assets/review`'s answer. A vision call reads each photo: the need
 * it fills (null for one that fills none, such as a blurred shot or a
 * screenshot), alt text, and whether it is good enough for a website. The
 * api writes `use` and `alt` onto `media.uploads`, so `photos` are the
 * stored assets as they now stand. `missing` is each need not yet filled,
 * with how many more it takes; an optional need is listed too, the web
 * decides how to say it.
 */
export const ReviewedPhotos = z.strictObject({
  photos: z
    .array(
      z.strictObject({
        asset: Asset,
        usable: z.boolean(),
        /** Why it is not usable, one short line for the owner. */
        note: Text(120).nullable(),
      })
    )
    .max(UPLOAD_MAX_FILES),
  missing: z
    .array(z.strictObject({ need: PhotoNeed, count: z.int().min(1).max(6) }))
    .max(PHOTO_NEEDS.length),
})

/**
 * All six roles of `Palette` (design.ts), for a palette read from the owner's
 * logo or picture, so the site uses exactly those colours. The api brings
 * `PALETTE_AA_PAIRS` to AA before it is stored.
 */
export const PaletteRoles = z.strictObject({
  paper: HexColour,
  ink: HexColour,
  primary: HexColour,
  tint: HexColour,
  accent: HexColour,
  line: HexColour,
})

/** The four stops a site's palette shows the owner, in `PALETTES[].swatches` order. */
export const PaletteStops = z.strictObject({
  paper: HexColour,
  tint: HexColour,
  primary: HexColour,
  ink: HexColour,
})

/**
 * `POST /palettes/from-image` (multipart, field `file`, one JPEG, PNG or
 * WebP up to `UPLOAD_MAX_BYTES`, not stored): the palette a vision call reads
 * from the owner's picture, with a two-word name. Code checks ink on paper
 * and white or ink on primary reach WCAG AA and darkens or lightens until
 * they do.
 */
export const PaletteFromImage = z.strictObject({
  name: Text(40),
  stops: PaletteStops,
})

/** The palettes one logo is read into: four shown, the rest for Surprise me. */
export const LOGO_PALETTES_MAX = 6

/**
 * `POST /palettes/from-logo`: one vision call per kept logo, then held. Each
 * palette is brought to AA as `PaletteFromImage` is.
 */
export const LogoPalettesRequest = z.strictObject({ asset_id: Uuid })
export const LogoPalettes = z.strictObject({
  palettes: z.array(PaletteFromImage).min(1).max(LOGO_PALETTES_MAX),
})

/**
 * What a logo is made of: a symbol beside the name, the symbol alone, the
 * name alone in its own lettering, the initials, the name inside a badge, or
 * a shape that stands for the business without depicting it. The web shows an example of each; the prompt words
 * are the api's (`logo-style.ts`).
 */
export const LOGO_TYPES = [
  "lockup",
  "icon",
  "wordmark",
  "monogram",
  "emblem",
  "abstract",
] as const
export const LogoType = z.enum(LOGO_TYPES)

/**
 * The looks the logo maker offers, each shown with an example drawn for the
 * logo type picked. The prompt words for each are the api's, the labels and
 * examples the web's. `surprise` draws each variant of a round in a
 * different look.
 */
export const LOGO_STYLES = [
  "minimal",
  "geometric",
  "gradient",
  "mascot",
  "hand_drawn",
  "luxury",
  "retro",
  "three_d",
] as const
export const LogoStyle = z.enum(LOGO_STYLES)

/** What the owner asks the logo maker for. */
export const LogoBrief = z.strictObject({
  /** How they want it to look, in their words; may be empty. */
  description: Text(300).or(z.literal("")),
  /** The colours to draw in, the brand colour first. */
  colors: z.array(HexColour).min(1).max(5),
  type: LogoType,
  style: z.enum([...LOGO_STYLES, "surprise"]),
})

/** The variants one round draws. */
export const LOGO_VARIANTS = 4
/** The most rounds one logo question may draw: a first draft and changes. */
export const LOGO_ROUNDS_MAX = 10
/**
 * Seconds a round waits after the one before it finished, by round: the
 * first draft and one redesign at once, then one minute, five, ten, an
 * hour, and a day for every round after. The api refuses a round asked for
 * early with 429 and `Retry-After`; the web counts the wait down.
 */
export const LOGO_ROUND_WAITS = [0, 0, 60, 300, 600, 3600, 86_400] as const

/**
 * `POST /logos`: draw a round of `LOGO_VARIANTS` logos for one design
 * tray's logo question, named by its tool call. A round after the first
 * carries the owner's `changes`, and `base` when they asked for changes to
 * one variant, which the image model is handed as a reference. The api
 * answers 202 with the round as it starts; the drawing runs on after the
 * response, so a reload loses nothing.
 */
export const DrawLogosRequest = z.strictObject({
  tool_call_id: Text(80),
  brief: LogoBrief,
  changes: Text(300).optional(),
  base: Uuid.optional(),
})

/**
 * One round of logos. Each variant's picture is `GET /photos/{id}`, a PNG
 * on a transparent background; a round still `drawing` lists the ones done
 * so far. `failed` means no model drew any, and the owner may try again at
 * once: a new try replaces a failed round and waits for nothing.
 */
export const LogoRound = z.strictObject({
  round: z.int().min(1).max(LOGO_ROUNDS_MAX),
  status: z.enum(["drawing", "ready", "failed"]),
  variants: z.array(z.strictObject({ id: Uuid })).max(LOGO_VARIANTS),
})

/**
 * `GET /logos?tool_call_id=`: every round drawn for that question, oldest
 * first, and when the next may start: null when it may now, or while a
 * round is drawing; absent once `LOGO_ROUNDS_MAX` are drawn.
 */
export const LogoRounds = z.strictObject({
  rounds: z.array(LogoRound).max(LOGO_ROUNDS_MAX),
  next_at: Timestamp.nullable().optional(),
})

/**
 * `POST /logos/{id}/keep`: the variant the owner picked, stored as their
 * logo. It replaces any logo in `media.uploads` and comes back with `use`
 * "logo". An uploaded logo takes `POST /assets` and then this same call
 * with its asset id, so both paths end in one place.
 */
export const KeptLogo = z.strictObject({ asset: Asset })

/**
 * One question the quote request form asks a customer, beyond the contact
 * details the site always asks (name, email, phone). The owner and the
 * assistant decide these in onboarding from what the business needs to know
 * before it can quote; the starter renders exactly this list, so a limousine
 * firm can ask for a pick-up, a drop-off and passengers while a cleaner asks
 * for rooms and access. `key` names the input; `options` belong to the
 * choices: `select` a dropdown, `radio` one of a few shown at once,
 * `checkbox` any of them. `photos` takes links to pictures, and files too
 * once the site has somewhere to send them.
 */
export const QUOTE_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "date",
  "datetime",
  "select",
  "radio",
  "checkbox",
  "photos",
  "tel",
  "email",
] as const
export const QuoteFieldType = z.enum(QUOTE_FIELD_TYPES)

/** The types a question offers options for. */
export const QUOTE_CHOICE_TYPES = ["select", "radio", "checkbox"] as const
const isChoice = (type: QuoteFieldType) =>
  (QUOTE_CHOICE_TYPES as readonly string[]).includes(type)

export const QuoteField = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    label: Text(80),
    type: QuoteFieldType,
    required: z.boolean(),
    hint: Text(120).nullable(),
    options: z.array(Text(60)).min(2).max(12).nullable(),
  })
  .refine((field) => isChoice(field.type) === (field.options !== null), {
    path: ["options"],
    message:
      "options belong to a select, radio or checkbox, and each of those needs them",
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
  avatar: { id: AvatarId },
  tone: { id: ToneId },
  buildMode: { mode: z.enum(["assistant", "manual"]) },
  template: { id: TemplateId, custom: Text(200).optional() },
  /**
   * A preset, or `custom` with the owner's words, the colour they picked as
   * `brand`, or both; a palette read from their logo or a picture also
   * carries its six `roles`. `owner.ts` checks the pairing.
   */
  palette: {
    id: orCustom(PaletteId),
    custom: Text(200).optional(),
    brand: HexColour.optional(),
    roles: PaletteRoles.optional(),
  },
  font: { id: orCustom(FontId), custom: Text(200).optional() },
  pages: {
    ids: z
      .array(z.enum(ids(PAGES)))
      .min(1)
      .max(PAGES.length),
    custom: Text(200).optional(),
  },
  uploads: { items: z.array(Asset).min(1).max(UPLOAD_MAX_FILES) },
  quoteForm: { fields: QuoteFields },
} as const

export type IndustryId = z.infer<typeof IndustryId>
export type PronounId = z.infer<typeof PronounId>
export type QuoteFieldType = z.infer<typeof QuoteFieldType>
export type AvatarId = z.infer<typeof AvatarId>
export type ToneId = z.infer<typeof ToneId>
export type TemplateId = z.infer<typeof TemplateId>
export type PaletteId = z.infer<typeof PaletteId>
export type FontId = z.infer<typeof FontId>
export type PageId = z.infer<typeof PageId>
export type QuoteField = z.infer<typeof QuoteField>
export type Asset = z.infer<typeof Asset>
export type UploadedAssets = z.infer<typeof UploadedAssets>
export type PhotoNeed = z.infer<typeof PhotoNeed>
export type AssetUse = z.infer<typeof AssetUse>
export type ReviewPhotosRequest = z.infer<typeof ReviewPhotosRequest>
export type ReviewedPhotos = z.infer<typeof ReviewedPhotos>
export type PaletteStops = z.infer<typeof PaletteStops>
export type PaletteRoles = z.infer<typeof PaletteRoles>
export type PaletteFromImage = z.infer<typeof PaletteFromImage>
export type LogoPalettesRequest = z.infer<typeof LogoPalettesRequest>
export type LogoPalettes = z.infer<typeof LogoPalettes>
export type LogoType = z.infer<typeof LogoType>
export type LogoStyle = z.infer<typeof LogoStyle>
export type LogoBrief = z.infer<typeof LogoBrief>
export type DrawLogosRequest = z.infer<typeof DrawLogosRequest>
export type LogoRound = z.infer<typeof LogoRound>
export type LogoRounds = z.infer<typeof LogoRounds>
export type KeptLogo = z.infer<typeof KeptLogo>
