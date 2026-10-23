import {
  CaretLeftIcon,
  CaretRightIcon,
  PenNibIcon,
  SpinnerGapIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react"
import {
  type Asset,
  LOGO_ROUNDS_MAX,
  LOGO_STYLES,
  LOGO_VARIANTS,
  type LogoRound,
  type LogoStyle,
} from "@workspace/contracts"
import {
  ACCENT_RING,
  DropTile,
  type OfferedPalette,
  type Stops,
  sentence,
  TRAY_FIELD,
  TRAY_TILE,
  useTabDraft,
} from "@workspace/ui/components/assistant/question-tray"
import {
  type TrayPageProps,
  useTrayServices,
} from "@workspace/ui/components/assistant/tray-services"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { FIELD_ERROR, OPTION, OPTION_PILL } from "@workspace/ui/lib/card"
import { checkPhotos, sizeText, typesText } from "@workspace/ui/lib/upload"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useId, useRef, useState } from "react"

/**
 * The logo question's page in the design tray, which cannot be skipped: the
 * owner uploads the logo they have, or has one made. Making one takes a few
 * words on the look, the colours (the site's palette first) and a style; a
 * round draws four designs, saved by the api, so a reload reads the rounds
 * back and carries on. Picking a design keeps it as the logo and answers the
 * question; Ask for changes draws another round from the picked one.
 */

/** The logo question's answer: the logo kept. */
export type LogoAnswer = { logo: Asset }

const STYLE_LABELS: Record<LogoStyle, string> = {
  clean: "Clean",
  classic: "Classic",
  friendly: "Friendly",
  bold: "Bold",
  crafted: "Hand-drawn",
  premium: "Premium",
}

/** What the status line says while a round draws, a step every few seconds. */
const drawingLines = (name: string) => [
  `Sketching ideas for ${name}`,
  "Trying the name in four layouts",
  "Putting in your colours",
  "Tidying the edges",
  "Nearly there",
]

const NO_SERVICES = "Logos cannot be uploaded or made here."

/** The colours a logo is drawn in: the palette's primary for the shapes, its ink for the name. */
const logoColors = ([, , primary, ink]: Stops) => [primary, ink]

/**
 * A style's chip picture: the business's first letter set the way the style
 * would set it, in the chosen colours on the site's paper. Drawn, not
 * loaded, so it follows the colours picked.
 */
function StyleMark({
  style,
  stops: [paper, , primary, ink],
  letter,
}: {
  style: LogoStyle
  stops: Stops
  letter: string
}) {
  const type = {
    x: 32,
    y: 21,
    textAnchor: "middle",
    dominantBaseline: "central",
  } as const
  return (
    <svg
      aria-hidden
      className="h-12 w-full rounded-lg ring-1 ring-foreground/10"
      style={{ backgroundColor: paper }}
      viewBox="0 0 64 42"
    >
      {style === "clean" ? (
        <>
          <rect fill={primary} height="24" rx="5" width="24" x="20" y="9" />
          <text
            {...type}
            fill={paper}
            fontFamily="system-ui, sans-serif"
            fontSize="15"
            fontWeight="600"
          >
            {letter}
          </text>
        </>
      ) : style === "classic" ? (
        <>
          <circle cx="32" cy="21" fill="none" r="14" stroke={ink} />
          <circle
            cx="32"
            cy="21"
            fill="none"
            r="11.5"
            stroke={ink}
            strokeWidth="0.5"
          />
          <line
            stroke={ink}
            strokeWidth="0.75"
            x1="8"
            x2="15"
            y1="21"
            y2="21"
          />
          <line
            stroke={ink}
            strokeWidth="0.75"
            x1="49"
            x2="56"
            y1="21"
            y2="21"
          />
          <text
            {...type}
            fill={primary}
            fontFamily="Georgia, 'Times New Roman', serif"
            fontSize="14"
          >
            {letter}
          </text>
        </>
      ) : style === "friendly" ? (
        <>
          <path
            d="M32 6c9 0 15 6 15 15s-6 15-15 15-15-5-15-15 6-15 15-15Z"
            fill={primary}
          />
          <text
            {...type}
            fill={paper}
            fontFamily="ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', system-ui, sans-serif"
            fontSize="16"
            fontWeight="700"
          >
            {letter}
          </text>
        </>
      ) : style === "bold" ? (
        <>
          <rect fill={ink} height="28" width="28" x="18" y="7" />
          <text
            {...type}
            fill={primary}
            fontFamily="Impact, 'Arial Narrow', system-ui, sans-serif"
            fontSize="20"
            fontWeight="900"
          >
            {letter}
          </text>
        </>
      ) : style === "crafted" ? (
        <>
          <path
            d="M33 7.5c7.5.3 13.6 6 13 13.8-.5 7.6-6.6 13.4-14.3 13.2C24 34.2 18 28.3 18.5 20.5 19 13 25.6 7.2 33 7.5Z"
            fill="none"
            stroke={primary}
            strokeLinecap="round"
            strokeWidth="1.6"
          />
          <text
            {...type}
            fill={ink}
            fontFamily="'Segoe Script', 'Bradley Hand', 'Brush Script MT', cursive"
            fontSize="17"
            fontStyle="italic"
          >
            {letter}
          </text>
        </>
      ) : (
        <>
          <circle
            cx="32"
            cy="21"
            fill="none"
            r="14"
            stroke={primary}
            strokeWidth="0.6"
          />
          <text
            {...type}
            fill={ink}
            fontFamily="Didot, 'Bodoni 72', Georgia, serif"
            fontSize="13"
            fontWeight="300"
          >
            {letter}
          </text>
        </>
      )}
    </svg>
  )
}

/** A round in progress: the designs done so far, and a placeholder for each still drawing. */
function DrawingRound({
  round,
  imageUrl,
  paper,
  name,
}: {
  round: LogoRound
  imageUrl: (id: string) => string
  paper: string
  name: string
}) {
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
    <div className="flex flex-col gap-2">
      <ul aria-hidden className="grid @md:grid-cols-4 grid-cols-2 gap-2">
        {Array.from({ length: LOGO_VARIANTS }, (_, at) => {
          const variant = round.variants[at]
          return (
            <li key={variant?.id ?? at}>
              {variant ? (
                <img
                  alt=""
                  className="aspect-square w-full rounded-xl border border-border object-contain p-2"
                  src={imageUrl(variant.id)}
                  style={{ backgroundColor: paper }}
                />
              ) : (
                <Skeleton className="aspect-square rounded-xl border border-border bg-card" />
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-muted-foreground text-sm" role="status">
        {lines[beat]}
      </p>
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
}: TrayPageProps<LogoAnswer> & {
  /** The palettes the tray offers, the site's own first. */
  palettes: readonly OfferedPalette[]
}) {
  const id = useId()
  const services = useTrayServices()
  const [first] = question.card.preselected
  const [path, setPath] = useState<"upload" | "create" | null>(
    first === "upload" || first === "create" ? first : null
  )
  const { draft: brief, keep: setBrief } = useTabDraft<{
    description: string
    palette: number
    style: LogoStyle
  }>(`logo:${toolCallId}`, { description: "", palette: 0, style: "clean" })
  const [rounds, setRounds] = useState<LogoRound[]>([])
  const [at, setAt] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [changes, setChanges] = useState<string | null>(null)
  const [kept, setKept] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<{ file: File; url: string } | null>(null)
  // What the last round asked for beyond the brief, so Try again repeats it.
  const asked = useRef<{ changes?: string; base?: string }>({})

  const latest = rounds.at(-1)
  const drawing = latest?.status === "drawing"

  // The rounds drawn before a reload, and the page they were on.
  useEffect(() => {
    if (!services) return
    let live = true
    services
      .logoRounds(toolCallId)
      .then(({ rounds: drawn }) => {
        if (!live || drawn.length === 0) return
        setRounds(drawn)
        setPath((now) => now ?? "create")
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [services, toolCallId])

  // A round draws after its request answers; read it again until it is done.
  useEffect(() => {
    if (!drawing || !services) return
    const timer = setInterval(() => {
      services
        .logoRounds(toolCallId)
        .then(({ rounds: drawn }) => setRounds(drawn))
        .catch(() => undefined)
    }, 2500)
    return () => clearInterval(timer)
  }, [drawing, services, toolCallId])

  // The chosen file's preview, freed when another is chosen or the page goes.
  useEffect(
    () => () => {
      if (file) URL.revokeObjectURL(file.url)
    },
    [file]
  )

  const accept = question.upload?.accept ?? []
  const maxBytes = question.upload?.max_bytes ?? 0
  const palette = palettes[brief.palette] ?? palettes[0]
  const colors = palette?.stops ?? stops
  const letter = businessName.trim().charAt(0).toUpperCase() || "A"
  const round = at === null ? latest : rounds[at]
  const shownAt = at ?? rounds.length - 1

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
    asked.current = extra
    setError(null)
    setBusy("draw")
    try {
      const started = await services.drawLogos({
        tool_call_id: toolCallId,
        brief: {
          description: brief.description.trim(),
          colors: logoColors(colors),
          style: brief.style,
        },
        ...extra,
      })
      setRounds((now) => [
        ...now.filter((each) => each.round !== started.round),
        started,
      ])
      setAt(null)
      setEditing(false)
      setChanges(null)
    } catch (failure) {
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

  const askChanges = () => {
    const words = changes?.trim()
    if (!words) return
    const base =
      kept && round?.variants.some((each) => each.id === kept)
        ? kept
        : undefined
    void draw(base ? { changes: words, base } : { changes: words })
  }

  const form = path === "create" && (rounds.length === 0 || editing)
  const keptShown =
    answer && !(kept && round?.variants.some((each) => each.id === kept))

  return (
    <div className="flex shrink-0 flex-col gap-3">
      {keptShown && services ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-2">
          <img
            alt="Your logo"
            className="size-14 shrink-0 rounded-lg object-contain p-1"
            src={services.imageUrl(answer.logo.id)}
            style={{ backgroundColor: stops[0] }}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-sm">Your logo</span>
            <span className="text-muted-foreground text-xs">
              Upload or create another to change it
            </span>
          </span>
        </div>
      ) : null}

      <div
        aria-label="Your logo"
        className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2"
        role="radiogroup"
      >
        {(
          [
            [
              "upload",
              "Upload your logo",
              "Use the one you have",
              <UploadSimpleIcon aria-hidden key="icon" />,
            ],
            [
              "create",
              "Create one for me",
              "Pick from four designs",
              <PenNibIcon aria-hidden key="icon" />,
            ],
          ] as const
        ).map(([value, label, hint, icon]) => (
          <label className={TRAY_TILE} key={value}>
            <input
              checked={path === value}
              className="sr-only"
              name={`${id}-path`}
              onChange={() => {
                setPath(value)
                setError(null)
              }}
              type="radio"
              value={value}
            />
            <span className="flex items-center gap-2 font-medium text-sm [&_svg]:size-5 [&_svg]:text-primary">
              {icon}
              {label}
            </span>
            <span className="text-muted-foreground text-xs">{hint}</span>
          </label>
        ))}
      </div>

      {path === "upload" ? (
        file ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-2">
            <img
              alt=""
              className="size-14 shrink-0 rounded-lg object-contain p-1"
              src={file.url}
              style={{ backgroundColor: stops[0] }}
            />
            <span
              className="flex min-w-0 flex-1 items-center gap-2 text-sm"
              role="status"
            >
              {busy === "upload" ? (
                <>
                  <SpinnerGapIcon aria-hidden className="size-4 animate-spin" />
                  Saving your logo
                </>
              ) : (
                <span className="truncate">{file.file.name}</span>
              )}
            </span>
            {busy !== "upload" ? (
              <Button
                className={ACCENT_RING}
                onClick={() => void send(file.file)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : (
          <DropTile
            accept={accept}
            help={`${typesText(accept)}, up to ${sizeText(maxBytes)}. A clear background works best.`}
            icon={<UploadSimpleIcon />}
            onFiles={choose}
            title="Drop your logo here or choose it"
          />
        )
      ) : null}

      {form ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void draw({})
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label className="font-medium text-sm" htmlFor={`${id}-look`}>
              How should it look?
            </label>
            <textarea
              className={cn(
                "min-h-20 w-full border px-3 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm",
                TRAY_FIELD
              )}
              id={`${id}-look`}
              maxLength={300}
              onChange={(event) =>
                setBrief({ ...brief, description: event.currentTarget.value })
              }
              placeholder="For example: a simple house shape, plain and modern"
              value={brief.description}
            />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 font-medium text-sm">Colours</legend>
            <div className="flex flex-wrap gap-2">
              {palettes.map((each, index) => (
                <label
                  className={cn(
                    OPTION,
                    OPTION_PILL,
                    "gap-2 px-3 has-[:checked]:inset-ring-1 has-[:checked]:inset-ring-foreground has-[:checked]:border-foreground has-[:focus-visible]:border-primary has-[:checked]:bg-card has-[:focus-visible]:ring-primary"
                  )}
                  key={each.label}
                >
                  <input
                    checked={index === brief.palette}
                    className="sr-only"
                    name={`${id}-colours`}
                    onChange={() => setBrief({ ...brief, palette: index })}
                    type="radio"
                  />
                  <span aria-hidden className="flex">
                    {logoColors(each.stops).map((color, dot) => (
                      <span
                        className="-ml-1 size-4 rounded-full ring-2 ring-card first:ml-0"
                        // biome-ignore lint/suspicious/noArrayIndexKey: a palette may repeat a colour
                        key={dot}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </span>
                  {each.label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 font-medium text-sm">Style</legend>
            <div className="grid grid-cols-2 gap-2 min-[380px]:grid-cols-3">
              {LOGO_STYLES.map((style) => (
                <label className={cn(TRAY_TILE, "p-2")} key={style}>
                  <input
                    checked={style === brief.style}
                    className="sr-only"
                    name={`${id}-style`}
                    onChange={() => setBrief({ ...brief, style })}
                    type="radio"
                  />
                  <StyleMark letter={letter} stops={colors} style={style} />
                  <span className="font-medium text-xs">
                    {STYLE_LABELS[style]}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center gap-2">
            <Button
              className={cn(
                ACCENT_RING,
                "focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              )}
              disabled={busy === "draw"}
              type="submit"
            >
              {busy === "draw" ? (
                <SpinnerGapIcon aria-hidden className="animate-spin" />
              ) : null}
              Design my logo
            </Button>
            {editing ? (
              <Button
                className={ACCENT_RING}
                onClick={() => setEditing(false)}
                type="button"
                variant="ghost"
              >
                Back to the designs
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {path === "create" && !form && round && services ? (
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

          {round.status === "drawing" ? (
            <DrawingRound
              imageUrl={services.imageUrl}
              key={round.round}
              name={businessName}
              paper={stops[0]}
              round={round}
            />
          ) : round.status === "failed" ? (
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
              aria-label="Logo designs"
              className="grid @md:grid-cols-4 grid-cols-2 gap-2"
              role="radiogroup"
            >
              {round.variants.map((variant, place) => (
                <label className={cn(TRAY_TILE, "p-1.5")} key={variant.id}>
                  <input
                    checked={kept === variant.id}
                    className="sr-only"
                    disabled={busy !== null}
                    name={`${id}-design`}
                    onChange={() => void keep(variant.id)}
                    type="radio"
                  />
                  <span className="relative">
                    <img
                      alt={`Design ${place + 1}`}
                      className="aspect-square w-full rounded-lg object-contain p-2"
                      src={services.imageUrl(variant.id)}
                      style={{ backgroundColor: stops[0] }}
                    />
                    {busy === variant.id ? (
                      <SpinnerGapIcon
                        aria-label="Saving"
                        className="absolute top-1.5 right-1.5 size-4 animate-spin"
                      />
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )}

          {round.status === "ready" ? (
            changes !== null ? (
              <div className="flex @md:flex-row flex-col gap-2">
                <Input
                  aria-label="What should change?"
                  autoComplete="off"
                  autoFocus
                  className={cn("@md:flex-1 shrink-0", TRAY_FIELD)}
                  maxLength={300}
                  onChange={(event) => setChanges(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    // Enter tries again here, not the tray's Next.
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    event.stopPropagation()
                    askChanges()
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
                    className={ACCENT_RING}
                    disabled={!changes.trim() || busy === "draw"}
                    onClick={askChanges}
                    type="button"
                  >
                    Try again
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
            ) : rounds.length < LOGO_ROUNDS_MAX ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  className={ACCENT_RING}
                  onClick={() => setChanges("")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Ask for changes
                </Button>
                <Button
                  className={ACCENT_RING}
                  onClick={() => setEditing(true)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Start again
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                That is all the rounds for this logo. Pick one, or upload your
                own.
              </p>
            )
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className={FIELD_ERROR} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { TrayLogo }
