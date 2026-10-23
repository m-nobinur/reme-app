import {
  CaretLeftIcon,
  CaretRightIcon,
  EyedropperIcon,
  PenNibIcon,
  PlusIcon,
  ShuffleIcon,
  SpinnerGapIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react"
import {
  type Asset,
  CALM_PALETTES,
  LOGO_ROUNDS_MAX,
  LOGO_STYLES,
  LOGO_TYPES,
  LOGO_VARIANTS,
  type LogoBrief,
  type LogoRound,
  type LogoStyle,
  type LogoType,
  PALETTES,
} from "@workspace/contracts"
import {
  ACCENT_RING,
  DropTile,
  type OfferedPalette,
  type Stops,
  Swatches,
  sentence,
  TRAY_FIELD,
  TRAY_TILE,
  type TrayFrameProps,
  useTabDraft,
} from "@workspace/ui/components/assistant/question-tray"
import {
  type TrayPageProps,
  useTrayServices,
} from "@workspace/ui/components/assistant/tray-services"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { FIELD_ERROR } from "@workspace/ui/lib/card"
import { checkPhotos, sizeText, typesText } from "@workspace/ui/lib/upload"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

/**
 * The logo question's page in the design tray, the first question and one
 * that cannot be skipped. It opens one section at a time, and a settled one
 * folds into a summary row that reopens it: do they have a logo; if so the
 * upload, else a few words on the look, the colours, the logo type and a
 * style. Design my logo draws a round of four, saved by the api, so a reload
 * reads the rounds back. Picking a design keeps it as the logo and answers
 * the question; Change my logo draws another round from the picked one,
 * after the wait the api sets between rounds.
 */

/** The logo question's answer: the logo kept. */
export type LogoAnswer = { logo: Asset }

const TYPE_LABELS: Record<LogoType, string> = {
  lockup: "Icon + name",
  icon: "Icon only",
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

const styleLabel = (style: LogoBrief["style"]) =>
  style === "surprise" ? "Surprise me" : STYLE_LABELS[style]

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

/** What the status line says while a round draws, a step every few seconds. */
const drawingLines = (name: string) => [
  `Sketching ideas for ${name}`,
  "Trying four different ideas",
  "Putting in your colours",
  "Tidying the edges",
  "Nearly there",
]

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
type Colours = { palette: number } | { random: string[] } | { custom: string[] }

/** The brief as the owner fills it in, kept in the tab. */
type Brief = {
  description: string
  colours: Colours | null
  type: LogoType | null
  style: LogoBrief["style"] | null
}

/** Where the catalog opens the page. */
export type LogoStart = {
  brief?: Partial<Brief>
  /** The change field open, with these words. */
  changes?: string
}

const BRIEF_PARTS = ["look", "colours", "type", "style"] as const
type Part = "choice" | (typeof BRIEF_PARTS)[number] | "end"
const order = (part: Part) =>
  part === "choice"
    ? -1
    : part === "end"
      ? BRIEF_PARTS.length
      : BRIEF_PARTS.indexOf(part)

/**
 * A part of the page that opens and folds: the height eases between none
 * and its content's, and its opacity with it, so the tray grows and shrinks
 * smoothly. Folded, it takes no focus.
 */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "-mx-1 grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      )}
      inert={!open}
    >
      {/* Relative, so the clip holds the sr-only radios too and a folded
          section adds nothing to the tray's scroll. Room for focus rings. */}
      <div className="relative min-h-0 overflow-hidden">
        <div className="px-1 py-1.5">{children}</div>
      </div>
    </div>
  )
}

/** A settled section as one row: what it is, what was chosen, and a tap to reopen it. */
function Summary({
  label,
  onOpen,
  children,
}: {
  label: string
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <button
      className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary"
      onClick={onOpen}
      type="button"
    >
      <span className="w-20 shrink-0 text-muted-foreground text-xs">
        {label}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2 font-medium">
        {children}
      </span>
      <span className="shrink-0 text-muted-foreground text-xs">Change</span>
    </button>
  )
}

/** A few colours as overlapping dots, for a summary row. */
function Dots({ colors }: { colors: readonly string[] }) {
  return (
    <span aria-hidden className="flex shrink-0">
      {colors.map((color, at) => (
        <span
          // The outline keeps a colour near the card's own visible in either theme.
          className="-ml-1 size-4 rounded-full border border-foreground/20 ring-2 ring-card first:ml-0"
          // biome-ignore lint/suspicious/noArrayIndexKey: two colours may match
          key={at}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  )
}

/**
 * A design still drawing: the chosen colours as soft light under a grain,
 * drifting and sharpening while it waits. Still under reduced motion.
 */
function Diffusing({
  colors,
  paper,
  delay,
}: {
  colors: readonly string[]
  paper: string
  delay: number
}) {
  const id = useId()
  const [first = paper, second = first] = colors
  return (
    <span
      aria-hidden
      className="relative block aspect-square overflow-hidden rounded-lg"
      style={{ backgroundColor: paper }}
    >
      <span
        className="absolute -inset-1/4 opacity-60 blur-xl motion-safe:animate-logo-diffuse"
        style={{
          animationDelay: `${-delay}ms`,
          backgroundImage: `radial-gradient(circle at 35% 35%, ${first}, transparent 55%), radial-gradient(circle at 65% 70%, ${second}, transparent 55%)`,
        }}
      />
      <svg
        className="absolute inset-0 size-full opacity-30 mix-blend-multiply"
        role="presentation"
      >
        <filter id={id}>
          <feTurbulence
            baseFrequency="0.85"
            numOctaves="2"
            stitchTiles="stitch"
            type="fractalNoise"
          />
        </filter>
        <rect filter={`url(#${id})`} height="100%" width="100%" />
      </svg>
    </span>
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
  start,
}: TrayPageProps<LogoAnswer> & {
  /** The palettes the tray offers, the site's own first. */
  palettes: readonly OfferedPalette[]
  /** Sets the tray's primary button while this page has its own; undefined hands it back. */
  setSubmit: (submit: TrayFrameProps["submit"]) => void
  start?: LogoStart | undefined
}) {
  const id = useId()
  const services = useTrayServices()
  const [first] = question.card.preselected
  const [path, setPath] = useState<"upload" | "create" | null>(
    first === "upload" || first === "create" ? first : null
  )
  const { draft: brief, keep: setBrief } = useTabDraft<Brief>(
    `logo-brief:${toolCallId}`,
    {
      description: "",
      colours: null,
      type: null,
      style: null,
      ...start?.brief,
    }
  )
  const [focus, setFocus] = useState<Part | null>(null)
  const [rounds, setRounds] = useState<LogoRound[]>([])
  const [nextAt, setNextAt] = useState<number | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [changes, setChanges] = useState<string | null>(start?.changes ?? null)
  const [kept, setKept] = useState<string | null>(answer?.logo.id ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<{ file: File; url: string } | null>(null)
  const [, tick] = useState(0)
  const replace = useRef<HTMLInputElement>(null)
  // What the last round asked for beyond the brief, so Try again repeats it.
  const asked = useRef<{ changes?: string; base?: string }>({})

  const latest = rounds.at(-1)
  const drawing = latest?.status === "drawing"

  // The rounds drawn before a reload, and again every few seconds while one
  // draws, since a round draws after its request answers.
  useEffect(() => {
    if (!services) return
    let live = true
    const read = () =>
      services
        .logoRounds(toolCallId)
        .then((drawn) => {
          if (!live) return
          setRounds(drawn.rounds)
          setNextAt(drawn.next_at ? Date.parse(drawn.next_at) : null)
        })
        .catch(() => undefined)
    const timer = drawing ? setInterval(read, 2500) : undefined
    if (!drawing) void read()
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [drawing, services, toolCallId])

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
  const shownPath =
    path ?? (rounds.length > 0 ? "create" : answer ? "upload" : null)
  const round = at === null ? latest : rounds[at]
  const shownAt = at ?? rounds.length - 1
  const [uploadOption, createOption] = question.card.options

  const colours = brief.colours
  const colors = !colours
    ? []
    : "palette" in colours
      ? logoColors((palettes[colours.palette] ?? palettes[0])?.stops ?? stops)
      : "random" in colours
        ? colours.random
        : colours.custom.flatMap((each) => hex(each) ?? [])
  const settled = {
    look: true,
    colours: colors.length > 0,
    type: brief.type !== null,
    style: brief.style !== null,
  }
  const briefReady = settled.colours && settled.type && settled.style
  // The first brief section still to answer, or the last.
  const limit = Math.max(
    BRIEF_PARTS.findIndex((part) => !settled[part]),
    briefReady ? BRIEF_PARTS.length - 1 : 0
  )
  // The top section open: the one the owner last settled or reopened.
  const top: Part =
    focus ??
    (shownPath === null
      ? "choice"
      : shownPath === "upload"
        ? "end"
        : !briefReady
          ? (BRIEF_PARTS[Math.max(0, limit - 1)] ?? "look")
          : rounds.length > 0
            ? "end"
            : "style")
  const create = shownPath === "create"
  const opened = (part: (typeof BRIEF_PARTS)[number]) =>
    create && order(part) >= order(top) && order(part) <= limit
  const folded = (part: (typeof BRIEF_PARTS)[number]) =>
    create && settled[part] && order(part) < order(top)
  const choiceOpen = shownPath === null || top === "choice"

  const send = async (chosen: File) => {
    if (!services) return setError(NO_SERVICES)
    setError(null)
    setBusy("upload")
    try {
      const { assets } = await services.upload([chosen])
      const stored = assets[0]
      if (!stored) throw new Error("The logo did not upload. Try again.")
      const { asset } = await services.keepLogo(stored.id)
      setKept(null)
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

  const draw = async (extra: { changes?: string; base?: string }) => {
    if (!services) return setError(NO_SERVICES)
    if (!brief.type || !brief.style || colors.length === 0) return
    asked.current = extra
    setError(null)
    setBusy("draw")
    try {
      const started = await services.drawLogos({
        tool_call_id: toolCallId,
        brief: {
          description: brief.description.trim(),
          colors,
          type: brief.type,
          style: brief.style,
        },
        ...extra,
      })
      setRounds((now) => [
        ...now.filter((each) => each.round !== started.round),
        started,
      ])
      setAt(null)
      setChanges(null)
      setFocus(null)
    } catch (failure) {
      const wait = retryAfter(failure)
      if (wait) setNextAt(Date.now() + wait * 1000)
      setError(sentence(failure, "The designs did not start. Try again."))
    } finally {
      setBusy(null)
    }
  }

  const keep = async (variant: string) => {
    if (!services) return setError(NO_SERVICES)
    setError(null)
    setBusy(variant)
    try {
      const { asset } = await services.keepLogo(variant)
      setKept(variant)
      onAnswer({ logo: asset })
    } catch (failure) {
      setError(sentence(failure, "That design was not saved. Try again."))
    } finally {
      setBusy(null)
    }
  }

  // A new round starts from the picked design, wherever it was drawn.
  const redesign = () => {
    const words = changes?.trim()
    const base = rounds.some((each) =>
      each.variants.some((variant) => variant.id === kept)
    )
      ? (kept ?? undefined)
      : undefined
    void draw({
      ...(words ? { changes: words } : {}),
      ...(base ? { base } : {}),
    })
  }

  const setColours = (next: Colours) => {
    setBrief({ ...brief, colours: next })
    setFocus("colours")
  }
  const custom = colours && "custom" in colours ? colours.custom : null
  const setCustom = (slot: number, value: string) =>
    custom &&
    setColours({
      custom: custom.map((each, place) => (place === slot ? value : each)),
    })

  const firstRound = create && rounds.length === 0

  // Before the first round the tray's primary button is Design my logo; a
  // layout effect, so the tray never paints Next in its place.
  const design = useRef(() => undefined as undefined)
  design.current = () => {
    // A logo kept before is set aside until a design is picked.
    if (answer) onAnswer(undefined)
    void draw({})
  }
  const designDisabled = !briefReady || busy !== null
  const designBusy = busy === "draw"
  useLayoutEffect(() => {
    setSubmit(
      firstRound
        ? {
            label: (
              <>
                {designBusy ? (
                  <SpinnerGapIcon aria-hidden className="animate-spin" />
                ) : null}
                Design my logo
              </>
            ),
            onSubmit: () => design.current(),
            disabled: designDisabled,
          }
        : undefined
    )
  }, [firstRound, designBusy, designDisabled, setSubmit])
  useLayoutEffect(() => () => setSubmit(undefined), [setSubmit])

  return (
    <div className="-my-1.5 flex shrink-0 flex-col">
      <Fold open={!choiceOpen}>
        <Summary label="Logo" onOpen={() => setFocus("choice")}>
          <span className="truncate">
            {shownPath === "upload" ? uploadOption?.label : createOption?.label}
          </span>
        </Summary>
      </Fold>
      <Fold open={choiceOpen}>
        <div
          aria-label={question.question ?? "Your logo"}
          className="grid @sm:grid-cols-2 grid-cols-1 gap-2"
          role="radiogroup"
        >
          {(
            [
              [
                "upload",
                uploadOption?.label ?? "Yes, I have my logo",
                "Upload the file you have",
                <UploadSimpleIcon aria-hidden key="icon" />,
              ],
              [
                "create",
                createOption?.label ?? "No, create one for me",
                "Pick from four designs",
                <PenNibIcon aria-hidden key="icon" />,
              ],
            ] as const
          ).map(([value, label, hint, icon]) => (
            <RadioTile
              checked={shownPath === value}
              className={TRAY_TILE}
              key={value}
              name={`${id}-path`}
              // A tap on the one already chosen folds the pair again.
              onClick={() => shownPath === value && setFocus(null)}
              onPick={() => {
                setPath(value)
                setFocus(null)
                setError(null)
              }}
            >
              <span className="flex items-center gap-2 font-medium text-sm [&_svg]:size-5 [&_svg]:text-primary">
                {icon}
                {label}
              </span>
              <span className="text-muted-foreground text-xs">{hint}</span>
            </RadioTile>
          ))}
        </div>
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
                  <SpinnerGapIcon aria-hidden className="size-4 animate-spin" />
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

      {/* No: the brief, a section at a time. */}
      <Fold open={folded("look")}>
        <Summary label="Look" onOpen={() => setFocus("look")}>
          <span className="truncate">
            {brief.description.trim() || "No preference"}
          </span>
        </Summary>
      </Fold>
      <Fold open={opened("look")}>
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
            rows={2}
            value={brief.description}
          />
        </div>
      </Fold>

      <Fold open={folded("colours")}>
        <Summary label="Colours" onOpen={() => setFocus("colours")}>
          <Dots colors={colors} />
          <span className="truncate">
            {colours && "palette" in colours
              ? palettes[colours.palette]?.label
              : colours && "random" in colours
                ? "Random"
                : "Your colours"}
          </span>
        </Summary>
      </Fold>
      <Fold open={opened("colours")}>
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
            <RadioTile
              checked={colours !== null && "random" in colours}
              className={cn(TRAY_TILE, COLOUR_TILE)}
              name={`${id}-colours`}
              onPick={() => {
                // A calm palette, never the warm oranges.
                const lucky =
                  CALM_PALETTES[
                    Math.floor(Math.random() * CALM_PALETTES.length)
                  ]
                const swatches = (PALETTES.find((each) => each.id === lucky)
                  ?.swatches ?? stops) as unknown as Stops
                setColours({ random: logoColors(swatches) })
              }}
            >
              <span className={NAMED_TILE}>
                <ShuffleIcon aria-hidden className="size-4" />
                Random
              </span>
            </RadioTile>
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
            <div className="flex flex-col gap-2">
              {custom.map((value, place) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a colour's place is its identity
                <div className="flex items-center gap-2" key={place}>
                  <input
                    aria-label={`Colour ${place + 1}, picker`}
                    className="size-10 shrink-0 cursor-pointer rounded-xl border border-border bg-card p-1 outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary"
                    onChange={(event) =>
                      setCustom(place, event.currentTarget.value)
                    }
                    type="color"
                    value={hex(value) ?? stops[2]}
                  />
                  <Input
                    aria-invalid={hex(value) === null}
                    aria-label={`Colour ${place + 1}`}
                    autoComplete="off"
                    className={cn("w-32 font-mono", TRAY_FIELD)}
                    maxLength={7}
                    onChange={(event) =>
                      setCustom(place, event.currentTarget.value)
                    }
                    placeholder="Hex code"
                    spellCheck={false}
                    value={value}
                  />
                  {place > 0 ? (
                    <Button
                      className={ACCENT_RING}
                      onClick={() => setColours({ custom: custom.slice(0, 1) })}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))}
              {custom.length < 2 ? (
                <Button
                  className={cn("self-start", ACCENT_RING)}
                  onClick={() => setColours({ custom: [...custom, stops[3]] })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <PlusIcon aria-hidden />
                  Add a second colour
                </Button>
              ) : null}
            </div>
          ) : null}
        </fieldset>
      </Fold>

      <Fold open={folded("type")}>
        <Summary label="Logo type" onOpen={() => setFocus("type")}>
          <span className="truncate">
            {brief.type ? TYPE_LABELS[brief.type] : null}
          </span>
        </Summary>
      </Fold>
      <Fold open={opened("type")}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium text-sm">Logo type</legend>
          {/* As many to a row as fit whole: three on a wide tray, one on the narrowest, so no name wraps. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            {LOGO_TYPES.map((type) => (
              <PickTile
                checked={type === brief.type}
                className="h-11 flex-row items-center gap-2.5 px-2"
                frames={framesOf("logo-types", type)}
                key={type}
                label={TYPE_LABELS[type]}
                name={`${id}-type`}
                onPick={() => {
                  setBrief({ ...brief, type })
                  setFocus("type")
                }}
                labelSize="text-sm"
                picture="h-7 w-10"
              />
            ))}
          </div>
        </fieldset>
      </Fold>

      <Fold open={folded("style")}>
        <Summary label="Style" onOpen={() => setFocus("style")}>
          <span className="truncate">
            {brief.style ? styleLabel(brief.style) : null}
          </span>
        </Summary>
      </Fold>
      <Fold open={opened("style")}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium text-sm">Style</legend>
          <div className="grid @md:grid-cols-4 grid-cols-3 gap-2">
            {LOGO_STYLES.map((style) => (
              <PickTile
                checked={style === brief.style}
                className="flex-col items-center gap-1.5 px-1.5 py-2"
                frames={framesOf("logo-styles", style)}
                key={style}
                label={STYLE_LABELS[style]}
                name={`${id}-style`}
                onPick={() => {
                  setBrief({ ...brief, style })
                  setFocus("style")
                }}
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
              onPick={() => {
                setBrief({ ...brief, style: "surprise" })
                setFocus("style")
              }}
            >
              <ShuffleIcon
                aria-hidden
                className="size-4 text-muted-foreground transition-colors group-has-[:checked]:text-primary"
              />
              <span className={cn(PICK_LABEL, "text-xs")}>Surprise me</span>
            </RadioTile>
          </div>
        </fieldset>
      </Fold>

      {/* The designs, once a round has started. */}
      <Fold open={create && round !== undefined}>
        {round && services ? (
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
              <div className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-3">
                <p className="text-sm">These designs did not come through.</p>
                <Button
                  className={ACCENT_RING}
                  disabled={busy === "draw"}
                  onClick={() => void draw(asked.current)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : (
              <div
                aria-busy={round.status === "drawing"}
                aria-label="Logo designs"
                className="grid @md:grid-cols-4 grid-cols-2 gap-2"
                role="radiogroup"
              >
                {Array.from({ length: LOGO_VARIANTS }, (_, place) => {
                  const variant = round.variants[place]
                  return (
                    <RadioTile
                      checked={variant !== undefined && kept === variant.id}
                      className={cn(TRAY_TILE, "p-1.5")}
                      disabled={
                        !variant || round.status !== "ready" || busy !== null
                      }
                      // biome-ignore lint/suspicious/noArrayIndexKey: a slot stays put while its design lands
                      key={place}
                      name={`${id}-design`}
                      onPick={() => variant && void keep(variant.id)}
                    >
                      <span className="relative">
                        {variant ? (
                          <img
                            alt={`Design ${place + 1}`}
                            // Lands from a blur, as tw-animate-css draws it.
                            className="motion-safe:fade-in aspect-square w-full rounded-lg object-contain p-2 duration-600 ease-out motion-safe:animate-in motion-safe:blur-in-md"
                            key={variant.id}
                            src={services.imageUrl(variant.id)}
                            style={{ backgroundColor: paper }}
                          />
                        ) : (
                          <Diffusing
                            colors={colors.length > 0 ? colors : [stops[2]]}
                            delay={place * 1500}
                            paper={paper}
                          />
                        )}
                        {busy === variant?.id ? (
                          <SpinnerGapIcon
                            aria-label="Saving"
                            className="absolute top-1.5 right-1.5 size-4 animate-spin"
                          />
                        ) : null}
                      </span>
                    </RadioTile>
                  )
                })}
              </div>
            )}

            {round.status === "drawing" ? (
              <DrawingLine key={round.round} name={businessName} />
            ) : null}

            {round.status === "ready" && rounds.length >= LOGO_ROUNDS_MAX ? (
              <p className="text-muted-foreground text-xs">
                That is all the rounds for this logo. Pick one, or upload your
                own.
              </p>
            ) : round.status === "ready" && changes === null ? (
              <Button
                className={cn("self-start", ACCENT_RING)}
                onClick={() => setChanges("")}
                size="sm"
                type="button"
                variant="outline"
              >
                Change my logo
              </Button>
            ) : round.status === "ready" && changes !== null ? (
              <div className="flex @md:flex-row flex-col gap-2">
                <Input
                  aria-label="What should change?"
                  autoComplete="off"
                  autoFocus={start?.changes === undefined}
                  className={cn("@md:flex-1 shrink-0", TRAY_FIELD)}
                  maxLength={300}
                  onChange={(event) => setChanges(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    // Enter redesigns here, not the tray's Next.
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    event.stopPropagation()
                    if (left <= 0 && busy === null && briefReady) redesign()
                  }}
                  placeholder={
                    kept
                      ? "What should change in the one you picked?"
                      : "What should change?"
                  }
                  value={changes}
                />
                <div className="flex gap-2">
                  <Button
                    className={cn("tabular-nums", ACCENT_RING)}
                    disabled={left > 0 || busy !== null || !briefReady}
                    onClick={redesign}
                    type="button"
                  >
                    {busy === "draw" ? (
                      <SpinnerGapIcon aria-hidden className="animate-spin" />
                    ) : null}
                    {left > 0 ? `Redesign ${waitText(left)}` : "Redesign"}
                  </Button>
                  <Button
                    className={ACCENT_RING}
                    onClick={() => setChanges(null)}
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Fold>

      {error ? (
        <p className={cn(FIELD_ERROR, "px-0 pt-1")} role="alert">
          {error}
        </p>
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

/** A tile that is one radio of a group: the input hidden, the tile its face. */
function RadioTile({
  checked,
  children,
  disabled,
  name,
  onPick,
  onClick,
  ...label
}: Omit<ComponentProps<"label">, "onClick"> & {
  checked: boolean
  disabled?: boolean
  name: string
  onPick: () => void
  onClick?: () => void
}) {
  return (
    <label {...label}>
      <input
        checked={checked}
        className="sr-only"
        disabled={disabled}
        name={name}
        onChange={onPick}
        onClick={onClick}
        type="radio"
      />
      {children}
    </label>
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
            "absolute inset-0 size-full object-contain transition-[opacity,scale,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
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

/** The live line under a round still drawing, a step every few seconds. */
function DrawingLine({ name }: { name: string }) {
  const lines = drawingLines(name)
  const [beat, setBeat] = useState(0)
  useEffect(() => {
    const timer = setInterval(
      () => setBeat((now) => Math.min(now + 1, lines.length - 1)),
      3000
    )
    return () => clearInterval(timer)
  }, [lines.length])
  return (
    <p className="text-muted-foreground text-sm" role="status">
      {lines[beat]}
    </p>
  )
}

export { TrayLogo }
