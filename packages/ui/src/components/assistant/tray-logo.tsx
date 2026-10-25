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
  Fold,
  type OfferedPalette,
  RadioTile,
  type Stops,
  Summary,
  Swatches,
  sentence,
  TRAY_FIELD,
  TRAY_TILE,
  type TrayFrameProps,
  useTabDraft,
  Ways,
} from "@workspace/ui/components/assistant/question-tray"
import {
  type TrayPageProps,
  useTrayServices,
} from "@workspace/ui/components/assistant/tray-services"
import { Button } from "@workspace/ui/components/button"
import { Diffusing } from "@workspace/ui/components/diffusing"
import { Input } from "@workspace/ui/components/input"
import { FIELD_ERROR } from "@workspace/ui/lib/card"
import { checkPhotos, sizeText, typesText } from "@workspace/ui/lib/upload"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

/**
 * The logo question's page in the design tray, the first question and one
 * that cannot be skipped. It asks first whether they have a logo, nothing
 * picked. Yes opens the upload. With no logo held, a round of three is drawn
 * from the filled brief as the page opens, so No shows its designs with the
 * first picked, at the top; under them the brief folds into summary rows (a
 * few words on the look, the colours, the logo type and a style) that reopen
 * it. Changing the brief turns the tray's primary into Redesign my logo,
 * which draws a round
 * from it. Rounds are saved by the api, so a reload reads them back. Picking
 * a design keeps it as the logo and answers the question; Change my logo
 * draws another round from the picked one, after the wait the api sets
 * between rounds.
 */

/** The logo question's answer: the logo kept. */
export type LogoAnswer = { logo: Asset }

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
  "Trying three different ideas",
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
}

/** Where the catalog opens the page. */
export type LogoStart = {
  path?: "upload" | "create"
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
  picking = false,
}: TrayPageProps<LogoAnswer> & {
  /** The palettes the tray offers, the site's own first. */
  palettes: readonly OfferedPalette[]
  /** Sets the tray's primary button while this page has its own; undefined hands it back. */
  setSubmit: (submit: TrayFrameProps["submit"]) => void
  start?: LogoStart | undefined
  /** Pick for me was pressed: with no logo yet, No and its first design. */
  picking?: boolean | undefined
}) {
  const id = useId()
  const services = useTrayServices()
  const [first] = question.card.preselected
  const [path, setPath] = useState(start?.path ?? null)
  const { draft: brief, keep: setBrief } = useTabDraft<Brief>(
    `logo-brief:${toolCallId}`,
    // Opened filled, the site's own colours first, so the first round needs
    // no answer; every part still changes.
    {
      description: "",
      colours: { palette: 0 },
      type: "lockup",
      style: "minimal",
      ...start?.brief,
    }
  )
  const [focus, setFocus] = useState<Part | null>(null)
  const [rounds, setRounds] = useState<LogoRound[]>([])
  // Whether the rounds drawn before have been read, so none is drawn twice.
  const [loaded, setLoaded] = useState(false)
  const [nextAt, setNextAt] = useState<number | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [changes, setChanges] = useState<string | null>(start?.changes ?? null)
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
          setLoaded(true)
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
  // A kept design or upload says which way was taken before a reload, once
  // the rounds are read; nothing is picked for the owner otherwise.
  const kept = answer?.logo.id ?? null
  const keptDrawn = rounds.some((each) =>
    each.variants.some((variant) => variant.id === kept)
  )
  const held = loaded ? (keptDrawn ? "create" : "upload") : null
  // Pick for me with no logo yet takes a drawn design, whatever was chosen.
  const shownPath =
    picking && !answer ? "create" : (path ?? (answer ? held : null))
  const round = at === null ? latest : rounds[at]
  const shownAt = at ?? rounds.length - 1
  const [uploadOption, createOption] = question.card.options

  const colours = brief.colours
  const colors = !colours
    ? []
    : "palette" in colours
      ? logoColors((palettes[colours.palette] ?? palettes[0])?.stops ?? stops)
      : "random" in colours
        ? logoColors(colours.random.stops)
        : colours.custom.flatMap((each) => hex(each) ?? [])
  const settled = {
    look: true,
    colours: colors.length > 0,
    type: brief.type !== null,
    style: brief.style !== null,
  }
  const briefReady = settled.colours && settled.type && settled.style
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
  // Changed since the newest round was drawn, so that round no longer shows it.
  const changed =
    wanted !== null && latest !== undefined && !sameBrief(wanted, latest.brief)
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

  /** Starts a round from the brief as it stands; true once it has started. */
  const draw = async (extra: { changes?: string; base?: string }) => {
    if (!services) {
      setError(NO_SERVICES)
      return false
    }
    if (!wanted) return false
    asked.current = extra
    setError(null)
    setBusy("draw")
    try {
      const started = await services.drawLogos({
        tool_call_id: toolCallId,
        brief: wanted,
        ...extra,
      })
      setRounds((now) => [
        ...now.filter((each) => each.round !== started.round),
        started,
      ])
      setAt(null)
      setChanges(null)
      setFocus(null)
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

  const keep = async (variant: string) => {
    if (!services) return setError(NO_SERVICES)
    setError(null)
    setBusy(variant)
    try {
      const { asset } = await services.keepLogo(variant)
      onAnswer({ logo: asset })
    } catch (failure) {
      setError(sentence(failure, "That design was not saved. Try again."))
    } finally {
      setBusy(null)
    }
  }

  // With no logo held (the api ticks create) one round starts as the page
  // opens, from the filled brief, before the owner says whether they have a
  // logo, so No has designs at once. A page the catalog opens in a given
  // state stays in it.
  const auto = useRef(first === "create" && !answer && !start)
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the rounds drawn before are read
  useEffect(() => {
    if (!loaded || !auto.current) return
    auto.current = false
    if (rounds.length === 0) void draw({})
  }, [loaded])

  // On No the newest round's first design is the pick, as it lands, until
  // the owner picks another. A failed keep waits for the owner.
  const [firstDesign] = latest?.status === "ready" ? latest.variants : []
  // biome-ignore lint/correctness/useExhaustiveDependencies: keep is a fresh closure each render
  useEffect(() => {
    if (create && firstDesign && !keptDrawn && busy === null && !error) {
      void keep(firstDesign.id)
    }
  }, [create, firstDesign, keptDrawn, busy, error])

  // A new round starts from the picked design, wherever it was drawn.
  const redesign = () => {
    const words = changes?.trim()
    void draw({
      ...(words ? { changes: words } : {}),
      ...(keptDrawn && kept ? { base: kept } : {}),
    })
  }

  // Random and Custom stay open to roll again or edit; a palette folds and the type opens.
  const setColours = (next: Colours, then: Part = "colours") => {
    setBrief({ ...brief, colours: next })
    setFocus(then)
  }
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

  // The section that opens comes into view once its fold has eased open.
  const page = useRef<HTMLDivElement>(null)
  const shownTop = useRef(top)
  useEffect(() => {
    if (shownTop.current === top) return
    shownTop.current = top
    const timer = setTimeout(() => {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)")
      page.current?.querySelector(`[data-part="${top}"]`)?.scrollIntoView({
        block: "nearest",
        behavior: still.matches ? "auto" : "smooth",
      })
    }, FOLD_MS)
    return () => clearTimeout(timer)
  }, [top])

  // With no round yet, or a brief changed since the newest, the tray's
  // primary is Redesign my logo while rounds are left; a layout effect, so the
  // tray never paints Next in its place.
  const designFirst =
    create && rounds.length < LOGO_ROUNDS_MAX && (!latest || changed)
  const design = useRef(() => undefined as undefined)
  design.current = () => {
    // The pick is set aside once the round starts; its first design follows.
    void draw({}).then((started) => {
      if (started && answer) onAnswer(undefined)
    })
  }
  const designDisabled = !briefReady || busy !== null || left > 0
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

  return (
    <div className="-my-1.5 flex shrink-0 flex-col" ref={page}>
      {/* The designs, once a round has started: first, so the pick needs no
          scroll; they fold away while the logo question is reopened. */}
      <Fold open={create && round !== undefined && !choiceOpen}>
        {round && services ? (
          <div className="flex flex-col gap-3" data-part="end">
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
                className="grid max-w-md grid-cols-3 gap-2"
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

      <Fold open={!choiceOpen}>
        <Summary label="Logo" onOpen={() => setFocus("choice")}>
          <span className="truncate">
            {shownPath === "upload" ? uploadOption?.label : createOption?.label}
          </span>
        </Summary>
      </Fold>
      <Fold open={choiceOpen}>
        <Ways
          label={question.question ?? "Your logo"}
          onPick={(way) => {
            setPath(way)
            setFocus(null)
            setError(null)
            // Yes sets a drawn design aside: the logo is the one they upload.
            if (way === "upload" && keptDrawn) onAnswer(undefined)
          }}
          // A tap on the one already chosen folds the pair again.
          onRepick={() => setFocus(null)}
          picked={shownPath}
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
        <div className="flex flex-col gap-2" data-part="look">
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
              : random
                ? random.label
                : "Your colours"}
          </span>
        </Summary>
      </Fold>
      <Fold open={opened("colours")}>
        <fieldset className="flex flex-col gap-2" data-part="colours">
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
                onPick={() => setColours({ palette: index }, "type")}
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
                // The first tap draws one; a tap on the one drawn picks it.
                onClick={() => random && setFocus("type")}
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
              onDone={() => setFocus("type")}
              starts={stops}
            />
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
        <fieldset className="flex flex-col gap-2" data-part="type">
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
                // Picked, it folds to a row and the style opens.
                onPick={() => {
                  setBrief({ ...brief, type })
                  setFocus("style")
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
        <fieldset className="flex flex-col gap-2" data-part="style">
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

      {error ? (
        <p className={cn(FIELD_ERROR, "px-0 pt-1")} role="alert">
          {error}
        </p>
      ) : null}
      {/* The api will not settle the tray without a logo, so Pick for me waits for one. */}
      {picking && !answer && (latest?.status === "failed" || error) ? (
        <p className="pt-1 text-muted-foreground text-sm" role="status">
          I need a logo to finish. Try the designs again, or upload yours.
        </p>
      ) : null}
    </div>
  )
}

/** A logo type or style to pick: its pictures, cycling while hovered, and its name. */
/** How long a section takes to fold, as `Fold` eases it. */
const FOLD_MS = 220

/** The width a custom colour opens to: its picker, its code and a remove. */
const OPEN_COLOUR = "flex-[0_0_11rem]"

/**
 * The owner's own colours as one strip, like a palette, the brand colour
 * first. A colour widens to its picker and code under the pointer or focus;
 * one just added opens with its code focused, and joins the strip again when
 * focus leaves it. Done keeps them and folds the section.
 */
function CustomColours({
  colours,
  starts,
  onChange,
  onDone,
}: {
  colours: string[]
  /** The site palette, whose next stop a new colour starts from. */
  starts: Stops
  onChange: (colours: string[]) => void
  onDone: () => void
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
      <Button
        className={ACCENT_RING}
        disabled={colours.every((each) => hex(each) === null)}
        onClick={onDone}
        size="sm"
        type="button"
        variant="outline"
      >
        Done
      </Button>
    </div>
  )
}

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
