import {
  CaretLeftIcon,
  CaretRightIcon,
  EyedropperIcon,
  PenNibIcon,
  PlusIcon,
  ShuffleIcon,
  SpinnerGapIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react"
import {
  type Asset,
  CALM_PALETTES,
  colourName,
  LOGO_ROUND_SECONDS,
  LOGO_ROUNDS_MAX,
  LOGO_STYLES,
  LOGO_TYPES,
  LOGO_VARIANTS,
  type LogoBrief,
  type LogoChip,
  type LogoDirection,
  type LogoRound,
  type LogoStyle,
  type LogoType,
  PALETTES,
} from "@workspace/contracts"
import {
  ACCENT_RING,
  DropTile,
  Fold,
  type OfferedPalette,
  RadioTile,
  type Stops,
  Suggested,
  Swatches,
  sentence,
  TRAY_FIELD,
  TRAY_TILE,
  type TrayFrameProps,
  useTabDraft,
  Ways,
} from "@workspace/ui/components/assistant/question-tray"
import {
  ReplyPill,
  ReplyPills,
} from "@workspace/ui/components/assistant/reply-pill"
import {
  type TrayPageProps,
  useTrayServices,
} from "@workspace/ui/components/assistant/tray-services"
import { Button } from "@workspace/ui/components/button"
import { Diffusing } from "@workspace/ui/components/diffusing"
import { StateIcon } from "@workspace/ui/components/status-line"
import { FIELD_ERROR } from "@workspace/ui/lib/card"
import { checkPhotos, sizeText, typesText } from "@workspace/ui/lib/upload"
import { cn } from "@workspace/ui/lib/utils"
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

/**
 * The logo question's two pages in the design tray, the first question and
 * one that cannot be skipped. The first asks whether they have a logo: two
 * quick answers, nothing picked, a tap moving on to the second. Yes there is
 * the upload. With no logo held, a first round draws as the tray opens, one
 * design in each of the three directions chosen for the business, so No
 * has designs at once, the first picked; each says what its kind of logo is
 * for. Under them sit ideas for a redesign read from the picked design, and
 * the brief as one line that opens it to edit. An idea, or the owner's own
 * words, turns the tray's primary into Redesign my logo, which draws a round
 * from the picked design. Rounds are saved by the api, so a reload reads
 * them back. Picking a design keeps it as the logo and answers the
 * question; another round comes after the wait the api sets between rounds.
 */

/** The logo question's answer: the logo kept. */
export type LogoAnswer = { logo: Asset }

/** Whether they have a logo: Yes is the upload, No the designs. */
export type LogoPath = "upload" | "create"

/** The designs page's title and the line under it, as the tray shows them. */
export type LogoHeading = { title: string; hint: string | null }

const TYPE_LABELS: Record<LogoType, string> = {
  lockup: "Icon + name",
  icon: "Icon only",
  wordmark: "Name only",
  monogram: "Monogram",
  emblem: "Emblem / badge",
  abstract: "Abstract mark",
}

const STYLE_LABELS: Record<LogoStyle, string> = {
  minimal: "Minimal",
  geometric: "Geometric",
  gradient: "Gradient",
  mascot: "Mascot",
  hand_drawn: "Hand-drawn",
  luxury: "Luxury",
  retro: "Retro",
  three_d: "3D",
}

/** The pictures a type or style tile cycles through on hover, `<name>-<n>`, frame 0 at rest. */
const FRAMES = import.meta.glob<string>(
  ["../../assets/logo-types/*.webp", "../../assets/logo-styles/*.webp"],
  { eager: true, import: "default" }
)
const framesOf = (dir: "logo-types" | "logo-styles", name: string) =>
  [0, 1, 2, 3, 4].flatMap(
    (n) => FRAMES[`../../assets/${dir}/${name}-${n}.webp`] ?? []
  )

/**
 * A type or style tile: a border that firms on hover and turns the accent,
 * with a soft ring, when picked. The pictures are transparent and drawn to
 * read on light and dark alike, so they sit on the tile itself.
 */
const PICK_TILE =
  "group flex cursor-pointer rounded-xl border border-border bg-card transition-all duration-150 hover:border-foreground/25 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-card has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-primary/20"
const PICK_LABEL =
  "font-medium text-muted-foreground transition-colors group-has-[:checked]:text-foreground"

const NO_SERVICES = "Logos cannot be uploaded or made here."

/** A colour tile, edge to edge like the palette page's, with a 2px line when picked. */
const COLOUR_TILE =
  "gap-0 overflow-hidden p-0 has-[:checked]:ring-2 has-[:checked]:ring-foreground"
/** Random and Custom inside a colour tile: an icon and a name, a palette's height. */
const NAMED_TILE =
  "flex h-10 items-center justify-center gap-1.5 font-medium text-muted-foreground text-xs"

/** A colour's lightness, enough to tell the darker of two apart. */
const lightness = (colour: string) => {
  const n = Number.parseInt(colour.slice(1), 16)
  return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
}

/**
 * The colours a logo is drawn in from a palette's last two swatches: the
 * darker for the name, the other for the shapes. Most palettes show primary
 * then ink, but one may show a light accent last.
 */
const logoColors = ([, , third, fourth]: Stops) =>
  lightness(third) <= lightness(fourth) ? [fourth, third] : [third, fourth]

/** A typed colour as the api takes it, or null when it is not one. */
const hex = (text: string) => {
  const colour = `#${text.trim().replace(/^#/, "").toLowerCase()}`
  return /^#[0-9a-f]{6}$/.test(colour) ? colour : null
}

const sameBrief = (a: LogoBrief, b: LogoBrief) =>
  a.description === b.description &&
  a.type === b.type &&
  a.style === b.style &&
  a.colors.join() === b.colors.join()

/** How long a wait has left, as Redesign says it. */
export const waitText = (seconds: number) =>
  seconds >= 86_400
    ? "tomorrow"
    : seconds > 3600
      ? `in ${Math.ceil(seconds / 3600)} hours`
      : seconds === 3600
        ? "in 1 hour"
        : `in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

/** The seconds a refused round must wait, when the refusal said. */
const retryAfter = (failure: unknown) =>
  failure instanceof Error &&
  "retryAfter" in failure &&
  typeof failure.retryAfter === "number"
    ? failure.retryAfter
    : null

/** The colours picked: one of the offered palettes, a random one, or the owner's own. */
type Colours =
  | { palette: number }
  | { random: OfferedPalette }
  | { custom: string[] }

/** The most colours the owner may set, a palette's worth. */
const CUSTOM_MAX = 4

/** The brief as the owner fills it in, kept in the tab. */
type Brief = {
  description: string
  colours: Colours | null
  type: LogoType | null
  style: LogoBrief["style"] | null
  /** What should change in the picked design, for the next redesign. */
  changes?: string
}

/** Where the catalog opens the page. */
export type LogoStart = {
  path?: LogoPath
  brief?: Partial<Brief>
  /** The brief opened to edit. */
  editing?: boolean
}

/** The line under each design of a round of directions: code's words for its kind, never a model's. */
const CAPTIONS: Record<LogoType, string> = {
  lockup: "Your symbol and name, clear at any size",
  icon: "A symbol that stands on its own",
  wordmark: "Your name as the logo, simple and confident",
  monogram: "Your initials as a mark",
  emblem: "A badge for vans, signs and uniforms",
  abstract: "A shape that stands for the business",
}

/** Each type as the brief's line says it. */
const TYPE_WORDS: Record<LogoType, string> = {
  lockup: "symbol and name",
  icon: "symbol only",
  wordmark: "name only",
  monogram: "initials",
  emblem: "badge",
  abstract: "abstract mark",
}

const styleWords = (style: LogoBrief["style"]) =>
  style === "surprise"
    ? "mixed styles"
    : style === "three_d"
      ? "3D"
      : STYLE_LABELS[style].toLowerCase()

/** Up to two colours by their plain names, such as "forest green and cream". */
const colourWords = (colors: readonly string[]) =>
  [...new Set(colors.map(colourName))].slice(0, 2).join(" and ")

/**
 * The redesign ideas offered while the picked design's own have not come,
 * as the owner set them out. Other colours opens the colours.
 */
const FALLBACK: (LogoChip | "colours")[] = [
  { kind: "detail", label: "Bolder", change: "bolder, heavier shapes" },
  {
    kind: "style",
    label: "Simpler",
    change: "a simpler, more minimal look",
    set: { style: "minimal" },
  },
  { kind: "detail", label: "Different icon", change: "a different symbol" },
  "colours",
]

/** How long a picked design's own ideas may take once it shows, one poll, before the fixed ones stand in. */
const IDEAS_WAIT_MS = 2500

/** The change's words with `phrase` added, or taken out when `has`. */
const phrased = (words: string, phrase: string, has: boolean) =>
  has
    ? words
        .replace(phrase, "")
        .replace(/\s*,\s*,\s*/g, ", ")
        .replace(/^[\s,]+|[\s,]+$/g, "")
    : [words.trim().replace(/[\s,.]+$/, ""), phrase].filter(Boolean).join(", ")

/** Seconds a round has left, as the line under the title says it: whole fives, never under five. */
const secondsLeft = (startedAt: string) =>
  Math.max(
    5,
    Math.ceil(
      (LOGO_ROUND_SECONDS - (Date.now() - Date.parse(startedAt)) / 1000) / 5
    ) * 5
  )

/** A few colours as overlapping dots, for the brief's line. */
function Dots({ colors }: { colors: readonly string[] }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 align-middle">
      {colors.map((color, at) => (
        <span
          // The outline keeps a colour near the card's own visible in either theme.
          className="-ml-1 size-3.5 rounded-full border border-foreground/20 ring-2 ring-card first:ml-0"
          // biome-ignore lint/suspicious/noArrayIndexKey: two colours may match
          key={at}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  )
}

/** What went wrong, and a button to try again. */
function Retry({
  message,
  busy = false,
  onRetry,
}: {
  message: string
  busy?: boolean
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-3">
      <p className="text-sm" role="status">
        {message}
      </p>
      <Button
        disabled={busy}
        onClick={onRetry}
        size="sm"
        type="button"
        variant="outline"
      >
        Try again
      </Button>
    </div>
  )
}

function TrayLogo({
  question,
  toolCallId,
  answer,
  onAnswer,
  stops,
  businessName,
  palettes,
  setSubmit,
  setHeading,
  start,
  path,
  onPath,
  step,
  picking = false,
}: TrayPageProps<LogoAnswer> & {
  /** The palettes the tray offers, the site's own first. */
  palettes: readonly OfferedPalette[]
  /** Sets the tray's primary button while this page has its own; undefined hands it back. */
  setSubmit: (submit: TrayFrameProps["submit"]) => void
  /** Sets the tray's title and line while the designs say more than "Your logo"; undefined hands them back. */
  setHeading: (heading: LogoHeading | undefined) => void
  start?: LogoStart | undefined
  /** The way picked on the first page, held by the tray. */
  path: LogoPath | null
  onPath: (way: LogoPath) => void
  /** The first page, whether they have a logo, or the second. */
  step: "choice" | "designs"
  /** Pick for me was pressed and the tray waits for a logo. */
  picking?: boolean | undefined
}) {
  const id = useId()
  const services = useTrayServices()
  // The directions chosen for the business, the first opening the brief.
  const suggestion = question.start
  const [lead] = suggestion?.directions ?? []
  const { draft: brief, keep: setBrief } = useTabDraft<Brief>(
    `logo-brief:${toolCallId}`,
    // Opened filled, so the first round needs no answer; every part still changes.
    {
      description: suggestion?.description ?? "",
      colours: { palette: 0 },
      type: lead?.type ?? "lockup",
      style: lead?.style ?? "minimal",
      changes: "",
      ...start?.brief,
    }
  )
  const [editing, setEditing] = useState(start?.editing ?? false)
  const [rounds, setRounds] = useState<LogoRound[]>([])
  // Whether the rounds drawn before have been read, so none is drawn twice.
  const [loaded, setLoaded] = useState(false)
  const [nextAt, setNextAt] = useState<number | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<{ file: File; url: string } | null>(null)
  const [, tick] = useState(0)
  const replace = useRef<HTMLInputElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  // Edit asks for the field to take focus once its section has opened.
  const focusField = useRef<boolean>(false)
  // The colours an idea replaced, so a second tap puts them back.
  const coloursBefore = useRef<Colours | null>(null)
  // When each design was first shown, so its own ideas get a moment.
  const shownSince = useRef(new Map<string, number>())

  // A read that failed: what the rounds hold is not known, so nothing of it
  // is shown or polled until Try again.
  const [unread, setUnread] = useState(false)
  const latest = rounds.at(-1)
  const drawing = !unread && latest?.status === "drawing"

  // The rounds drawn before a reload, and again every few seconds while one
  // draws, since a round draws after its request answers.
  useEffect(() => {
    if (!services || unread) return
    let live = true
    const read = () =>
      services
        .logoRounds(toolCallId)
        .then((drawn) => {
          if (!live) return
          setRounds(drawn.rounds)
          setNextAt(drawn.next_at ? Date.parse(drawn.next_at) : null)
          setLoaded(true)
        })
        .catch(() => live && setUnread(true))
    const timer = drawing ? setInterval(read, 2500) : undefined
    if (!drawing) void read()
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [drawing, services, toolCallId, unread])

  // The wait before the next round, counted down a second at a time.
  const left = nextAt === null ? 0 : Math.ceil((nextAt - Date.now()) / 1000)
  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => tick((now) => now + 1), 1000)
    return () => clearTimeout(timer)
  }, [left])

  // The chosen file's preview, freed when another is chosen or the page goes.
  useEffect(
    () => () => {
      if (file) URL.revokeObjectURL(file.url)
    },
    [file]
  )

  const accept = question.upload?.accept ?? []
  const maxBytes = question.upload?.max_bytes ?? 0
  const paper = stops[0]
  // A kept design or upload says which way was taken before a reload, once
  // the rounds are read; nothing is picked for the owner otherwise.
  const kept = answer?.logo.id ?? null
  // The kept design, and the round it came from.
  const picked = rounds
    .flatMap((each) =>
      each.variants
        .filter((variant) => variant.id === kept)
        .map((variant) => ({ round: each, variant }))
    )
    .at(0)
  const keptDrawn = picked !== undefined
  const held = loaded && !unread ? (keptDrawn ? "create" : "upload") : null
  const shownPath = path ?? (answer ? held : null)
  const round = at === null ? latest : rounds[at]
  const shownAt = at ?? rounds.length - 1
  const [uploadOption, createOption] = question.card.options
  const create = shownPath === "create"

  const colours = brief.colours
  const colors = !colours
    ? []
    : "palette" in colours
      ? logoColors((palettes[colours.palette] ?? palettes[0])?.stops ?? stops)
      : "random" in colours
        ? logoColors(colours.random.stops)
        : colours.custom.flatMap((each) => hex(each) ?? [])
  // The site's own palette is the default, not a choice the owner made.
  const coloursChosen =
    colours !== null && !("palette" in colours && colours.palette === 0)
  const briefReady =
    colors.length > 0 && brief.type !== null && brief.style !== null
  // The brief as the api takes it, once every part is set.
  const wanted: LogoBrief | null =
    brief.type && brief.style && colors.length > 0
      ? {
          description: brief.description.trim(),
          colors,
          type: brief.type,
          style: brief.style,
        }
      : null
  const words = (brief.changes ?? "").trim()
  // What the kept design was drawn from: its round's brief, in its own type and style.
  const own: LogoBrief | undefined = picked
    ? { ...picked.round.brief, ...picked.variant.direction }
    : latest?.brief
  const changed =
    wanted !== null && own !== undefined && !sameBrief(wanted, own)
  // A round of directions draws a different kind of logo in each design.
  const directed =
    round !== undefined &&
    new Set(round.variants.map((v) => v.direction.type)).size > 1

  const send = async (chosen: File) => {
    if (!services) return setError(NO_SERVICES)
    setError(null)
    setBusy("upload")
    try {
      const { assets } = await services.upload([chosen])
      const stored = assets[0]
      if (!stored) throw new Error("The logo did not upload. Try again.")
      const { asset } = await services.keepLogo(stored.id)
      onAnswer({ logo: asset })
      setFile(null)
    } catch (failure) {
      setError(sentence(failure, "The logo did not upload. Try again."))
    } finally {
      setBusy(null)
    }
  }

  const choose = ([chosen]: File[]) => {
    if (!chosen) return
    const { refused } = checkPhotos([], [chosen], {
      accept,
      max_bytes: maxBytes,
      max_files: 1,
    })
    if (refused[0]) return setError(refused[0])
    setFile({ file: chosen, url: URL.createObjectURL(chosen) })
    void send(chosen)
  }

  /**
   * Starts a round from the brief as it stands; true once it has started.
   * The first round draws the suggested directions, unless the owner moved
   * the brief off them; one with words for a kept design changes that one.
   */
  const draw = async () => {
    if (!services) {
      setError(NO_SERVICES)
      return false
    }
    if (!wanted) return false
    setError(null)
    setBusy("draw")
    const first = !rounds.some((each) => each.status !== "failed")
    const base = words && keptDrawn && kept ? kept : undefined
    const directions =
      first &&
      !base &&
      suggestion &&
      wanted.type === lead?.type &&
      wanted.style === lead?.style
        ? suggestion.directions
        : undefined
    try {
      const started = await services.drawLogos({
        tool_call_id: toolCallId,
        brief: wanted,
        ...(directions ? { directions } : {}),
        ...(words ? { changes: words } : {}),
        ...(base ? { base } : {}),
      })
      setRounds((now) => [
        ...now.filter((each) => each.round !== started.round),
        started,
      ])
      setAt(null)
      setEditing(false)
      // The api may read a type or style in the words; the brief shows it.
      setBrief({
        ...brief,
        type: started.brief.type,
        style: started.brief.style,
        changes: "",
      })
      return true
    } catch (failure) {
      const wait = retryAfter(failure)
      if (wait) setNextAt(Date.now() + wait * 1000)
      setError(sentence(failure, "The designs did not start. Try again."))
      return false
    } finally {
      setBusy(null)
    }
  }

  /** Keeps a design as the logo; the brief follows its type and style. */
  const keep = async (variant: { id: string; direction: LogoDirection }) => {
    if (!services) return setError(NO_SERVICES)
    setError(null)
    setBusy(variant.id)
    try {
      const { asset } = await services.keepLogo(variant.id)
      onAnswer({ logo: asset })
      setBrief({ ...brief, ...variant.direction })
    } catch (failure) {
      setError(sentence(failure, "That design was not saved. Try again."))
    } finally {
      setBusy(null)
    }
  }

  // With no logo held one round starts as the page opens, from the
  // suggested directions, before the owner says whether they have a logo,
  // so No has designs at once. A page the catalog opens in a given state
  // stays in it.
  const auto = useRef(!question.held?.length && !answer && !start)
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the rounds drawn before are read
  useEffect(() => {
    if (!loaded || !auto.current) return
    auto.current = false
    if (rounds.length === 0) void draw()
  }, [loaded])

  // On No the newest round's first design is the pick, as it lands, until
  // the owner picks another. A failed keep waits for the owner.
  const [firstDesign] = latest?.variants ?? []
  // biome-ignore lint/correctness/useExhaustiveDependencies: keep is a fresh closure each render
  useEffect(() => {
    if (create && firstDesign && !keptDrawn && busy === null && !error) {
      void keep(firstDesign)
    }
  }, [create, firstDesign, keptDrawn, busy, error])

  // The picked design's own ideas, or the fixed ones once they are late.
  const selected = picked?.variant
  useEffect(() => {
    if (!selected || selected.chips) return
    const since = shownSince.current.get(selected.id) ?? Date.now()
    shownSince.current.set(selected.id, since)
    const wait = IDEAS_WAIT_MS - (Date.now() - since)
    if (wait <= 0) return
    const timer = setTimeout(() => tick((now) => now + 1), wait)
    return () => clearTimeout(timer)
  }, [selected])
  const since = selected && shownSince.current.get(selected.id)
  const ideas =
    selected?.chips ??
    (since !== undefined && Date.now() - since >= IDEAS_WAIT_MS
      ? FALLBACK.filter(
          (each) =>
            each === "colours" ||
            !each.set?.style ||
            each.set.style !== selected?.direction.style
        )
      : null)
  const redesigning = keptDrawn && rounds.length < LOGO_ROUNDS_MAX

  /** An idea's tap: its words join the change and its options are set; again, both come off. */
  const toggle = (idea: LogoChip) => {
    if (!selected) return
    const on = words.includes(idea.change)
    const next: Brief = {
      ...brief,
      changes: phrased(brief.changes ?? "", idea.change, on),
    }
    const { type, style, colors: tint } = idea.set ?? {}
    if (type) next.type = on ? selected.direction.type : type
    if (style) next.style = on ? selected.direction.style : style
    if (tint) {
      if (!on) coloursBefore.current = brief.colours
      next.colours = on ? coloursBefore.current : { custom: tint }
    }
    setBrief(next)
    setEditing(true)
  }

  // Random and Custom stay open to roll again or edit.
  const setColours = (next: Colours) => setBrief({ ...brief, colours: next })
  const random = colours && "random" in colours ? colours.random : null
  // A calm palette the tiles do not already show, and not the one drawn last.
  const roll = () => {
    const taken = new Set([...palettes, random].map((each) => each?.label))
    const pool = PALETTES.filter(
      (each) => CALM_PALETTES.includes(each.id) && !taken.has(each.label)
    )
    const lucky = pool[Math.floor(Math.random() * pool.length)]
    if (lucky) {
      setColours({
        random: {
          label: lucky.label,
          stops: lucky.swatches as unknown as Stops,
        },
      })
    }
  }
  const custom = colours && "custom" in colours ? colours.custom : null

  // The brief comes into view once its fold has eased open, and Edit's
  // field takes the keyboard.
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!editing) return
    const timer = setTimeout(() => {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)")
      page.current?.querySelector(`[data-part="brief"]`)?.scrollIntoView({
        block: "nearest",
        behavior: still.matches ? "auto" : "smooth",
      })
      if (focusField.current) field.current?.focus()
      focusField.current = false
    }, FOLD_MS)
    return () => clearTimeout(timer)
  }, [editing])

  // With no round yet, a brief changed since the picked design, or words
  // for a change, the tray's primary is Redesign my logo while rounds are
  // left; a layout effect, so the tray never paints Next in its place. Not
  // before the rounds are read, so none is drawn twice.
  const designFirst =
    create &&
    loaded &&
    !unread &&
    rounds.length < LOGO_ROUNDS_MAX &&
    (!latest || changed || words !== "")
  const design = useRef(() => undefined as undefined)
  design.current = () => {
    // The pick is set aside once the round starts; its first design follows.
    void draw().then((started) => {
      if (started && answer) onAnswer(undefined)
    })
  }
  const designDisabled = !briefReady || busy !== null || left > 0 || drawing
  const designBusy = busy === "draw"
  const designLabel =
    left > 0 ? `Redesign ${waitText(left)}` : "Redesign my logo"
  useLayoutEffect(() => {
    setSubmit(
      designFirst
        ? {
            label: (
              <>
                {designBusy ? (
                  <SpinnerGapIcon aria-hidden className="animate-spin" />
                ) : null}
                {designLabel}
              </>
            ),
            onSubmit: () => design.current(),
            disabled: designDisabled,
          }
        : undefined
    )
  }, [designFirst, designBusy, designDisabled, designLabel, setSubmit])
  useLayoutEffect(() => () => setSubmit(undefined), [setSubmit])

  // While a round draws the title says so and how long it takes, counted
  // from when it started; once all three show, it asks for a pick.
  const eta = useMemo(
    () => (round?.started_at ? secondsLeft(round.started_at) : null),
    [round?.started_at]
  )
  const landed = round?.variants.length === LOGO_VARIANTS
  const heading: LogoHeading | undefined =
    step !== "designs" ||
    !create ||
    unread ||
    !round ||
    round.status === "failed"
      ? undefined
      : round.status === "drawing" && !landed
        ? {
            title: "Designing your logo",
            hint: `Three designs for ${businessName}, about ${eta} seconds`,
          }
        : {
            title: "Pick your logo",
            hint:
              rounds.length < LOGO_ROUNDS_MAX
                ? "Or ask for a redesign below."
                : null,
          }
  // biome-ignore lint/correctness/useExhaustiveDependencies: the words are the heading
  useLayoutEffect(
    () => setHeading(heading),
    [heading?.title, heading?.hint, setHeading]
  )
  useLayoutEffect(() => () => setHeading(undefined), [setHeading])

  if (step === "choice") {
    return (
      <Ways
        label={question.question ?? "Your logo"}
        onPick={(way) => {
          setError(null)
          // Yes sets a drawn design aside: the logo is the one they upload.
          if (way === "upload" && keptDrawn) onAnswer(undefined)
          onPath(way)
        }}
        onRepick={onPath}
        picked={shownPath}
        quick
        ways={[
          {
            way: "upload",
            label: uploadOption?.label ?? "Yes, I have my logo",
            hint: "Upload the file you have",
            icon: <UploadSimpleIcon aria-hidden />,
          },
          {
            way: "create",
            label: createOption?.label ?? "No, create one for me",
            hint: "Pick from three designs",
            icon: <PenNibIcon aria-hidden />,
          },
        ]}
      />
    )
  }

  // The parts of the brief that differ from the picked design read darker.
  const part = (text: string, moved: boolean) => (
    <span className={cn(moved && "font-medium text-foreground")}>{text}</span>
  )
  const suggestedType =
    brief.type !== null &&
    (suggestion?.directions ?? []).some((d) => d.type === brief.type)
  const suggestedStyle =
    brief.style !== null &&
    (suggestion?.directions ?? []).some((d) => d.style === brief.style)

  return (
    <div className="-my-1.5 flex shrink-0 flex-col" ref={page}>
      {/* The designs, once a round has started: first, so the pick needs no scroll. */}
      <Fold open={step === "designs" && unread}>
        {unread ? (
          <Retry
            message="Your designs did not load."
            onRetry={() => setUnread(false)}
          />
        ) : null}
      </Fold>

      <Fold open={create && !unread && round !== undefined}>
        {round && services && !unread ? (
          <div className="flex flex-col gap-3">
            {rounds.length > 1 ? (
              <div className="flex items-center gap-1">
                <Button
                  aria-label="Earlier designs"
                  className={ACCENT_RING}
                  disabled={shownAt === 0}
                  onClick={() => setAt(shownAt - 1)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <CaretLeftIcon aria-hidden />
                </Button>
                <span className="text-muted-foreground text-xs tabular-nums">
                  Round {shownAt + 1} of {rounds.length}
                </span>
                <Button
                  aria-label="Later designs"
                  className={ACCENT_RING}
                  disabled={shownAt === rounds.length - 1}
                  onClick={() => setAt(shownAt + 1)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <CaretRightIcon aria-hidden />
                </Button>
              </div>
            ) : null}

            {round.status === "failed" ? (
              <Retry
                busy={busy === "draw"}
                message="These designs did not come through."
                onRetry={() => void draw()}
              />
            ) : (
              <div
                aria-busy={round.status === "drawing"}
                aria-label="Logo designs"
                className="grid max-w-md grid-cols-3 gap-2"
                role="radiogroup"
              >
                {Array.from({ length: LOGO_VARIANTS }, (_, place) => {
                  const variant = round.variants[place]
                  const caption =
                    directed && variant
                      ? CAPTIONS[variant.direction.type]
                      : null
                  return (
                    <RadioTile
                      checked={variant !== undefined && kept === variant.id}
                      className={cn(TRAY_TILE, "p-1.5")}
                      disabled={!variant || busy !== null}
                      // biome-ignore lint/suspicious/noArrayIndexKey: a slot stays put while its design lands
                      key={place}
                      name={`${id}-design`}
                      onPick={() => variant && void keep(variant)}
                    >
                      <span className="relative">
                        {variant ? (
                          <img
                            alt={`Design ${place + 1}`}
                            // Lands from a blur, as tw-animate-css draws it.
                            className="motion-safe:fade-in aspect-square w-full rounded-lg object-contain p-2 duration-slow ease-standard motion-safe:animate-in motion-safe:blur-in-md"
                            key={variant.id}
                            src={services.imageUrl(variant.id)}
                            style={{ backgroundColor: paper }}
                          />
                        ) : (
                          // The image's alt names a landed design; a slot still
                          // waiting needs a name of its own for its radio.
                          <Diffusing
                            className="aspect-square rounded-lg"
                            colors={colors.length > 0 ? colors : [stops[2]]}
                            delay={place * 1500}
                            paper={paper}
                          >
                            <span className="sr-only">{`Design ${place + 1}`}</span>
                          </Diffusing>
                        )}
                        {busy === variant?.id ? (
                          <span
                            aria-label="Saving"
                            className="absolute top-1.5 right-1.5 flex"
                            role="img"
                          >
                            <StateIcon state="working" />
                          </span>
                        ) : null}
                      </span>
                      {caption ? (
                        <span className="px-1 pb-0.5 text-muted-foreground text-xs leading-snug">
                          {caption}
                        </span>
                      ) : null}
                    </RadioTile>
                  )
                })}
              </div>
            )}

            {round.status === "drawing" && !landed ? (
              <DrawingLine
                colours={coloursChosen ? colourWords(colors) : null}
                round={round}
              />
            ) : (
              // Said once all three show, as the title turns to the pick.
              <p className="sr-only" role="status">
                {round.status === "failed" ? "" : "Your designs are ready"}
              </p>
            )}

            {round.status === "ready" && rounds.length >= LOGO_ROUNDS_MAX ? (
              <p className="text-muted-foreground text-xs">
                That is all the rounds for this logo. Pick one, or upload your
                own.
              </p>
            ) : null}
          </div>
        ) : null}
      </Fold>

      {/* Ideas for a redesign of the picked design, then the brief as one line. */}
      <Fold open={create && !unread && redesigning && ideas !== null}>
        <ReplyPills label="Ideas for a redesign">
          {(ideas ?? []).map((idea) =>
            idea === "colours" ? (
              <ReplyPill key="colours" onClick={() => setEditing(true)}>
                Other colours
              </ReplyPill>
            ) : (
              <ReplyPill
                aria-pressed={words.includes(idea.change)}
                key={idea.label}
                onClick={() => toggle(idea)}
              >
                {idea.label}
              </ReplyPill>
            )
          )}
        </ReplyPills>
      </Fold>
      <Fold open={create && !unread && briefReady && !editing}>
        <p className="text-muted-foreground text-sm">
          Your brief:{" "}
          {brief.type
            ? part(TYPE_WORDS[brief.type], brief.type !== own?.type)
            : null}
          {", "}
          {brief.style
            ? part(styleWords(brief.style), brief.style !== own?.style)
            : null}
          {", "}
          <Dots colors={colors} />{" "}
          {part(
            colourWords(colors),
            own !== undefined && colors.join() !== own.colors.join()
          )}
          {" · "}
          <button
            aria-controls={`${id}-brief`}
            aria-expanded={editing}
            className="rounded-sm text-foreground underline underline-offset-2 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-primary"
            onClick={() => {
              focusField.current = true
              setEditing(true)
            }}
            type="button"
          >
            Edit
          </button>
        </p>
      </Fold>

      {/* Yes: the upload. */}
      <Fold open={shownPath === "upload"}>
        {file || (answer && services) ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-2">
            <img
              alt={file ? "" : "Your logo"}
              className="h-24 w-32 shrink-0 rounded-lg object-contain p-2"
              src={file ? file.url : services?.imageUrl(answer?.logo.id ?? "")}
              style={{ backgroundColor: paper }}
            />
            <span
              className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm"
              role="status"
            >
              {busy === "upload" ? (
                <span className="flex items-center gap-2">
                  <StateIcon state="working" />
                  Saving your logo
                </span>
              ) : file ? (
                <span className="truncate">{file.file.name}</span>
              ) : (
                <>
                  <span className="font-medium">Your logo</span>
                  <span className="text-muted-foreground text-xs">
                    Kept for your site
                  </span>
                </>
              )}
            </span>
            {busy !== "upload" ? (
              file ? (
                <Button
                  className={ACCENT_RING}
                  onClick={() => void send(file.file)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Try again
                </Button>
              ) : (
                <Button
                  className={ACCENT_RING}
                  onClick={() => replace.current?.click()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Replace
                </Button>
              )
            ) : null}
            <input
              accept={accept.join(",")}
              aria-hidden
              className="sr-only"
              onChange={(event) => {
                choose(Array.from(event.currentTarget.files ?? []))
                event.currentTarget.value = ""
              }}
              ref={replace}
              tabIndex={-1}
              type="file"
            />
          </div>
        ) : (
          <DropTile
            accept={accept}
            className="min-h-40 flex-col justify-center text-center [&>span]:items-center"
            help={`${typesText(accept)}, up to ${sizeText(maxBytes)}. A clear background works best.`}
            icon={<UploadSimpleIcon />}
            onFiles={choose}
            title="Drop your logo here or choose it"
          />
        )}
      </Fold>

      {/* No: the brief to edit, the change first once there is a design to change. */}
      <Fold open={create && !unread && (editing || !briefReady)}>
        <div
          className="flex flex-col gap-4"
          data-part="brief"
          id={`${id}-brief`}
        >
          {redesigning ? (
            <div className="flex flex-col gap-2">
              <label className="font-medium text-sm" htmlFor={`${id}-changes`}>
                What should change?
              </label>
              <textarea
                className={cn(
                  // Four rows to start, growing with the words to about eight.
                  "field-sizing-content max-h-48 min-h-28 w-full resize-none border px-3 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm",
                  TRAY_FIELD
                )}
                id={`${id}-changes`}
                maxLength={300}
                onChange={(event) =>
                  setBrief({ ...brief, changes: event.currentTarget.value })
                }
                placeholder="For example: bolder lettering, a leaf instead of a tree, darker green"
                ref={field}
                rows={4}
                value={brief.changes ?? ""}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="font-medium text-sm" htmlFor={`${id}-look`}>
                How should it look?{" "}
                <span className="font-normal text-muted-foreground text-xs">
                  Optional
                </span>
              </label>
              <textarea
                className={cn(
                  // Grows with the words, from two rows to about six.
                  "field-sizing-content max-h-40 min-h-16 w-full resize-none border px-3 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm",
                  TRAY_FIELD
                )}
                id={`${id}-look`}
                maxLength={300}
                onChange={(event) =>
                  setBrief({ ...brief, description: event.currentTarget.value })
                }
                placeholder="For example: a simple house shape, plain and modern"
                ref={field}
                rows={2}
                value={brief.description}
              />
            </div>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-medium text-sm">Colours</legend>
            <div className="grid @sm:grid-cols-4 grid-cols-2 gap-2">
              {/* A palette is its colours alone, as on the palette page; the name is for screen readers. */}
              {palettes.map((each, index) => (
                <RadioTile
                  checked={
                    colours !== null &&
                    "palette" in colours &&
                    colours.palette === index
                  }
                  className={cn(TRAY_TILE, COLOUR_TILE)}
                  key={each.label}
                  name={`${id}-colours`}
                  onPick={() => setColours({ palette: index })}
                >
                  <Swatches colors={each.stops} />
                  <span className="sr-only">{each.label}</span>
                </RadioTile>
              ))}
              {/* The shuffle sits beside the radio, not in its label, so it stays its own button. */}
              <div className="relative grid">
                <RadioTile
                  checked={random !== null}
                  className={cn(TRAY_TILE, COLOUR_TILE)}
                  name={`${id}-colours`}
                  onPick={roll}
                >
                  {random ? (
                    <>
                      <Swatches colors={random.stops} />
                      <span className="sr-only">Random, {random.label}</span>
                    </>
                  ) : (
                    <span className={NAMED_TILE}>
                      <ShuffleIcon aria-hidden className="size-4" />
                      Random
                    </span>
                  )}
                </RadioTile>
                {random ? (
                  <button
                    aria-label="Another random palette"
                    className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-card/90 text-foreground shadow-sm outline-none transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
                    onClick={roll}
                    type="button"
                  >
                    <ShuffleIcon aria-hidden className="size-4" />
                  </button>
                ) : null}
              </div>
              <RadioTile
                checked={custom !== null}
                className={cn(TRAY_TILE, COLOUR_TILE)}
                name={`${id}-colours`}
                onPick={() => setColours({ custom: [stops[2]] })}
              >
                <span className={NAMED_TILE}>
                  <EyedropperIcon aria-hidden className="size-4" />
                  Custom
                </span>
              </RadioTile>
            </div>
            {custom ? (
              <CustomColours
                colours={custom}
                onChange={(next) => setColours({ custom: next })}
                starts={stops}
              />
            ) : null}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 flex flex-wrap items-center gap-2 font-medium text-sm">
              Logo type
              {suggestedType ? <Suggested name={businessName} /> : null}
            </legend>
            {/* As many to a row as fit whole: three on a wide tray, one on the narrowest, so no name wraps. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
              {LOGO_TYPES.map((type) => (
                <PickTile
                  checked={type === brief.type}
                  className="h-11 flex-row items-center gap-2.5 px-2"
                  frames={framesOf("logo-types", type)}
                  key={type}
                  label={TYPE_LABELS[type]}
                  labelSize="text-sm"
                  name={`${id}-type`}
                  onPick={() => setBrief({ ...brief, type })}
                  picture="h-7 w-10"
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 flex flex-wrap items-center gap-2 font-medium text-sm">
              Style
              {suggestedStyle ? <Suggested name={businessName} /> : null}
            </legend>
            <div className="grid @md:grid-cols-4 grid-cols-3 gap-2">
              {LOGO_STYLES.map((style) => (
                <PickTile
                  checked={style === brief.style}
                  className="flex-col items-center gap-1.5 px-1.5 py-2"
                  frames={framesOf("logo-styles", style)}
                  key={style}
                  label={STYLE_LABELS[style]}
                  name={`${id}-style`}
                  onPick={() => setBrief({ ...brief, style })}
                  picture="size-9"
                />
              ))}
              <RadioTile
                checked={brief.style === "surprise"}
                className={cn(
                  PICK_TILE,
                  "col-span-full h-10 items-center justify-center gap-2 border-dashed has-[:checked]:border-solid"
                )}
                name={`${id}-style`}
                onPick={() => setBrief({ ...brief, style: "surprise" })}
              >
                <ShuffleIcon
                  aria-hidden
                  className="size-4 text-muted-foreground transition-colors group-has-[:checked]:text-primary"
                />
                <span className={cn(PICK_LABEL, "text-xs")}>Surprise me</span>
              </RadioTile>
            </div>
          </fieldset>

          {briefReady ? (
            <Button
              aria-controls={`${id}-brief`}
              aria-expanded
              className={cn(ACCENT_RING, "self-start")}
              onClick={() => setEditing(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Close the brief
            </Button>
          ) : null}
        </div>
      </Fold>

      {error ? (
        <p className={cn(FIELD_ERROR, "px-0 pt-1")} role="alert">
          {error}
        </p>
      ) : null}
      {/* The api will not settle the tray without a logo, so Pick for me waits for one. */}
      {picking && !answer && shownPath === "upload" ? (
        <p className="pt-1 text-muted-foreground text-sm" role="status">
          I need your logo file to finish. Add it here and I'll do the rest.
        </p>
      ) : picking &&
        !answer &&
        (latest?.status === "failed" || unread || error) ? (
        <p className="pt-1 text-muted-foreground text-sm" role="status">
          I need a logo to finish. Try the designs again, or upload yours.
        </p>
      ) : null}
    </div>
  )
}

/** How long a section takes to fold, as `Fold` eases it. */
const FOLD_MS = 220

/** The width a custom colour opens to: its picker, its code and a remove. */
const OPEN_COLOUR = "flex-[0_0_11rem]"

/**
 * The owner's own colours as one strip, like a palette, the brand colour
 * first. A colour widens to its picker and code under the pointer or focus;
 * one just added opens with its code focused, and joins the strip again when
 * focus leaves it.
 */
function CustomColours({
  colours,
  starts,
  onChange,
}: {
  colours: string[]
  /** The site palette, whose next stop a new colour starts from. */
  starts: Stops
  onChange: (colours: string[]) => void
}) {
  const [editing, setEditing] = useState<number | null>(null)
  // The colour just added, whose code takes focus as it mounts.
  const added = useRef<number | null>(null)
  const alone = colours.length === 1
  const set = (slot: number, value: string) =>
    onChange(colours.map((each, place) => (place === slot ? value : each)))
  const add = () => {
    added.current = colours.length
    setEditing(colours.length)
    onChange([...colours, starts[[2, 3, 1, 0][colours.length] ?? 0]])
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <fieldset
        aria-label="Your colours"
        className="flex h-10 min-w-60 flex-1 overflow-hidden rounded-xl border border-border"
      >
        {colours.map((value, place) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: only listens for focus leaving the colour's own fields
          <div
            className={cn(
              "group/colour flex min-w-6 flex-1 items-center justify-center transition-[flex] duration-fast ease-standard motion-reduce:transition-none",
              !alone &&
                (editing === place
                  ? OPEN_COLOUR
                  : "focus-within:flex-[0_0_11rem] hover:flex-[0_0_11rem]")
            )}
            // biome-ignore lint/suspicious/noArrayIndexKey: a colour's place is its identity
            key={place}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setEditing(null)
              }
            }}
            style={{ backgroundColor: hex(value) ?? undefined }}
          >
            <div
              className={cn(
                "flex items-center gap-1 rounded-lg bg-card/95 p-0.5 shadow-sm transition-opacity duration-150 motion-reduce:transition-none",
                alone || editing === place
                  ? "opacity-100"
                  : "opacity-0 group-focus-within/colour:opacity-100 group-hover/colour:opacity-100"
              )}
            >
              <input
                aria-label={`Colour ${place + 1}, picker`}
                className="size-6 shrink-0 cursor-pointer rounded-md border border-border bg-transparent outline-none [&::-moz-color-swatch]:rounded [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
                onChange={(event) => set(place, event.currentTarget.value)}
                type="color"
                value={hex(value) ?? starts[2]}
              />
              <input
                aria-invalid={hex(value) === null}
                aria-label={`Colour ${place + 1}`}
                autoComplete="off"
                className="w-[4.75rem] min-w-0 bg-transparent font-mono text-base outline-none placeholder:text-muted-foreground aria-invalid:text-destructive md:text-xs"
                maxLength={7}
                onChange={(event) => set(place, event.currentTarget.value)}
                placeholder="#hex"
                ref={(node) => {
                  if (node && added.current === place) {
                    added.current = null
                    node.focus()
                  }
                }}
                spellCheck={false}
                value={value}
              />
              {alone ? null : (
                <Button
                  aria-label={`Remove colour ${place + 1}`}
                  className={ACCENT_RING}
                  onClick={() => {
                    setEditing(null)
                    onChange(colours.filter((_, slot) => slot !== place))
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden />
                </Button>
              )}
            </div>
          </div>
        ))}
      </fieldset>
      {colours.length < CUSTOM_MAX ? (
        <Button
          className={ACCENT_RING}
          onClick={add}
          size="sm"
          type="button"
          variant="ghost"
        >
          <PlusIcon aria-hidden />
          Add colour
        </Button>
      ) : null}
    </div>
  )
}

/** A logo type or style to pick: its pictures, cycling while hovered, and its name. */
function PickTile({
  checked,
  className,
  frames,
  label,
  labelSize = "text-xs",
  name,
  onPick,
  picture,
}: {
  checked: boolean
  className: string
  frames: string[]
  label: string
  labelSize?: string
  name: string
  onPick: () => void
  /** The picture box's size. */
  picture: string
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <RadioTile
      checked={checked}
      className={cn(PICK_TILE, className)}
      name={name}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPick={onPick}
    >
      <Cycling active={hovered} className={picture} frames={frames} />
      <span className={cn(PICK_LABEL, labelSize)}>{label}</span>
    </RadioTile>
  )
}

/**
 * Crossfades through the frames while active: each one dissolves in from a
 * slight zoom and blur. Frame 0 rests; the others load on the first hover.
 */
function Cycling({
  active,
  className,
  frames,
}: {
  active: boolean
  className: string
  frames: string[]
}) {
  const [at, setAt] = useState(0)
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (active) setArmed(true)
  }, [active])

  useEffect(() => {
    if (
      !active ||
      frames.length < 2 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setAt(0)
      return
    }
    // The first change comes quickly so the hover reads, then a calmer beat.
    const first = setTimeout(() => setAt(1), 220)
    const every = setInterval(
      () => setAt((now) => (now + 1) % frames.length),
      820
    )
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [active, frames.length])

  const shown = active ? at : 0
  return (
    <span className={cn("relative block shrink-0", className)}>
      {(armed ? frames : frames.slice(0, 1)).map((src, place) => (
        <img
          alt=""
          className={cn(
            "absolute inset-0 size-full object-contain transition-[opacity,scale,filter] duration-slow ease-standard motion-reduce:transition-none",
            place === shown
              ? "scale-100 opacity-100 blur-[0px]"
              : "scale-110 opacity-0 blur-[4px]"
          )}
          draggable={false}
          key={src}
          src={src}
        />
      ))}
    </span>
  )
}

/**
 * The live line under a round still drawing, saying only what is true of
 * it: the first ideas, the owner's colours when they chose some, then
 * almost ready once a design shows or most of the time has passed.
 */
function DrawingLine({
  round,
  colours,
}: {
  round: LogoRound
  /** The colours the owner chose, in words; null when they chose none. */
  colours: string | null
}) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((now) => now + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = (Date.now() - Date.parse(round.started_at)) / 1000
  const line =
    round.variants.length > 0 || elapsed >= LOGO_ROUND_SECONDS * 0.7
      ? "Almost ready"
      : colours && elapsed >= 6
        ? `Adding your ${colours}`
        : round.round === 1
          ? "Sketching the first ideas"
          : "Sketching new ideas"
  return (
    <p className="text-muted-foreground text-sm" role="status">
      {line}
    </p>
  )
}

export { TrayLogo }
