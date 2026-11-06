import {
  type AskChoiceInput,
  type AskDesignInput,
  type AskDesignOutput,
  type Asset,
  CALM_PALETTES,
  FIXED_PAGES,
  FONT_PAIRS,
  LOGO_VARIANTS,
  type LogoBrief,
  type LogoChip,
  type LogoRound,
  PAGES,
  PALETTES,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_TYPES,
} from "@workspace/contracts"
import {
  QuestionTray,
  type QuestionTrayStart,
  ShowFoldedQuestion,
} from "@workspace/ui/components/assistant/question-tray"
import type { TrayServices } from "@workspace/ui/components/assistant/tray-services"
import { ChatServicesProvider } from "@workspace/ui/lib/chat-services"
import type { CatalogEntry } from "./entries"

/**
 * The question tray in each state the owner can put it in, for a made-up
 * business, "Mop & Pail Cleaning". It sits above a stand-in composer, a card of its own, so the
 * docking reads; nothing here is a real answer. The app's services are
 * fakes that answer after a moment, and the logo designs are drawn here.
 */

const noop = () => undefined

/** The palettes in the order the api offers them: the calm ones first. */
const OFFERED = [
  ...CALM_PALETTES.flatMap((id) => PALETTES.filter((each) => each.id === id)),
  ...PALETTES.filter((each) => !CALM_PALETTES.includes(each.id)),
]

const [paper = "", tint = "", primary = "", ink = ""] =
  OFFERED[0]?.swatches ?? []

/** The palettes the fake logo reads into: six of the presets, by their own names. */
const FROM_LOGO = OFFERED.slice(4, 10).map(({ label, swatches }) => {
  const [p = "", t = "", b = "", i = ""] = swatches
  return { name: label, stops: { paper: p, tint: t, primary: b, ink: i } }
})

/** A made-up logo, one per layout a round draws, on a clear background. */
const LOGOS = [
  `<path d="M12 44h24l-3 18H15z" fill="${primary}"/><path d="M18 44c0-8 12-8 12 0" fill="none" stroke="${ink}" stroke-width="3"/><text x="44" y="57" font-family="system-ui" font-weight="700" font-size="14" fill="${ink}">Mop &amp; Pail</text>`,
  `<path d="M52 18h24l-3 18H55z" fill="${primary}"/><path d="M58 18c0-8 12-8 12 0" fill="none" stroke="${ink}" stroke-width="3"/><text x="64" y="66" text-anchor="middle" font-family="system-ui" font-weight="700" font-size="17" fill="${ink}">Mop &amp; Pail</text>`,
  `<text x="64" y="58" text-anchor="middle" font-family="Georgia" font-size="22" fill="${ink}">Mop <tspan fill="${primary}">&amp;</tspan> Pail</text>`,
  `<circle cx="64" cy="48" r="34" fill="none" stroke="${primary}" stroke-width="4"/><path d="M54 36h20l-3 15H57z" fill="${primary}"/><text x="64" y="66" text-anchor="middle" font-family="system-ui" font-weight="800" font-size="7" letter-spacing="1" fill="${ink}">MOP &amp; PAIL</text>`,
].map(
  (drawing) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 96">${drawing}</svg>`)}`
)

/** The three directions chosen for a cleaning business, one design each in a first round. */
const DIRECTIONS = [
  { type: "lockup", style: "minimal" },
  { type: "emblem", style: "retro" },
  { type: "icon", style: "geometric" },
] as const

/** The first design's own ideas for a redesign, as Jev reads them from its picture. */
const IDEAS: LogoChip[] = [
  {
    kind: "detail",
    label: "One-line name",
    change: "the whole name on one line",
  },
  {
    kind: "style",
    label: "Old-school feel",
    change: "an old-school, heritage feel",
    set: { style: "retro" },
  },
  {
    kind: "type",
    label: "Badge shape",
    change: "the name inside a badge",
    set: { type: "emblem" },
  },
  {
    kind: "colour",
    label: "Darker teal",
    change: "a darker teal",
    set: { colors: [ink.toLowerCase()] },
  },
]

const variant = (at: number) => ({
  id: `00000000-0000-4000-8000-00000000000${at}`,
  direction: DIRECTIONS[at % DIRECTIONS.length] ?? DIRECTIONS[0],
  ...(at === 0 ? { chips: IDEAS } : {}),
})
/** When a round started: long enough ago that a ready one is done. */
const STARTED = "2026-11-04T09:00:00Z"
/** A brief set to the colours of the made-up logos, and what the api holds for it. */
const PICKED = {
  description: "A mop and bucket, clean and friendly",
  colours: { custom: [primary, ink] },
  type: "lockup" as const,
  style: "minimal" as const,
}
const DRAWN: LogoBrief = {
  description: "A mop and bucket, clean and friendly",
  colors: [primary.toLowerCase(), ink.toLowerCase()],
  type: "lockup",
  style: "minimal",
}
const ROUND: LogoRound = {
  round: 1,
  status: "ready",
  started_at: STARTED,
  variants: [0, 1, 2].map(variant),
  brief: DRAWN,
}
const KEPT: Asset = {
  id: variant(0).id,
  name: "logo.png",
  content_type: "image/png",
  bytes: 24_000,
  use: "logo",
}

/** Answers after a moment, as the app would. */
const later = <T,>(value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), 1200))

/**
 * Fakes of the app's services, with the logo rounds a state starts from. A
 * round started here lands one design each time the page reads the rounds.
 */
const fakes = (
  given: LogoRound[] = [],
  overrides: Partial<TrayServices> = {}
): TrayServices => {
  const rounds = [...given]
  let started = 0
  return {
    upload: () => later({ assets: [KEPT] }),
    reviewPhotos: () => later({ photos: [], missing: [] }),
    paletteFromImage: () =>
      later({
        name: "Van blue",
        stops: { paper, tint, primary, ink },
      }),
    drawLogos: ({ brief }) => {
      const round: LogoRound = {
        round: rounds.length + 1,
        status: "drawing",
        started_at: new Date().toISOString(),
        variants: [],
        brief,
      }
      rounds.push(round)
      started = round.round
      return later(round)
    },
    logoRounds: () => {
      const last = rounds.at(-1)
      if (last?.round === started && last.status === "drawing") {
        const variants = [...last.variants, variant(last.variants.length)]
        rounds[rounds.length - 1] = {
          ...last,
          variants,
          status: variants.length === LOGO_VARIANTS ? "ready" : "drawing",
        }
      }
      return later({ rounds: [...rounds] })
    },
    keepLogo: (id) => later({ asset: { ...KEPT, id } }),
    logoPalettes: () => later({ palettes: FROM_LOGO }),
    imageUrl: (id) => LOGOS[Number(id.at(-1))] ?? LOGOS[0] ?? "",
    ...overrides,
  }
}

/** The api's answer while the next round waits this many seconds. */
const waiting = (rounds: LogoRound[], seconds: number) => ({
  logoRounds: () =>
    later({
      rounds,
      next_at: new Date(Date.now() + seconds * 1000).toISOString(),
    }),
})

/** The api's reads in turn, the last one repeating: rounds as drawn, or an error as a failed read. */
const reads = (...answers: (LogoRound[] | Error)[]) => {
  let at = 0
  return {
    logoRounds: () => {
      const next = answers[Math.min(at++, answers.length - 1)] ?? []
      return next instanceof Error
        ? Promise.reject(next)
        : later({ rounds: next })
    },
  }
}

const UNREAD = new Error("The designs could not be read")
const HALF_DRAWN: LogoRound[] = [
  {
    round: 1,
    status: "drawing",
    started_at: new Date().toISOString(),
    variants: [variant(0)],
    brief: DRAWN,
  },
]

/** A round asked for early, refused as the api refuses it. */
const refused = {
  drawLogos: () =>
    Promise.reject(
      Object.assign(new Error("Your next designs can start in 5 minutes."), {
        retryAfter: 300,
      })
    ),
}

/** A brief filled in up to each section; the rest unset, as the owner cleared it. */
const UNSET = { colours: null, type: null, style: null }

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

/** The four pairs fitted to a cleaning business, one a mood, then the other four. */
const SUGGESTED_PAIR = "outfit_figtree"
const FITTED = [
  SUGGESTED_PAIR,
  "fraunces_figtree",
  "newsreader_inter",
  "syne_jakarta",
]
const PAIRS = [
  ...FITTED.flatMap((id) => FONT_PAIRS.filter((pair) => pair.id === id)),
  ...FONT_PAIRS.filter((pair) => !FITTED.includes(pair.id)),
]

const LAYOUTS = [
  ["arch_cards", "Arch and photo cards", "split_arch", "photo_cards"],
  ["dark_rows", "Dark centre and rows", "dark_center", "numbered_rows"],
  ["frame_alt", "Split photo and stories", "split_frame", "alternating"],
  ["type_list", "Type first and a list", "text_led", "practice_list"],
] as const

export const INPUT: AskDesignInput = {
  questions: [
    {
      id: "logo",
      question: "Do you have a logo?",
      visual: "logo",
      card: card(
        "template",
        [
          {
            id: "upload",
            label: "Yes, I have my logo",
            hint: null,
            visual: null,
          },
          {
            id: "create",
            label: "No, create one for me",
            hint: null,
            visual: null,
          },
        ],
        { other: null }
      ),
      upload: {
        accept: [...UPLOAD_TYPES],
        max_files: 1,
        max_bytes: UPLOAD_MAX_BYTES,
        skippable: false,
      },
      start: {
        directions: [...DIRECTIONS],
        description: "A mop and bucket, clean and friendly",
      },
    },
    {
      id: "palette",
      question: "Which colour palette feels right for Mop & Pail Cleaning?",
      visual: "palette",
      card: card(
        "palette",
        OFFERED.map((each) => ({
          id: each.id,
          label: each.label,
          hint: null,
          visual: { kind: "swatches", colors: [...each.swatches] },
        })),
        { initial: CALM_PALETTES.slice(0, 4), other: null }
      ),
    },
    {
      id: "lettering",
      question: "Which lettering do you prefer?",
      visual: "font_pair",
      card: card(
        "font",
        PAIRS.map(({ id, label, display, body }) => ({
          id,
          label,
          hint: null,
          visual: {
            kind: "font_pair",
            display: display.family,
            body: body.family,
          },
        })),
        { skippable: true, initial: FITTED, preselected: [SUGGESTED_PAIR] }
      ),
      suggested: SUGGESTED_PAIR,
    },
    {
      id: "arrangement",
      question: "Which page arrangement do you prefer?",
      visual: "layout",
      card: card(
        "template",
        LAYOUTS.map(([id, label, hero, services]) => ({
          id,
          label,
          hint: null,
          visual: { kind: "layout", hero, services },
        }))
      ),
    },
    {
      id: "photos",
      question: "Do you have photos of your work?",
      visual: "photos",
      card: card(
        "template",
        [
          {
            id: "upload",
            label: "Yes, I have photos",
            hint: null,
            visual: null,
          },
          {
            id: "create",
            label: "No, create them for me",
            hint: null,
            visual: null,
          },
        ],
        { other: null }
      ),
      upload: {
        accept: [...UPLOAD_TYPES],
        max_files: UPLOAD_MAX_FILES,
        max_bytes: UPLOAD_MAX_BYTES,
        skippable: false,
      },
    },
    {
      id: "pages",
      question:
        "Which pages should the site have, besides Home and Request a quote?",
      visual: "text",
      card: card(
        "pages",
        PAGES.filter(
          (page) => !(FIXED_PAGES as readonly string[]).includes(page.id)
        ).map(({ id, label, hint }) => ({ id, label, hint, visual: null })),
        { multiple: true }
      ),
    },
  ],
}

/** The logo's two pages, whether they have one and then its designs or upload. */
const LOGO = 0
const DESIGNS = 1
const PALETTE = 2
const LETTERING = 3
const LAYOUT = 4
const PHOTOS = 5
const PAGES_ASKED = 6
const PHONE = "max-w-[22.5rem]"
const SECOND: LogoRound = { ...ROUND, round: 2 }
/** A redesign round with its first design in, and then all three. */
const REDESIGN_DRAWING: LogoRound = {
  ...ROUND,
  round: 2,
  status: "drawing",
  started_at: new Date().toISOString(),
  variants: [variant(3)],
}
const REDESIGN_READY: LogoRound = {
  ...REDESIGN_DRAWING,
  status: "ready",
  variants: [3, 4, 5].map(variant),
}

type State = {
  title: string
  start?: QuestionTrayStart
  input?: AskDesignInput
  /** The logo rounds the fake services hold. */
  rounds?: LogoRound[]
  /** Fake services that answer otherwise. */
  services?: Partial<TrayServices>
  width?: string
}

const STATES: State[] = [
  // No start: nothing draws until No, which starts the first round.
  { title: "Logo, nothing chosen" },
  {
    title: "Logo, a redesign landing",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: { path: "create", brief: PICKED },
    },
    services: reads(
      [ROUND, REDESIGN_DRAWING],
      [ROUND, REDESIGN_DRAWING],
      [ROUND, REDESIGN_READY]
    ),
  },
  {
    title: "Logo, a redesign drawing",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: { path: "create", brief: PICKED },
    },
    services: reads([ROUND, REDESIGN_DRAWING]),
  },
  {
    title: "Logo, designs listed in another order",
    start: { logo: { path: "create", brief: PICKED } },
    services: reads(
      [{ ...ROUND, status: "drawing", variants: [variant(1)] }],
      [{ ...ROUND, status: "drawing", variants: [variant(1)] }],
      [{ ...ROUND, variants: [variant(0), variant(1), variant(2)] }]
    ),
  },
  {
    title: "Logo, back on the question, No picked",
    start: { index: LOGO, logo: { path: "create", brief: PICKED } },
    rounds: [ROUND],
  },
  { title: "Logo, upload", start: { logo: { path: "upload" } } },
  {
    title: "Logo, uploaded and kept",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: { path: "upload" },
    },
  },
  {
    title: "Logo, drawing, nothing yet",
    start: { logo: { path: "create", brief: PICKED } },
    rounds: [
      {
        round: 1,
        status: "drawing",
        started_at: new Date().toISOString(),
        variants: [],
        brief: DRAWN,
      },
    ],
  },
  {
    title: "Logo, drawing",
    start: { logo: { path: "create", brief: PICKED } },
    rounds: [
      {
        round: 1,
        status: "drawing",
        started_at: new Date(Date.now() - 20_000).toISOString(),
        variants: [variant(0)],
        brief: DRAWN,
      },
    ],
  },
  {
    title: "Logo, a design picked",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: { path: "create", brief: PICKED },
    },
    rounds: [ROUND],
  },
  {
    title: "Logo, its ideas late: the fixed ones",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: { ...KEPT, id: variant(1).id } } },
      logo: { path: "create", brief: { ...PICKED, ...DIRECTIONS[1] } },
    },
    rounds: [ROUND],
  },
  {
    title: "Logo, an idea picked: Redesign my logo",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: {
        path: "create",
        brief: {
          ...PICKED,
          style: "retro",
          changes: "an old-school, heritage feel",
        },
        editing: true,
      },
    },
    rounds: [ROUND],
  },
  {
    title: "Logo, before a round: the brief to fill in",
    start: { logo: { path: "create", brief: UNSET } },
  },
  {
    title: "Logo, before a round: own colours",
    start: {
      logo: {
        path: "create",
        brief: { ...UNSET, colours: { custom: [primary] } },
      },
    },
  },
  {
    title: "Logo, the brief open: surprise me picked",
    start: {
      logo: {
        path: "create",
        brief: { ...PICKED, style: "surprise" },
        editing: true,
      },
    },
  },
  {
    title: "Logo, a setting changed while the next round waits",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: { path: "create", brief: { ...PICKED, type: "monogram" } },
    },
    rounds: [ROUND, SECOND],
    services: waiting([ROUND, SECOND], 299),
  },
  {
    title: "Logo, redesign refused for now",
    start: {
      logo: { path: "create", brief: { ...PICKED, style: "retro" } },
    },
    rounds: [ROUND, SECOND],
    services: refused,
  },
  {
    title: "Logo, a second round failed",
    start: { logo: { path: "create", brief: PICKED } },
    rounds: [
      ROUND,
      {
        round: 2,
        status: "failed",
        started_at: STARTED,
        variants: [],
        brief: DRAWN,
      },
    ],
  },
  {
    title: "Logo, the designs could not be read",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: { path: "create", brief: PICKED },
    },
    // Strict mode runs a page's first read twice, so the first answer is spent.
    services: reads(UNREAD, UNREAD, [ROUND]),
  },
  {
    title: "Logo, a read failed while drawing",
    start: { logo: { path: "create", brief: PICKED } },
    services: reads(HALF_DRAWN, HALF_DRAWN, UNREAD, [ROUND]),
  },
  { title: "Palette, nothing picked", start: { index: PALETTE } },
  {
    title: "Palette, one picked",
    start: {
      index: PALETTE,
      answers: { palette: { choice: OFFERED[1]?.id ?? "" } },
    },
  },
  {
    title: "Palette, a surprise from beyond the four shown",
    start: {
      index: PALETTE,
      answers: { palette: { choice: OFFERED[9]?.id ?? "" } },
    },
  },
  {
    title: "Palette, built from the logo",
    start: { index: PALETTE, answers: { logo: { logo: KEPT } } },
  },
  {
    title: "Palette, from the logo, a surprise picked",
    start: {
      index: PALETTE,
      answers: {
        logo: { logo: KEPT },
        palette: { palette: FROM_LOGO[5] as (typeof FROM_LOGO)[number] },
      },
    },
  },
  {
    title: "Palette, reading the logo",
    start: { index: PALETTE, answers: { logo: { logo: KEPT } } },
    services: { logoPalettes: () => new Promise(() => undefined) },
  },
  {
    title: "Palette, the logo could not be read",
    start: { index: PALETTE, answers: { logo: { logo: KEPT } } },
    services: {
      logoPalettes: () => Promise.reject(new Error("Not read")),
    },
  },
  {
    title: "Palette, reading a picture",
    start: { index: PALETTE, reading: true },
  },
  {
    title: "Palette, read from a picture",
    start: {
      index: PALETTE,
      answers: {
        palette: {
          palette: { name: "Van blue", stops: { paper, tint, primary, ink } },
        },
      },
    },
  },
  { title: "Lettering, may be skipped", start: { index: LETTERING } },
  {
    title: "Arrangement, picked",
    start: { index: LAYOUT, answers: { arrangement: { choice: "dark_rows" } } },
  },
  { title: "Photos, nothing yet", start: { index: PHOTOS } },
  {
    title: "Last question, own words typed",
    start: {
      index: PAGES_ASKED,
      answers: { pages: { own: "A page for our prices" } },
    },
  },
  {
    title: "Pages, several ticked",
    start: {
      index: PAGES_ASKED,
      answers: { pages: { choices: ["services", "gallery", "faq"] } },
    },
  },
  {
    // Every pick made, as a new owner's tray opens once its logo lands.
    title: "Every pick made",
    start: {
      index: PALETTE,
      answers: {
        logo: { logo: KEPT },
        palette: { choice: OFFERED[0]?.id ?? "" },
        lettering: { choice: "outfit_figtree" },
        arrangement: { choice: "dark_rows" },
        photos: { photos: [], create: true },
        pages: { choices: ["services", "faq"] },
      },
    },
  },
  { title: "Collapsed", start: { index: LETTERING, collapsed: true } },
  { title: "Phone width, logo", width: PHONE },
  {
    title: "Phone width, the brief open",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: { path: "create", brief: PICKED, editing: true },
    },
    rounds: [ROUND],
    width: PHONE,
  },
  {
    title: "Phone width, logo designs",
    start: {
      index: DESIGNS,
      answers: { logo: { logo: KEPT } },
      logo: { path: "create", brief: PICKED },
    },
    rounds: [ROUND],
    width: PHONE,
  },
  { title: "Phone width, palette", start: { index: PALETTE }, width: PHONE },
  {
    title: "Phone width, lettering",
    start: { index: LETTERING },
    width: PHONE,
  },
  { title: "Phone width, layout", start: { index: LAYOUT }, width: PHONE },
  { title: "Phone width, photos", start: { index: PHOTOS }, width: PHONE },
]

/** Each state's tray, under its title; `name` keeps each entry's logo brief its own. */
function States({ name, states }: { name: string; states: readonly State[] }) {
  return (
    <div className="flex flex-col gap-10">
      {states.map(({ title, start, input, rounds, services, width }) => (
        <section
          className={`flex max-w-2xl flex-col gap-3 ${width ?? ""}`}
          key={title}
        >
          <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
          <div className="flex flex-col gap-2">
            <ChatServicesProvider value={{ tray: fakes(rounds, services) }}>
              <QuestionTray
                businessName="Mop & Pail Cleaning"
                input={input ?? INPUT}
                onAnswer={noop}
                onFinish={noop}
                start={start}
                // One call per state, so each keeps its own logo brief.
                toolCallId={`catalog:${name}:${title}`}
              />
            </ChatServicesProvider>
            <div className="rounded-4xl border border-border bg-card px-5 py-4 text-muted-foreground text-sm">
              Tell Sam what to do instead…
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}

/** The states titled `titles`, for a part drawn in only some of them. */
const only = (...titles: string[]) =>
  STATES.filter((state) => titles.includes(state.title))

const trayCatalog: CatalogEntry[] = [
  ...(["QuestionTray", "TrayFrame"] as const).map((name) => ({
    name,
    render: () => <States name={name} states={STATES} />,
  })),
  // The logo page's parts, and the services it draws designs with.
  ...(
    ["TrayLogo", "Ways", "Fold", "Summary", "DropTile", "RadioTile"] as const
  ).map((name) => ({
    name,
    render: () => (
      <States
        name={name}
        states={only(
          "Logo, nothing chosen",
          "Logo, upload",
          "Logo, a design picked"
        )}
      />
    ),
  })),
  // The palette page's parts, its own and those built from the logo.
  ...(["PalettePicture", "Swatches", "Surprise", "LogoPalettes"] as const).map(
    (name) => ({
      name,
      render: () => (
        <States
          name={name}
          states={only(
            "Palette, nothing picked",
            "Palette, built from the logo"
          )}
        />
      ),
    })
  ),
  {
    // Only there while a tray is folded, as the waiting line and the panel show it.
    name: "ShowFoldedQuestion",
    render: () => (
      <div className="flex flex-col gap-3">
        <ShowFoldedQuestion className="self-start text-sm" />
        <States name="ShowFoldedQuestion" states={only("Collapsed")} />
      </div>
    ),
  },
]

/** A finished tray: the logo kept, a preset palette, a pair, a layout, photos made, two pages. */
const DESIGN_ANSWERS: AskDesignOutput = {
  answers: {
    logo: { logo: KEPT },
    palette: { choice: OFFERED[0]?.id ?? "" },
    lettering: { choice: SUGGESTED_PAIR },
    arrangement: { choice: LAYOUTS[0][0] },
    photos: { photos: [], create: true },
    pages: { choices: ["services", "about"] },
  },
  skip_all: false,
}

/** The services the catalog's trays read, with no rounds started. */
const SERVICES = fakes()

export { DESIGN_ANSWERS, SERVICES as TRAY_SERVICES, trayCatalog }
