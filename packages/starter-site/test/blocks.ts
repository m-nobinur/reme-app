import { readFileSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { ROOT } from "./build"

export const json = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))
export const owner = { provenance: "owner" } as const

/** A home page whose hero and FAQ take the seed's words and whose new section holds one block of each type. */
export const HOME = {
  page: "home",
  title: "",
  sections: [
    { id: "hero", kind: "hero" },
    {
      id: "everything",
      kind: "content",
      eyebrow: "All of it",
      heading: "What an end of tenancy *covers*",
      intro: "Room by room.",
      blocks: [
        {
          ...owner,
          id: "story",
          type: "prose",
          markdown:
            "## Our story\n\nWe **started** in a *small* flat. <script>alert(1)</script> [Ask us](/contact/) or [this](javascript:alert(1)).\n\n- Ovens\n- Windows",
        },
        {
          ...owner,
          id: "covers",
          type: "checklist",
          heading: "Kitchen",
          items: ["Inside the oven", "Hob"],
        },
        {
          ...owner,
          id: "compare",
          type: "table",
          caption: "Which clean suits which home",
          columns: ["Clean", "Best for"],
          rows: [
            ["Deep clean", "A first visit"],
            ["Weekly", "Busy homes"],
          ],
        },
        {
          ...owner,
          id: "asked",
          type: "faq",
          items: [
            {
              question: "Is the oven included?",
              answer: "Yes, inside and out.",
            },
          ],
        },
        {
          ...owner,
          id: "visit",
          type: "steps",
          items: [{ title: "We arrive", body: "With our own kit." }],
        },
        {
          ...owner,
          id: "why",
          type: "cards",
          items: [
            {
              title: "Insured",
              body: "Covered for your home.",
              icon: "shield",
            },
          ],
        },
        {
          ...owner,
          id: "kitchen",
          type: "media",
          src: "/uploads/block.jpg",
          alt: "A clean kitchen",
          caption: "After",
        },
        { ...owner, id: "keys", type: "callout", text: "Keys by arrangement." },
        {
          ...owner,
          id: "book",
          type: "cta",
          heading: "Moving out soon?",
          body: "Book the clean.",
          label: "Book now",
        },
        {
          ...owner,
          id: "said",
          type: "quote",
          text: "Spotless.",
          author: "Sam",
        },
      ],
    },
    {
      id: "note",
      kind: "custom",
      name: "Note",
      heading: "A note from us",
      blocks: [
        {
          ...owner,
          id: "note-text",
          type: "callout",
          text: "Closed on bank holidays.",
        },
      ],
    },
    { id: "faq", kind: "faq" },
  ],
}

/** The custom section the lint's own fixture holds, so what builds here is what passes there. */
const NOTE = readFileSync(join(ROOT, "test/custom-sections/Banner.astro.txt"))

/** The files that plant HOME in a build: the document, its custom section and its photo. */
export async function everyBlockFiles(): Promise<Record<string, Uint8Array>> {
  const photo = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 90, g: 90, b: 90 },
    },
  })
    .jpeg()
    .toBuffer()
  return {
    "src/content/pages/home.json": json(HOME),
    "src/components/custom/Note.astro": NOTE,
    "src/assets/uploads/block.jpg": photo,
  }
}
