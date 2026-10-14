import type { FactValueKey } from "@workspace/contracts"
import { formatMoney } from "@workspace/ui/lib/format"

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
  "service_area.text": "Area you cover",
  "assistant.name": "Assistant's name",
  "assistant.pronouns": "Assistant's pronouns",
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

/**
 * A fact's value as a line of text. Values are opaque jsonb that the domain
 * pack validates, so this reads the shapes `FactValue` defines and otherwise
 * shows the raw value. It never invents a sentence around a shape it does not
 * recognise: an unreadable fact is a fact to fix, not to paper over (R8).
 */
export function factText(key: string, raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return String(raw)
  }
  const value = raw as Record<string, unknown>
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
    return `${value.open} to ${value.close}`
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
