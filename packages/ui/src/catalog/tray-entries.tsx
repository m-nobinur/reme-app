import {
  type AskChoiceInput,
  type AskDesignInput,
  PALETTES,
} from "@workspace/contracts"
import {
  QuestionTray,
  type QuestionTrayStart,
} from "@workspace/ui/components/assistant/question-tray"
import type { CatalogEntry } from "./entries"

/**
 * The question tray in each state the owner can put it in, for a made-up
 * business, "Mop & Pail Cleaning". It sits above a stand-in composer so the
 * docking reads; nothing here is a real answer.
 */

const noop = () => undefined

const card = (
  step: AskChoiceInput["step"],
  options: AskChoiceInput["options"],
  extra: Partial<AskChoiceInput> = {}
): AskChoiceInput => ({
  step,
  options,
  multiple: false,
  preselected: [],
  other: { label: "Write your own", placeholder: "Write your own…" },
  skippable: false,
  ...extra,
})

const PAIRS = [
  ["outfit_figtree", "Outfit · Figtree"],
  ["sora_manrope", "Sora · Manrope"],
  ["instrument_worksans", "Instrument Serif · Work Sans"],
  ["syne_jakarta", "Syne · Plus Jakarta Sans"],
] as const

const LAYOUTS = [
  ["arch_cards", "Arch and photo cards", "split_arch", "photo_cards"],
  ["dark_rows", "Dark centre and rows", "dark_center", "numbered_rows"],
  ["frame_alt", "Framed photo and stories", "split_frame", "alternating"],
  ["type_list", "Type first and a list", "text_led", "practice_list"],
] as const

const TONES = [
  ["plain", "Plain and direct", "Short sentences"],
  ["warm", "Warm and chatty", "Like a neighbour"],
  ["crisp", "Crisp and formal", "Like a letter"],
  ["playful", "Playful", "A little cheeky"],
] as const

const INPUT: AskDesignInput = {
  questions: [
    {
      id: "palette",
      visual: "palette",
      card: card(
        "palette",
        PALETTES.slice(0, 4).map((each) => ({
          id: each.id,
          label: each.label,
          hint: null,
          visual: { kind: "swatches", colors: [...each.swatches] },
        }))
      ),
    },
    {
      id: "lettering",
      visual: "font_pair",
      card: card(
        "font",
        PAIRS.map(([id, label]) => ({
          id,
          label,
          hint: null,
          visual: { kind: "font", family: label.split(" · ")[0] ?? label },
        })),
        { skippable: true }
      ),
    },
    {
      id: "arrangement",
      visual: "layout",
      card: card(
        "template",
        LAYOUTS.map(([id, label]) => ({
          id,
          label,
          hint: null,
          visual: { kind: "template", id: "split_arch" },
        }))
      ),
    },
    {
      id: "tone",
      visual: "text",
      card: card(
        "pages",
        TONES.map(([id, label, hint]) => ({ id, label, hint, visual: null }))
      ),
    },
  ],
}

const PROMPTS = {
  palette: "Which colour palette feels right for Mop & Pail Cleaning?",
  lettering: "Which lettering do you prefer?",
  arrangement: "Which page arrangement do you prefer?",
  tone: "How should Mop & Pail Cleaning sound?",
}

const LAYOUT_MAP = Object.fromEntries(
  LAYOUTS.map(([id, , hero, services]) => [id, { hero, services }])
)

const STATES: [string, QuestionTrayStart | undefined, string?][] = [
  ["Palette, nothing picked", undefined],
  [
    "Palette, one picked",
    { answers: { palette: { choice: PALETTES[1]?.id ?? "" } } },
  ],
  ["Lettering, may be skipped", { index: 1 }],
  [
    "Arrangement, picked",
    { index: 2, answers: { arrangement: { choice: "dark_rows" } } },
  ],
  [
    "Last question, own words typed",
    { index: 3, answers: { tone: { own: "Friendly, but never pushy" } } },
  ],
  ["Collapsed", { index: 1, collapsed: true }],
  ["Phone width", { index: 0 }, "max-w-[22.5rem]"],
  ["Phone width, layout", { index: 2 }, "max-w-[22.5rem]"],
]

const trayCatalog: CatalogEntry[] = [
  {
    name: "QuestionTray",
    render: () => (
      <div className="flex flex-col gap-10">
        {STATES.map(([title, start, width]) => (
          <section
            className={`flex max-w-2xl flex-col gap-3 ${width ?? ""}`}
            key={title}
          >
            <h3 className="font-medium text-muted-foreground text-xs">
              {title}
            </h3>
            <div>
              <QuestionTray
                input={INPUT}
                layouts={LAYOUT_MAP}
                onAnswer={noop}
                onFinish={noop}
                prompts={PROMPTS}
                start={start}
              />
              <div className="rounded-b-3xl border border-border bg-background px-4 py-3 text-muted-foreground text-sm">
                Message Sam
              </div>
            </div>
          </section>
        ))}
      </div>
    ),
  },
]

export { trayCatalog }
