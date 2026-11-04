/**
 * The words of the customer-facing request form that no owner question
 * changes, under the starter site's own field names (`site-config.ts`). The
 * site cannot import them, because it builds anywhere, so its defaults are
 * held to these by a test; the owner's form preview reads them from here.
 */
export const QUOTE_FORM_WORDS = {
  quoteContactLegend: "Your details",
  quoteRequestLegend: "Your request",
  quoteNameLabel: "Your name",
  quoteEmailLabel: "Email address",
  quotePhoneLabel: "Phone number",
  quoteChoose: "Choose one",
  quotePhotoLinks: "Links to photos, one per line",
  quoteOptional: "optional",
  quoteSubmit: "Send quote request",
} as const
