import {
  type AskChoiceInput,
  type AskDesignInput,
  type Asset,
  FIXED_PAGES,
  LOGO_VARIANTS,
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
} from "@workspace/ui/components/assistant/question-tray"
import {
  type TrayServices,
  TrayServicesProvider,
} from "@workspace/ui/components/assistant/tray-services"
import type { CatalogEntry } from "./entries"

/**
 * The question tray in each state the owner can put it in, for a made-up
 * business, "Mop & Pail Cleaning". It sits above a stand-in composer, a card of its own, so the
 * docking reads; nothing here is a real answer. The app's services are
 * fakes that answer after a moment, and the logo designs are drawn here.
 */

const noop = () => undefined

const [paper = "", tint = "", primary = "", ink = ""] =
  PALETTES[0]?.swatches ?? []

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

const variant = (at: number) => ({
  id: `00000000-0000-4000-8000-00000000000${at}`,
})
const ROUND: LogoRound = {
  round: 1,
  status: "ready",
  variants: [0, 1, 2, 3].map(variant),
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
    drawLogos: () => {
      const round: LogoRound = {
        round: rounds.length + 1,
        status: "drawing",
        variants: [],
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
    keepLogo: () => later({ asset: KEPT }),
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

/** A round asked for early, refused as the api refuses it. */
const refused = {
  drawLogos: () =>
    Promise.reject(
      Object.assign(new Error("Your next designs can start in 5 minutes."), {
        retryAfter: 300,
      })
    ),
}

/** A brief filled in up to each section. */
const COLOURED = { colours: { palette: 0 } }
const TYPED = { ...COLOURED, type: "emblem" } as const
const STYLED = { ...TYPED, style: "hand_drawn" } as const

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
  ["outfit_figtree", "Outfit and Figtree", "Outfit", "Figtree"],
  ["sora_manrope", "Sora and Manrope", "Sora", "Manrope"],
  [
    "instrument_worksans",
    "Instrument Serif and Work Sans",
    "Instrument Serif",
    "Work Sans",
  ],
  ["syne_jakarta", "Syne and Plus Jakarta Sans", "Syne", "Plus Jakarta Sans"],
] as const

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
    },
    {
      id: "palette",
      question: "Which colour palette feels right for Mop & Pail Cleaning?",
      visual: "palette",
      card: card(
        "palette",
        PALETTES.slice(0, 24).map((each) => ({
          id: each.id,
          label: each.label,
          hint: null,
          visual: { kind: "swatches", colors: [...each.swatches] },
        })),
        { initial: PALETTES.slice(0, 4).map((each) => each.id), other: null }
      ),
    },
    {
      id: "lettering",
      question: "Which lettering do you prefer?",
      visual: "font_pair",
      card: card(
        "font",
        PAIRS.map(([id, label, display, body]) => ({
          id,
          label,
          hint: null,
          visual: { kind: "font_pair", display, body },
        })),
        { skippable: true }
      ),
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
      question: "Add photos of your work",
      visual: "photos",
      card: card(
        "template",
        [
          { id: "upload", label: "Upload photos", hint: null, visual: null },
          {
            id: "create",
            label: "Create them for me",
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

/** The tray with the logo page opening on one of its paths. */
const logoOn = (path: "upload" | "create"): AskDesignInput => ({
  questions: INPUT.questions.map((each) =>
    each.visual === "logo"
      ? { ...each, card: { ...each.card, preselected: [path] } }
      : each
  ),
})

const LOGO = 0
const PALETTE = 1
const LETTERING = 2
const PHONE = "max-w-[22.5rem]"
const SECOND: LogoRound = { ...ROUND, round: 2 }
const create = logoOn("create")

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
  { title: "Logo, nothing chosen" },
  { title: "Logo, upload", input: logoOn("upload") },
  {
    title: "Logo, uploaded and kept",
    input: logoOn("upload"),
    start: { index: LOGO, answers: { logo: { logo: KEPT } } },
  },
  { title: "Logo, create: how it should look and colours", input: create },
  {
    title: "Logo, create: own colours",
    input: create,
    start: { logo: { brief: { colours: { custom: [primary] } } } },
  },
  {
    title: "Logo, create: colours picked, logo type next",
    input: create,
    start: { logo: { brief: COLOURED } },
  },
  {
    title: "Logo, create: type picked, style next",
    input: create,
    start: { logo: { brief: TYPED } },
  },
  {
    title: "Logo, create: ready to design",
    input: create,
    start: { logo: { brief: STYLED } },
  },
  {
    title: "Logo, drawing",
    start: { logo: { brief: STYLED } },
    rounds: [{ round: 1, status: "drawing", variants: [variant(0)] }],
  },
  {
    title: "Logo, designs to pick from",
    start: { logo: { brief: STYLED } },
    rounds: [ROUND],
  },
  {
    title: "Logo, a design picked",
    start: {
      index: LOGO,
      answers: { logo: { logo: KEPT } },
      logo: { brief: STYLED },
    },
    rounds: [ROUND],
  },
  {
    title: "Logo, changing the picked design",
    start: {
      index: LOGO,
      answers: { logo: { logo: KEPT } },
      logo: { brief: STYLED, changes: "Make the bucket smaller" },
    },
    rounds: [ROUND],
  },
  {
    title: "Logo, waiting for the next round",
    start: {
      index: LOGO,
      answers: { logo: { logo: KEPT } },
      logo: { brief: STYLED, changes: "Try a rounder badge" },
    },
    rounds: [ROUND, SECOND],
    services: waiting([ROUND, SECOND], 299),
  },
  {
    title: "Logo, redesign refused for now",
    start: { logo: { brief: STYLED, changes: "Warmer colours" } },
    rounds: [ROUND, SECOND],
    services: refused,
  },
  {
    title: "Logo, a second round failed",
    start: { logo: { brief: STYLED } },
    rounds: [ROUND, { round: 2, status: "failed", variants: [] }],
  },
  { title: "Palette, nothing picked", start: { index: PALETTE } },
  {
    title: "Palette, one picked",
    start: {
      index: PALETTE,
      answers: { palette: { choice: PALETTES[1]?.id ?? "" } },
    },
  },
  {
    title: "Palette, a surprise from beyond the four shown",
    start: {
      index: PALETTE,
      answers: { palette: { choice: PALETTES[9]?.id ?? "" } },
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
    start: { index: 3, answers: { arrangement: { choice: "dark_rows" } } },
  },
  { title: "Photos, nothing yet", start: { index: 4 } },
  {
    title: "Last question, own words typed",
    start: { index: 5, answers: { pages: { own: "A page for our prices" } } },
  },
  {
    title: "Pages, several ticked",
    start: {
      index: 5,
      answers: { pages: { choices: ["services", "gallery", "faq"] } },
    },
  },
  { title: "Collapsed", start: { index: LETTERING, collapsed: true } },
  { title: "Phone width, logo", width: PHONE },
  {
    title: "Phone width, logo style",
    input: create,
    start: { logo: { brief: STYLED } },
    width: PHONE,
  },
  {
    title: "Phone width, logo designs",
    start: { index: LOGO, logo: { brief: STYLED } },
    rounds: [ROUND],
    width: PHONE,
  },
  { title: "Phone width, palette", start: { index: PALETTE }, width: PHONE },
  {
    title: "Phone width, lettering",
    start: { index: LETTERING },
    width: PHONE,
  },
  { title: "Phone width, layout", start: { index: 3 }, width: PHONE },
  { title: "Phone width, photos", start: { index: 4 }, width: PHONE },
]

const trayCatalog: CatalogEntry[] = (
  ["QuestionTray", "TrayFrame"] as const
).map((name) => ({
  name,
  render: () => (
    <div className="flex flex-col gap-10">
      {STATES.map(({ title, start, input, rounds, services, width }) => (
        <section
          className={`flex max-w-2xl flex-col gap-3 ${width ?? ""}`}
          key={title}
        >
          <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
          <div className="flex flex-col gap-2">
            <TrayServicesProvider value={fakes(rounds, services)}>
              <QuestionTray
                businessName="Mop & Pail Cleaning"
                input={input ?? INPUT}
                onAnswer={noop}
                onFinish={noop}
                start={start}
                // One call per state, so each keeps its own logo brief.
                toolCallId={`catalog:${name}:${title}`}
              />
            </TrayServicesProvider>
            <div className="rounded-4xl border border-border bg-card px-5 py-4 text-muted-foreground text-sm">
              Tell Sam what to do instead…
            </div>
          </div>
        </section>
      ))}
    </div>
  ),
}))

export { trayCatalog }
