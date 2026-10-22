import type { Blueprint, ImageSlot } from "@workspace/contracts"

/**
 * A plan for a made-up business, Mop & Pail Cleaning, in the shapes the
 * planner returns. The photo ids are made up too; nothing here is real.
 */

const slot = (
  n: number,
  page: "home" | "about" | "services",
  section: "hero" | "about" | "service_cards",
  source: "upload" | "generated",
  subject: string
): ImageSlot => ({
  id: `slot_${n}`,
  page,
  section,
  aspect: "16:9" as const,
  resolution: "2K" as const,
  subject,
  alt: subject,
  ...(source === "upload"
    ? {
        source,
        asset_id: `00000000-0000-4000-8000-00000000000${n}`,
      }
    : { source }),
})

export const BLUEPRINT: Blueprint = {
  direction: "calm_daylight",
  fonts: "outfit_figtree",
  palette: { kind: "preset", id: "mint" },
  pages: [
    {
      page: "home",
      sections: [
        {
          kind: "hero",
          variant: "split_arch",
          purpose: "Say what we do",
          content_notes: null,
        },
        {
          kind: "trust_strip",
          variant: "icons",
          purpose: "Insured and vetted",
          content_notes: null,
        },
        {
          kind: "service_cards",
          variant: "photo_cards",
          purpose: "The three services",
          content_notes: null,
        },
        {
          kind: "steps",
          variant: "circles",
          purpose: "How a clean works",
          content_notes: null,
        },
        {
          kind: "faq",
          variant: "split",
          purpose: "Answer the first questions",
          content_notes: null,
        },
        {
          kind: "cta_band",
          variant: "solid",
          purpose: "Ask for a quote",
          content_notes: null,
        },
      ],
    },
    {
      page: "services",
      sections: [
        {
          kind: "hero",
          variant: "text_led",
          purpose: "Introduce the services",
          content_notes: null,
        },
        {
          kind: "service_cards",
          variant: "numbered_rows",
          purpose: "Each service in full",
          content_notes: null,
        },
      ],
    },
    {
      page: "about",
      sections: [
        {
          kind: "hero",
          variant: "text_led",
          purpose: "Who we are",
          content_notes: null,
        },
        {
          kind: "about",
          variant: "default",
          purpose: "The story",
          content_notes: null,
        },
      ],
    },
    {
      page: "quote",
      sections: [
        {
          kind: "quote_form",
          variant: "default",
          purpose: "Ask for a quote",
          content_notes: null,
        },
      ],
    },
  ],
  images: [
    slot(
      1,
      "home",
      "hero",
      "generated",
      "A bright kitchen counter with a folded cloth"
    ),
    slot(
      2,
      "services",
      "service_cards",
      "generated",
      "Gloved hands wiping a window sill"
    ),
    slot(3, "about", "about", "upload", "The two founders at the van"),
  ],
  voice: "Plain, warm and quick to the point.",
  features: [
    "A home page that opens with what you clean and where",
    "Three services, each with its own page and a price guide",
    "A short how-it-works strip so people know what to expect",
    "A quote form that asks for the size of the home and the date",
    "Your phone number on every page",
    "Answers to the five questions customers ask first",
    "An about page with the two of you and your van",
    "Colours and lettering that read as calm and clean",
  ],
}
