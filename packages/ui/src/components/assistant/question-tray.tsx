import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckSquareIcon,
  ShuffleIcon,
  SquareIcon,
} from "@phosphor-icons/react"
import {
  type AskDesignInput,
  type AskDesignOutput,
  FONT_PAIRS,
  PALETTES,
  type PaletteStops,
} from "@workspace/contracts"
import {
  type LogoStart,
  TrayLogo,
} from "@workspace/ui/components/assistant/tray-logo"
import { PalettePicture } from "@workspace/ui/components/assistant/tray-palette"
import {
  heldPhotosAnswer,
  TrayPhotos,
} from "@workspace/ui/components/assistant/tray-photos"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useFocusComposer } from "@workspace/ui/hooks/use-composer-input"
import {
  useFocusWhenIdle,
  useRevealWaiting,
} from "@workspace/ui/hooks/use-reveal-waiting"
import { OPTION, OPTION_TILE } from "@workspace/ui/lib/card"
import {
  faceStack as face,
  faceCss,
  previewFaces,
} from "@workspace/ui/lib/font-faces"
import { layoutLook } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"

/**
 * The question tray: every question onboarding asks the owner, docked above
 * the composer at its width and radius, with a gap between the two. The
 * call sits in the transcript like any card and draws itself in the slot the
 * thread keeps there (`Docked`), so it stays put while the owner scrolls or
 * types. One page shows at a time: a header with the question and a
 * collapse toggle, the body, and a footer with back and forward, Skip and
 * the primary button. Collapsed it is one row, the question and "2 of 4".
 * The tray never touches the composer, so a message typed while it is open
 * is an ordinary turn. On a phone it stays in the flow above the composer,
 * at most 60svh with its own scroll, so the composer stays reachable.
 */

const SlotContext = createContext<HTMLElement | null>(null)

/** The element above the composer the tray docks into, set by the thread. */
export const TraySlotProvider = SlotContext.Provider

/**
 * Draws an open question in the thread's tray slot, brings it into view once
 * no turn runs, and takes the focus then only from an empty composer. Where
 * the call sits in the transcript it says the assistant is waiting; the
 * thread dims behind an open tray (globals.css).
 */
function Docked({
  name,
  many = false,
  children,
}: {
  name: string
  /** The tray asks more than one question. */
  many?: boolean
  children: ReactNode
}) {
  const slot = useContext(SlotContext)
  const running = useRevealWaiting(true)
  const ref = useRef<HTMLDivElement>(null)
  useFocusWhenIdle(true, running, ref)
  if (!slot) return null
  return (
    <>
      {running ? null : (
        <p className="pt-3 text-muted-foreground text-sm">
          {many ? "Waiting for your answers" : "Waiting for your answer"}
        </p>
      )}
      {createPortal(
        <div data-slot={name} ref={ref}>
          {children}
        </div>,
        slot
      )}
    </>
  )
}

/**
 * A tray's answers so far, kept in this tab by the call's id, so a reload
 * resumes on the page the owner reached. Storage that throws or is empty
 * starts fresh; `clear` drops it once the call is answered.
 */
function useTabDraft<T>(id: string, empty: T) {
  const key = `tray:${id}`
  // Storage can throw (private windows, blocked site data); the tray then
  // just starts fresh after a reload.
  const store = <R,>(use: (storage: Storage) => R) => {
    try {
      return use(window.sessionStorage)
    } catch {
      return null
    }
  }
  const [draft, setDraft] = useState<T>(() => {
    const saved = store((storage) => storage.getItem(key))
    return saved ? (JSON.parse(saved) as T) : empty
  })
  const keep = (next: T) => {
    setDraft(next)
    store((storage) => storage.setItem(key, JSON.stringify(next)))
  }
  const clear = () => store((storage) => storage.removeItem(key))
  return { draft, keep, clear }
}

/**
 * Why an ask broke, where it stood in the thread. One a typed message
 * overtook leaves nothing: the owner's own message is right after it.
 */
function TrayNote({ name, error }: { name: string; error?: string | null }) {
  if (!error) return null
  return (
    <p className="my-3 text-destructive text-sm" data-slot={name}>
      {error}
    </p>
  )
}

/**
 * The tray's focus ring is the accent, as the site and the buttons around it
 * draw theirs, not the neutral grey of the shared token. Each control that
 * can take focus in the tray carries it.
 */
const ACCENT_RING = "focus-visible:border-primary focus-visible:ring-primary"

/**
 * An option tile in the tray, a label over a native radio or checkbox.
 * Picked is a 2px line in the text colour: a border and an inset ring of
 * one pixel each.
 */
const TRAY_TILE = cn(
  OPTION,
  OPTION_TILE,
  "rounded-xl has-[:focus-visible]:border-primary has-[:focus-visible]:ring-primary",
  "has-[:checked]:inset-ring-1 has-[:checked]:inset-ring-foreground has-[:checked]:border-foreground has-[:checked]:bg-card"
)

/** A field in the tray: the option tiles' radius, border and focus ring. */
const TRAY_FIELD = cn(
  "rounded-xl border-border bg-card focus-visible:ring-3",
  ACCENT_RING
)

/** A dashed tile that takes dropped files or opens the file chooser. */
function DropTile({
  title,
  help,
  accept,
  multiple = false,
  onFiles,
  icon,
  className,
}: {
  title: string
  help: string
  accept: readonly string[]
  multiple?: boolean
  onFiles: (files: File[]) => void
  icon: ReactNode
  className?: string
}) {
  const id = useId()
  const [over, setOver] = useState(false)
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border border-border border-dashed bg-card px-4 py-3 transition-colors duration-150",
        "hover:border-primary/50 has-[:focus-visible]:border-primary has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-primary",
        over && "border-primary bg-primary/5",
        className
      )}
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        onFiles(Array.from(event.dataTransfer.files))
      }}
    >
      <span aria-hidden className="text-primary [&_svg]:size-6">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-sm">{title}</span>
        <span className="text-muted-foreground text-xs" id={`${id}-help`}>
          {help}
        </span>
      </span>
      <input
        accept={accept.join(",")}
        aria-describedby={`${id}-help`}
        className="sr-only"
        multiple={multiple}
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files ?? []))
          // The same file can be chosen again.
          event.currentTarget.value = ""
        }}
        type="file"
      />
    </label>
  )
}

/** An error's sentence for the owner, or the fallback when it has none. */
const sentence = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

type Question = AskDesignInput["questions"][number]
type Option = Question["card"]["options"][number]
type Answer = AskDesignOutput["answers"][string]

/** The two section variants a layout option's wireframe is drawn from. */
type Layout = { hero: string; services: string }

/** The weight a pair's display face is set in: its first, which is the file the preview loads. */
const displayWeight = (family: string) =>
  FONT_PAIRS.find((pair) => pair.display.family === family)?.display
    .weights[0] ?? 400

/**
 * The preview's @font-face rules. Rendered only while a font_pair question is
 * open, so a page that never shows the tray fetches none of these files.
 */
function PreviewFaces() {
  return <style>{faceCss(previewFaces())}</style>
}

/** The four stops a site is drawn in, in `PALETTES[].swatches` order. */
type Stops = readonly [
  paper: string,
  tint: string,
  primary: string,
  ink: string,
]

/**
 * A wireframe of a hero and the services under it, drawn in the site's own
 * four colours and not the app's tokens: the site looks the same in either
 * app theme, and so does its sketch. Two directions that differ in those two
 * variants differ at a glance. A variant the sketch does not know draws the
 * first of each.
 */
function LayoutSketch({
  hero,
  services,
  stops: [paper, tint, primary, ink],
  className,
}: Layout & { stops: Stops; className?: string }) {
  // One fill per role; opacity does the softening so the stops stay the site's.
  const fill = (color: string, opacity = 1) => ({
    fill: color,
    fillOpacity: opacity,
  })
  const text = fill(ink, 0.75)
  const quiet = fill(ink, 0.25)
  const wash = fill(tint)
  const button = fill(primary)
  const rule = { stroke: ink, strokeOpacity: 0.15 }
  return (
    <svg
      aria-hidden
      className={cn(
        "mx-auto h-24 w-auto rounded-xl ring-1 ring-foreground/15",
        className
      )}
      data-hero={hero}
      data-services={services}
      viewBox="0 0 120 84"
    >
      <rect height="84" style={fill(paper)} width="120" />
      <rect height="3" rx="1.5" style={text} width="14" x="6" y="4" />
      <rect height="2" rx="1" style={quiet} width="26" x="70" y="4.5" />
      {hero === "dark_center" ? (
        <>
          <rect height="38" style={fill(ink)} width="120" y="11" />
          <rect
            height="5"
            rx="1.5"
            style={fill(paper)}
            width="56"
            x="32"
            y="21"
          />
          <rect
            height="2"
            rx="1"
            style={fill(paper, 0.5)}
            width="40"
            x="40"
            y="30"
          />
          <rect height="5" rx="1.5" style={button} width="16" x="52" y="37" />
        </>
      ) : hero === "wash" ? (
        <>
          <rect height="38" style={fill(primary, 0.25)} width="120" y="11" />
          <rect height="5" rx="1.5" style={text} width="44" x="8" y="21" />
          <rect height="5" rx="1.5" style={text} width="32" x="8" y="28" />
          <rect height="5" rx="1.5" style={button} width="14" x="8" y="37" />
          <rect
            height="4"
            rx="2"
            style={fill(paper, 0.7)}
            width="22"
            x="90"
            y="42"
          />
        </>
      ) : hero === "split_frame" ? (
        <>
          <rect height="5" rx="1.5" style={text} width="40" x="8" y="19" />
          <rect height="5" rx="1.5" style={text} width="30" x="8" y="26" />
          <rect height="2" rx="1" style={quiet} width="34" x="8" y="34" />
          <rect height="5" rx="1.5" style={button} width="14" x="8" y="40" />
          <rect height="34" rx="3" style={wash} width="48" x="64" y="13" />
          <rect
            height="4"
            rx="2"
            style={fill(paper, 0.9)}
            width="18"
            x="90"
            y="41"
          />
        </>
      ) : hero === "text_led" ? (
        <>
          <rect height="7" rx="1.5" style={text} width="70" x="8" y="17" />
          <rect height="7" rx="1.5" style={text} width="56" x="8" y="27" />
          <rect height="2" rx="1" style={quiet} width="44" x="8" y="38" />
          <rect height="5" rx="1.5" style={button} width="14" x="8" y="43" />
          <rect height="18" rx="1.5" style={wash} width="18" x="94" y="26" />
        </>
      ) : (
        <>
          <rect height="5" rx="1.5" style={text} width="40" x="8" y="19" />
          <rect height="5" rx="1.5" style={text} width="30" x="8" y="26" />
          <rect height="2" rx="1" style={quiet} width="34" x="8" y="34" />
          <rect height="5" rx="1.5" style={button} width="14" x="8" y="40" />
          <path
            d="M70 48 V30 a18 18 0 0 1 36 0 V48 Z"
            style={fill(primary, 0.25)}
          />
        </>
      )}
      {services === "numbered_rows"
        ? [54, 64, 74].map((y) => (
            <g key={y}>
              <circle cx="12" cy={y + 3} r="3.5" style={wash} />
              <rect
                height="2.5"
                rx="1.25"
                style={text}
                width="36"
                x="22"
                y={y + 1}
              />
              <rect
                height="2"
                rx="1"
                style={quiet}
                width="60"
                x="22"
                y={y + 5}
              />
              <line style={rule} x1="6" x2="114" y1={y + 9} y2={y + 9} />
            </g>
          ))
        : services === "alternating"
          ? [53, 68].map((y, row) => (
              <g key={y}>
                <rect
                  height="12"
                  rx="1.5"
                  style={wash}
                  width="34"
                  x={row ? 80 : 6}
                  y={y}
                />
                <rect
                  height="2.5"
                  rx="1.25"
                  style={text}
                  width="40"
                  x={row ? 8 : 46}
                  y={y + 2}
                />
                <rect
                  height="2"
                  rx="1"
                  style={quiet}
                  width="52"
                  x={row ? 8 : 46}
                  y={y + 7}
                />
              </g>
            ))
          : services === "fleet"
            ? [6, 62].map((x) => (
                <g key={x}>
                  <rect
                    height="16"
                    rx="1.5"
                    style={wash}
                    width="52"
                    x={x}
                    y="54"
                  />
                  <rect
                    height="3"
                    rx="1.5"
                    style={quiet}
                    width="12"
                    x={x}
                    y="73"
                  />
                  <rect
                    height="3"
                    rx="1.5"
                    style={quiet}
                    width="12"
                    x={x + 15}
                    y="73"
                  />
                </g>
              ))
            : services === "practice_list"
              ? [54, 63, 72].map((y, row) => (
                  <g key={y}>
                    <rect
                      height="2.5"
                      rx="1.25"
                      style={text}
                      width="6"
                      x="6"
                      y={y + 1}
                    />
                    <rect
                      height="2.5"
                      rx="1.25"
                      style={text}
                      width={30 + row * 4}
                      x="18"
                      y={y + 1}
                    />
                    <rect
                      height="2"
                      rx="1"
                      style={quiet}
                      width="70"
                      x="18"
                      y={y + 5}
                    />
                  </g>
                ))
              : [6, 44, 82].map((x) => (
                  <g key={x}>
                    <rect
                      height="14"
                      rx="1.5"
                      style={wash}
                      width="32"
                      x={x}
                      y="53"
                    />
                    <rect
                      height="2.5"
                      rx="1.25"
                      style={text}
                      width="22"
                      x={x}
                      y="70"
                    />
                    <rect
                      height="2"
                      rx="1"
                      style={quiet}
                      width="30"
                      x={x}
                      y="75"
                    />
                  </g>
                ))}
    </svg>
  )
}

/** A palette as the tray offers it: its name and its four stops. */
type Offered = { label: string; stops: Stops }

/** A picture's palette as four stops. */
const pictureStops = ({ paper, tint, primary, ink }: PaletteStops): Stops => [
  paper,
  tint,
  primary,
  ink,
]

/**
 * The options a page shows: the card's `initial` ones when it has them, with
 * a pick from the rest (Surprise me) first in place of the last.
 */
function shownOptions(question: Question, answer: Answer | undefined) {
  const { options, initial } = question.card
  if (!initial) return options
  const shown = options.filter((each) => initial.includes(each.id))
  const picked =
    answer && "choice" in answer && !initial.includes(answer.choice)
      ? options.find((each) => each.id === answer.choice)
      : undefined
  return picked ? [picked, ...shown.slice(0, -1)] : shown
}

/**
 * The palettes the tray offers, the site's own first: the one the owner
 * picked or read from a picture, else the first offered, else the first
 * palette there is, then the next in the api's order up to six. The
 * sketches are drawn in the first; the logo page offers all six.
 */
function offeredPalettes(
  questions: Question[],
  answers: Record<string, Answer>
): [Offered, ...Offered[]] {
  const asked = questions.find((each) => each.visual === "palette")
  const picked = asked && answers[asked.id]
  const offered = (
    asked
      ? [...new Set([...shownOptions(asked, picked), ...asked.card.options])]
      : []
  ).flatMap(({ id, label, visual }) =>
    visual?.kind === "swatches" && visual.colors.length === 4
      ? [{ id, label, stops: visual.colors as unknown as Stops }]
      : []
  )
  const site =
    picked && "palette" in picked
      ? {
          label: picked.palette.name,
          stops: pictureStops(picked.palette.stops),
        }
      : (offered.find(
          (each) => picked && "choice" in picked && each.id === picked.choice
        ) ?? offered[0])
  const first = PALETTES[0]
  return site
    ? [site, ...offered.filter((each) => each.label !== site.label).slice(0, 5)]
    : [
        {
          label: first?.label ?? "",
          stops: first?.swatches as unknown as Stops,
        },
      ]
}

/** A palette's colours as a strip, left to right. */
function Swatches({ colors }: { colors: readonly string[] }) {
  return (
    // The palette's own colours, data from the call, filling the tile edge to edge.
    <span aria-hidden className="flex h-10 w-full">
      {colors.map((color, at) => (
        <span
          className="h-full flex-1"
          // biome-ignore lint/suspicious/noArrayIndexKey: two stops may share a colour
          key={at}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  )
}

/** What an option shows above its label, from the question's visual and the option's own data. */
function Picture({
  option,
  stops,
  name,
}: {
  option: Option
  stops: Stops
  name: string
}) {
  const { visual } = option
  if (visual?.kind === "swatches") return <Swatches colors={visual.colors} />
  if (visual?.kind === "font_pair") {
    const { display, body } = visual
    return (
      <span aria-hidden className="flex w-full flex-col gap-1">
        <span
          className="wrap-break-word text-xl leading-tight"
          style={{
            fontFamily: face(display),
            fontWeight: displayWeight(display),
          }}
        >
          {name}
        </span>
        <span
          className="wrap-break-word text-sm"
          style={{ fontFamily: face(body) }}
        >
          Get a clear quote and a quick reply.
        </span>
        <span className="text-muted-foreground text-xs">
          {display} and {body}
        </span>
      </span>
    )
  }
  if (visual?.kind === "layout") {
    return (
      <LayoutSketch
        className="h-auto w-full"
        hero={visual.hero}
        services={visual.services}
        stops={stops}
      />
    )
  }
  return null
}

type TrayFrameProps = {
  /** The header, and the tray's accessible name. */
  question: string
  /** A muted line under the question. */
  hint?: string | null | undefined
  /** Where the owner is when the ask has several pages, zero based. */
  page?: { index: number; total: number } | undefined
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** Back and forward; without one its arrow is disabled. */
  onBack?: (() => void) | undefined
  onForward?: (() => void) | undefined
  skip?: { label: string; onSkip: () => void; disabled?: boolean } | undefined
  /**
   * The primary button. With `form` it submits that form, so Enter in a
   * field submits too; without, Enter in a field presses it.
   */
  submit?:
    | {
        label: ReactNode
        onSubmit?: () => void
        form?: string
        disabled?: boolean
      }
    | undefined
  /** A short live line beside the buttons, such as "3 of 10 chosen". */
  status?: ReactNode
  bodyRef?: RefObject<HTMLDivElement | null>
  className?: string
  children: ReactNode
}

/** The tray's frame: header, scrolling body and footer, or the one collapsed row. */
function TrayFrame({
  question,
  hint,
  page,
  collapsed,
  onCollapsedChange,
  onBack,
  onForward,
  skip,
  submit,
  status,
  bodyRef: givenBody,
  className,
  children,
}: TrayFrameProps) {
  const id = useId()
  const ownBody = useRef<HTMLDivElement>(null)
  const bodyRef = givenBody ?? ownBody
  const rootRef = useRef<HTMLElement>(null)
  const settled = useRef<boolean>(false)
  const [more, setMore] = useState(false)
  const focusComposer = useFocusComposer()
  const paged = page !== undefined && page.total > 1
  const count = paged ? `${page.index + 1} of ${page.total}` : null

  // A new page takes the keyboard when it was in the tray, so Tab and the
  // arrow keys carry on in it; focus in the composer is left alone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of page moves focus
  useEffect(() => {
    if (!settled.current) {
      settled.current = true
      return
    }
    if (!rootRef.current?.contains(document.activeElement)) return
    // Pages the owner is not on stay in the form, hidden; their fields are skipped.
    const shown = [
      ...(bodyRef.current?.querySelectorAll<HTMLInputElement>("input") ?? []),
    ].filter((input) => input.checkVisibility({ checkOpacity: true }))
    ;(shown.find((input) => input.checked) ?? shown[0])?.focus()
  }, [page?.index])

  // Whether the body hides content below its fold, so a fade can say so.
  const measure = () => {
    const body = bodyRef.current
    if (body)
      setMore(body.scrollHeight - body.scrollTop - body.clientHeight > 4)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the page or its state changes
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(body)
    return () => watch.disconnect()
  }, [page?.index, collapsed])

  const collapse = () => {
    onCollapsedChange(true)
    focusComposer()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !collapsed) {
      event.preventDefault()
      collapse()
    } else if (
      event.key === "Enter" &&
      !collapsed &&
      !submit?.form &&
      event.target instanceof HTMLInputElement
    ) {
      event.preventDefault()
      if (!submit?.disabled) submit?.onSubmit?.()
    }
  }

  return (
    <section
      aria-describedby={!collapsed && hint ? `${id}-hint` : undefined}
      aria-label={collapsed ? question : undefined}
      aria-labelledby={collapsed ? undefined : `${id}-question`}
      className={cn(
        "@container flex max-h-[min(36rem,max(15rem,45dvh))] w-full flex-col rounded-[var(--composer-radius,var(--radius-4xl))] border border-border bg-card text-card-foreground max-sm:max-h-[60svh]",
        className
      )}
      data-collapsed={collapsed || undefined}
      data-slot="question-tray"
      onKeyDown={onKeyDown}
      ref={rootRef}
    >
      {paged ? (
        <p aria-live="polite" className="sr-only">
          {`Question ${page.index + 1} of ${page.total}`}
        </p>
      ) : null}
      {collapsed ? (
        <button
          aria-expanded={false}
          className="flex w-full items-center gap-3 rounded-[var(--composer-radius,var(--radius-4xl))] px-5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-primary"
          onClick={() => onCollapsedChange(false)}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate font-medium text-base">
            {question}
          </span>
          {count ? (
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {count}
            </span>
          ) : null}
          <CaretUpIcon aria-hidden className="size-4 shrink-0" />
        </button>
      ) : (
        <>
          <div className="flex items-center gap-2 border-border border-b py-3 pr-4 pl-5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="font-medium text-base" id={`${id}-question`}>
                {question}
              </h2>
              {hint ? (
                <p className="text-muted-foreground text-xs" id={`${id}-hint`}>
                  {hint}
                </p>
              ) : null}
            </div>
            {count ? (
              <span
                aria-hidden
                className="shrink-0 text-muted-foreground text-xs tabular-nums"
              >
                {count}
              </span>
            ) : null}
            <Button
              aria-controls={`${id}-body`}
              aria-expanded
              aria-label="Collapse"
              className={ACCENT_RING}
              onClick={collapse}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <CaretDownIcon aria-hidden />
            </Button>
          </div>
          <div className="relative flex min-h-0 flex-col [--body:var(--muted)] dark:[--body:var(--background)]">
            {/* relative: the visually hidden radios inside are placed against
                this scroller, so it clips them. Placed against the frame
                instead, the ones in a folded section stretched the thread
                and the composer slid as it scrolled. */}
            <div
              className="relative flex min-h-0 flex-col gap-3 overflow-y-auto rounded-b-3xl bg-(--body) p-3"
              id={`${id}-body`}
              onScroll={measure}
              ref={bodyRef}
            >
              {children}
            </div>
            {more ? (
              // A fade, not a decoration: it says there is more below.
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-3xl bg-linear-to-t from-(--body) to-transparent"
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1 p-4">
            {paged ? (
              <>
                <Button
                  aria-label="Previous question"
                  className={ACCENT_RING}
                  disabled={!onBack}
                  onClick={onBack}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <CaretLeftIcon aria-hidden />
                </Button>
                <Button
                  aria-label="Next question"
                  className={ACCENT_RING}
                  disabled={!onForward}
                  onClick={onForward}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <CaretRightIcon aria-hidden />
                </Button>
              </>
            ) : null}
            <span
              className="min-w-0 flex-1 px-1 text-muted-foreground text-xs"
              role="status"
            >
              {status}
            </span>
            {skip ? (
              <Button
                className={ACCENT_RING}
                disabled={skip.disabled}
                onClick={skip.onSkip}
                type="button"
                variant="ghost"
              >
                {skip.label}
              </Button>
            ) : null}
            {submit ? (
              // Filled with the accent, so its ring stands off the fill.
              <Button
                className={cn(
                  ACCENT_RING,
                  "px-5 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                )}
                disabled={submit.disabled}
                form={submit.form}
                onClick={submit.form ? undefined : submit.onSubmit}
                type={submit.form ? "submit" : "button"}
              >
                {submit.label}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}

/** Where a tray starts, when it does not start fresh. The catalog draws every state with it. */
type Start = {
  index?: number
  collapsed?: boolean
  answers?: Record<string, Answer>
  /** A picture's colours being read on the palette page. */
  reading?: boolean
  /** Where the logo page opens. */
  logo?: LogoStart
}

type QuestionTrayProps = {
  input: AskDesignInput
  /** The tray's call, which names its logo rounds. */
  toolCallId: string
  /** An answer, as the owner leaves its question. Store it; a reload resumes after it. */
  onAnswer?: (id: string, answer: Answer) => void
  /** Build my site or Skip all. */
  onFinish: (output: AskDesignOutput) => void
  start?: Start
  /** The business's name, which the lettering previews are set in. */
  businessName?: string | null
  className?: string
}

/**
 * The design questions of a build, one page each: the options as a native
 * radio group, or checkboxes on a question that takes several, Write your
 * own, and Next, which reads Build my site on the last. Answers are code's:
 * `onAnswer` gets each one as the owner leaves its question, `onFinish` the
 * `AskDesignOutput` on Build my site or Skip all.
 */
function QuestionTray({
  input,
  toolCallId,
  onAnswer,
  onFinish,
  start,
  businessName,
  className,
}: QuestionTrayProps) {
  const { questions } = input
  const id = useId()
  // Options the api opened ticked, and own words it holds, are answers
  // already given, so a reload resumes on the first question without one.
  const ticked: Record<string, Answer> = Object.fromEntries(
    questions.flatMap((each): [string, Answer][] => {
      const [first] = each.card.preselected
      const own = each.card.own
      // A logo or photos page's ticked option only opens that path.
      if (each.visual === "logo") {
        const logo = each.held?.[0]
        return logo ? [[each.id, { logo }]] : []
      }
      if (each.visual === "photos") {
        const held = heldPhotosAnswer(each.held)
        return held ? [[each.id, held]] : []
      }
      if (own) return [[each.id, { own }]]
      if (first && each.card.multiple)
        return [[each.id, { choices: each.card.preselected }]]
      return first ? [[each.id, { choice: first }]] : []
    })
  )
  const [answers, setAnswers] = useState(start?.answers ?? ticked)
  const firstOpen = questions.findIndex((each) => !(each.id in answers))
  const [index, setIndex] = useState(
    start?.index ?? (firstOpen < 0 ? questions.length - 1 : firstOpen)
  )
  const [collapsed, setCollapsed] = useState(start?.collapsed ?? false)
  const [finishing, setFinishing] = useState(false)
  // A palette read from a picture stays offered when another is picked.
  const [picture, setPicture] = useState(
    () =>
      Object.values(answers).flatMap((each) =>
        "palette" in each ? [each.palette] : []
      )[0] ?? null
  )
  // The logo page's own primary button (Design my logo), while it has one.
  const [logoSubmit, setLogoSubmit] = useState<TrayFrameProps["submit"]>()
  const focusComposer = useFocusComposer()

  const question = questions[index]
  if (!question) return null
  const name = businessName?.trim() || "Your business"
  const palettes = offeredPalettes(questions, answers)
  const { stops } = palettes[0]
  const total = questions.length
  const last = index === total - 1
  const answer = answers[question.id]
  const skippable = question.card.skippable
  const ready = answer !== undefined || skippable
  const other = question.card.other

  /** Hands the current answer on, and returns the answers with it. */
  const settle = (skipping: boolean, chosen = answer) => {
    const given = chosen ?? (skipping && skippable ? { skipped: true } : null)
    if (!given) return answers
    const now = { ...answers, [question.id]: given } as typeof answers
    onAnswer?.(question.id, given as Answer)
    setAnswers(now)
    return now
  }
  const go = (to: number, skipping: boolean, chosen = answer) => {
    settle(skipping, chosen)
    setIndex(to)
  }
  // The logo cannot be skipped: Skip all without one opens its page, whose
  // primary button then finishes the skip.
  const finish = (skipAll: boolean, chosen = answer) => {
    const now = settle(!skipAll, chosen)
    const logo = questions.findIndex(
      (each) => each.visual === "logo" && !(each.id in now)
    )
    if (logo >= 0) {
      setIndex(logo)
      setFinishing(true)
      return
    }
    onFinish({ answers: now, skip_all: skipAll || finishing })
    focusComposer()
  }
  // Next, with the answer a page has only just set when it moves on itself.
  const onward = (chosen = answer) => {
    if (last || finishing) finish(finishing, chosen)
    else go(index + 1, true, chosen)
  }
  const next = () => {
    if (ready) onward()
  }
  const set = (given: Answer | undefined) =>
    setAnswers((now) => {
      const { [question.id]: _, ...rest } = now
      return given ? { ...now, [question.id]: given } : rest
    })
  const page = { question, toolCallId, stops, businessName: name }
  const shown = shownOptions(question, answer)
  // Any palette but the one picked, from every one offered, not only those shown.
  const surprise = () => {
    const rest = question.card.options.filter(
      (each) => !(answer && "choice" in answer && answer.choice === each.id)
    )
    const lucky = rest[Math.floor(Math.random() * rest.length)]
    if (lucky) pick(lucky.id)
  }
  const ownPage = question.visual === "logo" || question.visual === "photos"

  const own = answer && "own" in answer ? answer.own : ""
  const multiple = question.card.multiple
  const ticks = answer && "choices" in answer ? answer.choices : []
  const pick = (value: string) =>
    setAnswers((now) => ({ ...now, [question.id]: { choice: value } }))
  // A tick toggles; the options keep their order, and none ticked is unanswered.
  const toggle = (value: string) =>
    setAnswers((now) => {
      const { [question.id]: _, ...rest } = now
      const choices = question.card.options
        .map((each) => each.id)
        .filter((each) => (each === value) !== ticks.includes(each))
      return choices.length > 0 ? { ...now, [question.id]: { choices } } : rest
    })
  const write = (words: string) =>
    set(words.trim() ? { own: words } : undefined)

  const logo = question.visual === "logo"

  return (
    <TrayFrame
      className={className}
      collapsed={collapsed}
      hint={multiple ? "Pick any that fit" : null}
      onBack={index === 0 ? undefined : () => go(index - 1, false)}
      onCollapsedChange={setCollapsed}
      onForward={last || !ready ? undefined : () => go(index + 1, true)}
      page={{ index, total }}
      question={question.question ?? "Choose one"}
      // The logo cannot be skipped, so its page offers no Skip all.
      skip={
        logo
          ? undefined
          : {
              label: "Skip all",
              onSkip: () => finish(true),
              disabled: finishing && !ready,
            }
      }
      status={finishing && !ready ? "A logo is all that is still needed" : null}
      submit={
        (logo && logoSubmit) || {
          label: last || finishing ? "Build my site" : "Next",
          onSubmit: next,
          disabled: !ready,
        }
      }
    >
      {question.visual === "font_pair" && <PreviewFaces />}
      {logo ? (
        <TrayLogo
          {...page}
          answer={answer && "logo" in answer ? answer : undefined}
          onAnswer={set}
          palettes={palettes}
          setSubmit={setLogoSubmit}
          start={start?.logo}
        />
      ) : null}
      {question.visual === "photos" ? (
        <TrayPhotos
          {...page}
          answer={answer && "photos" in answer ? answer : undefined}
          onAnswer={set}
          onNext={(given) => {
            set(given)
            onward(given)
          }}
        />
      ) : null}
      {!ownPage && question.card.options.length > 0 ? (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: group and radiogroup both take a label; the rule cannot read a role chosen at runtime
        <div
          aria-label={question.question ?? "Choose one"}
          className={cn(
            "grid grid-cols-1 gap-3",
            // A pair's business name is long, so they stay one to a row until
            // two fit side by side. Up to three layouts sit in one row, so
            // all of them show at once on a phone.
            question.visual === "font_pair"
              ? "@md:grid-cols-2"
              : question.visual === "layout" && shown.length === 3
                ? "grid-cols-3 gap-2"
                : "min-[380px]:grid-cols-2"
          )}
          key={question.id}
          role={multiple ? "group" : "radiogroup"}
        >
          {shown.map((option) => {
            const checked = multiple
              ? ticks.includes(option.id)
              : answer !== undefined &&
                "choice" in answer &&
                answer.choice === option.id
            const look = layoutLook(option)
            // A palette is its colours alone: the name is for screen readers.
            const swatch = option.visual?.kind === "swatches"
            return (
              <label
                className={cn(
                  TRAY_TILE,
                  look && "p-2",
                  swatch &&
                    "gap-0 overflow-hidden p-0 has-[:checked]:ring-2 has-[:checked]:ring-foreground"
                )}
                key={option.id}
              >
                <input
                  checked={checked}
                  className="sr-only"
                  name={`${id}-${question.id}`}
                  onChange={() =>
                    multiple ? toggle(option.id) : pick(option.id)
                  }
                  type={multiple ? "checkbox" : "radio"}
                  value={option.id}
                />
                <Picture name={name} option={option} stops={stops} />
                <span
                  className={cn(
                    "flex items-center gap-1.5 font-medium text-sm",
                    look && "text-xs"
                  )}
                >
                  {question.visual === "font_pair" || swatch ? (
                    <span className="sr-only">{option.label}</span>
                  ) : (
                    (look?.hero ?? option.label)
                  )}
                  {/* A box, ticked or not, so a card of many reads apart from a card of one. */}
                  {multiple ? (
                    checked ? (
                      <CheckSquareIcon
                        aria-hidden
                        className="ml-auto size-5 shrink-0"
                        weight="fill"
                      />
                    ) : (
                      <SquareIcon
                        aria-hidden
                        className="ml-auto size-5 shrink-0 text-muted-foreground"
                      />
                    )
                  ) : null}
                </span>
                {!(look || swatch) && option.hint ? (
                  <span className="text-muted-foreground text-xs">
                    {option.hint}
                  </span>
                ) : null}
              </label>
            )
          })}
        </div>
      ) : null}
      {question.visual === "palette" ? (
        <>
          <Button
            className={cn("self-start", ACCENT_RING)}
            onClick={surprise}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ShuffleIcon aria-hidden />
            Surprise me
          </Button>
          <PalettePicture
            checked={answer !== undefined && "palette" in answer}
            group={`${id}-${question.id}`}
            onPick={(palette) => set({ palette })}
            read={picture}
            reading={start?.reading}
            setRead={setPicture}
          />
        </>
      ) : null}
      {other && !ownPage ? (
        <Input
          aria-label={other.label}
          // shrink-0, or the scrolling body squeezes it below its height.
          className={cn("shrink-0", TRAY_FIELD)}
          autoComplete="off"
          maxLength={200}
          onChange={(event) => write(event.currentTarget.value)}
          placeholder={other.placeholder}
          value={own}
        />
      ) : null}
    </TrayFrame>
  )
}

export type {
  Offered as OfferedPalette,
  Start as QuestionTrayStart,
  Stops,
  TrayFrameProps,
}
export {
  ACCENT_RING,
  Docked,
  DropTile,
  QuestionTray,
  Swatches,
  sentence,
  TRAY_FIELD,
  TRAY_TILE,
  TrayFrame,
  TrayNote,
  useTabDraft,
}
