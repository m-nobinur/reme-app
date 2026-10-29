import {
  AVATARS,
  type FactValueKey,
  FONT_PAIRS,
  FONTS,
  PAGES,
  PALETTES,
  PRONOUNS,
  TEMPLATES,
  TONES,
} from "@workspace/contracts"
import { directionLabel } from "@workspace/ui/lib/blueprint"
import { formatMoney, formatTime } from "@workspace/ui/lib/format"

/** What each fact an owner can state is called on their screens. */
const LABEL: Record<FactValueKey, string> = {
  "business.name": "Business name",
  "business.phone": "Phone number",
  "business.email": "Email address",
  "hours.weekday": "Weekday hours",
  "service_area.radius": "Service area",
  "business.tagline": "Tagline",
  "business.industry": "Industry",
  "business.offerings": "Products and services",
  "business.audience": "Who you serve",
  "business.overview": "How you work",
  "business.proof": "What sets you apart",
  "business.disclaimer": "Regulatory notice",
  "service_area.text": "Area you cover",
  "business.prices": "Your prices",
  "business.enquiries": "How enquiries reach you",
  "owner.priorities": "What to take off your plate",
  "assistant.name": "Assistant's name",
  "assistant.pronouns": "Assistant's pronouns",
  "assistant.avatar": "Assistant's look",
  "assistant.tone": "Assistant's tone",
  "owner.preferred_name": "What the assistant calls you",
  "site.build_mode": "Who builds the site",
  "site.template": "Website template",
  "site.palette": "Website colours",
  "site.font": "Website font",
  "site.direction": "Website look",
  "site.pages": "Website pages",
  "media.uploads": "Your photos",
  "quote.form": "Quote request questions",
  "testimonials.review_1": "First review",
  "testimonials.review_2": "Second review",
}

/** `service_area` to `Service area`. */
export function humanise(value: string): string {
  const words = value.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A fact key as the owner reads it: its label, else its last segment. */
export function factLabel(key: string): string {
  return LABEL[key as FactValueKey] ?? humanise(key.split(".").at(-1) ?? key)
}

/** A preset's label by id; an id no longer offered reads as itself. */
export const presetLabel = (
  presets: readonly { id: string; label: string }[],
  id: string
) => presets.find((each) => each.id === id)?.label ?? id

/**
 * A phone number as it is written in its country: UK numbers as dialled at
 * home ("07700 900123", "020 7946 0000"), US and Canadian numbers in the
 * national form ("(206) 555-0104"), any other as stored in E.164.
 */
// shortcut: UK and North American grouping only, as packages/starter-site/src/phone.ts; libphonenumber when an owner elsewhere signs up.
export function phoneText(e164: string): string {
  const nanp = /^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/.exec(e164)
  if (nanp) return `(${nanp[1]}) ${nanp[2]}-${nanp[3]}`
  const digits = /^\+44(\d{10})$/.exec(e164)?.[1]
  if (!digits) return e164
  const national = `0${digits}`
  // The grouping the starter site uses and tests, so the app and the site
  // write a number alike. 02x: 3+4+4. 011x, 01x1 and 03, 05, 08: 4+3+4.
  // Other 01xxx and 07: 5+6.
  if (national.startsWith("02"))
    return `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`
  return /^0(?:11\d|1\d1|[358])/.test(national)
    ? `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`
    : `${national.slice(0, 5)} ${national.slice(5)}`
}

/** The ids each chosen fact stores, with the labels the owner picked them by. */
const PRESETS: Partial<
  Record<FactValueKey, readonly { id: string; label: string }[]>
> = {
  "assistant.pronouns": PRONOUNS,
  "assistant.tone": TONES,
  "assistant.avatar": AVATARS,
  "site.template": TEMPLATES,
  "site.palette": PALETTES,
  "site.font": [...FONTS, ...FONT_PAIRS],
  "site.pages": PAGES,
}

/** How the site's build is left, by `site.build_mode`. */
const BUILD_MODE: Record<string, string> = {
  assistant: "Your assistant builds it",
  manual: "You build it",
}

/** A stored `08:00` as the app writes a time: `8:00 AM`. */
const clockOf = (hhmm: string): string => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number)
  return formatTime(new Date(Date.UTC(2000, 0, 1, h, m)), "UTC")
}

/**
 * A fact's value as a line of text. Values are opaque jsonb that the domain
 * pack validates, so this reads the shapes `FactValue` defines and otherwise
 * shows the raw value. It never invents a sentence around a shape it does not
 * recognise: an unreadable fact is a fact to fix, not to paper over (R8).
 * Ids read as the labels the owner chose them by, never as stored.
 */
export function factText(key: string, raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return String(raw)
  }
  const value = raw as Record<string, unknown>
  // The owner's own words first, where a choice carries them.
  if (typeof value.custom === "string") return value.custom
  if (value.id === "custom") {
    return key === "site.palette" ? "Your own colours" : "Your own choice"
  }
  const presets = PRESETS[key as FactValueKey]
  if (presets && typeof value.id === "string") {
    return presetLabel(presets, value.id)
  }
  if (presets && Array.isArray(value.ids)) {
    return value.ids.map((id) => presetLabel(presets, String(id))).join(", ")
  }
  if (key === "site.direction" && typeof value.id === "string") {
    return value.id === "builder"
      ? "Left to the builder"
      : directionLabel(value.id)
  }
  if (typeof value.mode === "string") {
    return BUILD_MODE[value.mode] ?? value.mode
  }
  if (typeof value.e164 === "string") return phoneText(value.e164)
  if (typeof value.quote === "string" && typeof value.name === "string") {
    return `"${value.quote}" ${value.name}`
  }
  for (const field of [
    "name",
    "tagline",
    "e164",
    "address",
    "text",
    "custom",
    "brand",
    "id",
    "mode",
  ]) {
    const text = value[field]
    if (typeof text === "string") {
      return text
    }
  }
  const list = value.items ?? value.ids ?? value.fields
  if (Array.isArray(list)) {
    return list
      .map((each) =>
        typeof each === "string"
          ? each
          : ((each as { name?: string; label?: string }).name ??
            (each as { label?: string }).label ??
            "")
      )
      .join(", ")
  }
  if (typeof value.open === "string" && typeof value.close === "string") {
    return `${clockOf(value.open)} to ${clockOf(value.close)}`
  }
  if (typeof value.centre === "string" && typeof value.radius_km === "number") {
    return `${value.centre}, within ${value.radius_km} km`
  }
  if (
    typeof value.amount_minor === "number" &&
    typeof value.currency === "string"
  ) {
    const amount = formatMoney(value.amount_minor, value.currency)
    // The unit comes from the key. Reading "an hour" onto every price would be
    // a claim the fact does not make.
    return key.endsWith("_hourly") ? `${amount} an hour` : amount
  }
  return JSON.stringify(value)
}
