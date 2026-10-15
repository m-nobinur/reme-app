import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckSquareIcon,
  SquareIcon,
} from "@phosphor-icons/react"
import {
  type AskDesignInput,
  type AskDesignOutput,
  FONT_PAIRS,
  PALETTES,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useFocusComposer } from "@workspace/ui/hooks/use-composer-input"
import { OPTION, OPTION_TILE } from "@workspace/ui/lib/card"
import {
  faceStack as face,
  faceCss,
  previewFaces,
} from "@workspace/ui/lib/font-faces"
import { cn } from "@workspace/ui/lib/utils"
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react"

/**
 * The design questions of a build as one tray, a card of its own docked above
 * the composer at its width and radius, with a gap between the two. One
 * question shows at a time: the options as a native radio
 * group, or checkboxes on a card that takes several (arrow keys or Tab,
 * Space and the screen reader come with them), Write your
 * own, back and forward, Skip all and Next, which reads Build my site on the
 * last question. Collapsed it is one row, the question and "2 of 4". The
 * tray holds its own state and never touches the composer, so a message
 * typed while it is open is an ordinary turn and the tray stays where it
 * was. On a phone it is still in the flow above the composer, so the
 * composer stays reachable. Answers are code's:
 * `onAnswer` gets each one as the owner leaves its question, `onFinish` the
 * `AskDesignOutput` on Build my site or Skip all.
 */

/**
 * The tray's focus ring is the accent, as the site and the buttons around it
 * draw theirs, not the neutral grey of the shared token. Each control that
 * can take focus in the tray carries it.
 */
const ACCENT_RING = "focus-visible:border-primary focus-visible:ring-primary"

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
}: Layout & { stops: Stops }) {
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
      className="mx-auto h-24 w-auto rounded-xl ring-1 ring-foreground/15"
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

/**
 * The colours the sketches are drawn in: the palette the owner picked, else
 * the first one offered, else the first palette there is.
 */
function siteStops(
  questions: Question[],
  answers: Record<string, Answer>
): Stops {
  const asked = questions.find((each) => each.visual === "palette")
  const swatches = (option?: Option) =>
    option?.visual?.kind === "swatches" && option.visual.colors.length === 4
      ? (option.visual.colors as unknown as Stops)
      : undefined
  const picked = asked && answers[asked.id]
  const chosen =
    picked && "choice" in picked
      ? asked?.card.options.find((each) => each.id === picked.choice)
      : undefined
  return (
    swatches(chosen) ??
    swatches(asked?.card.options[0]) ??
    (PALETTES[0]?.swatches as unknown as Stops)
  )
}

/** What an option shows above its label, from the question's visual and the option's own data. */
function Picture({ option, stops }: { option: Option; stops: Stops }) {
  const { visual } = option
  if (visual?.kind === "swatches") {
    return (
      // The strip renders the palette's own colours, data from the call.
      <span
        aria-hidden
        className="flex h-9 w-full overflow-hidden rounded-xl ring-1 ring-foreground/15"
      >
        {visual.colors.map((color) => (
          <span
            className="h-full flex-1"
            key={color}
            style={{ backgroundColor: color }}
          />
        ))}
      </span>
    )
  }
  if (visual?.kind === "font_pair") {
    const { display, body } = visual
    return (
      <span aria-hidden className="flex w-full flex-col gap-0.5">
        <span
          className="wrap-break-word text-lg leading-tight"
          style={{
            fontFamily: face(display),
            fontWeight: displayWeight(display),
          }}
        >
          Title · {display}
        </span>
        <span
          className="wrap-break-word text-muted-foreground text-sm"
          style={{ fontFamily: face(body) }}
        >
          Body · {body}
        </span>
      </span>
    )
  }
  if (visual?.kind === "layout") {
    return (
      <LayoutSketch
        hero={visual.hero}
        services={visual.services}
        stops={stops}
      />
    )
  }
  return null
}

/** Where a tray starts, when it does not start fresh. The catalog draws every state with it. */
type Start = {
  index?: number
  collapsed?: boolean
  answers?: Record<string, Answer>
}

type QuestionTrayProps = {
  input: AskDesignInput
  /** An answer, as the owner leaves its question. Store it; a reload resumes after it. */
  onAnswer?: (id: string, answer: Answer) => void
  /** Build my site or Skip all. */
  onFinish: (output: AskDesignOutput) => void
  start?: Start
  className?: string
}

function QuestionTray({
  input,
  onAnswer,
  onFinish,
  start,
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
  const [more, setMore] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const settled = useRef<boolean>(false)
  const focusComposer = useFocusComposer()

  // A new question takes the keyboard when it was in the tray, so Tab and the
  // arrow keys carry on in the options; focus in the composer is left alone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of question moves focus
  useEffect(() => {
    if (!settled.current) {
      settled.current = true
      return
    }
    if (rootRef.current?.contains(document.activeElement)) {
      bodyRef.current
        ?.querySelector<HTMLInputElement>("input:checked, input")
        ?.focus()
    }
  }, [index])

  // Whether the body hides options below its fold, so a fade can say so.
  const measure = () => {
    const body = bodyRef.current
    if (body)
      setMore(body.scrollHeight - body.scrollTop - body.clientHeight > 4)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the question or its state changes
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(body)
    return () => watch.disconnect()
  }, [index, collapsed])

  const question = questions[index]
  if (!question) return null
  const stops = siteStops(questions, answers)
  const total = questions.length
  const last = index === total - 1
  const answer = answers[question.id]
  const skippable = question.card.skippable
  const ready = answer !== undefined || skippable
  const prompt = question.question ?? "Choose one"
  const other = question.card.other

  /** Hands the current answer on, and returns the answers with it. */
  const settle = (skipping: boolean) => {
    const given = answer ?? (skipping && skippable ? { skipped: true } : null)
    if (!given) return answers
    const now = { ...answers, [question.id]: given } as typeof answers
    onAnswer?.(question.id, given as Answer)
    setAnswers(now)
    return now
  }
  const go = (to: number, skipping: boolean) => {
    settle(skipping)
    setIndex(to)
  }
  const finish = (skipAll: boolean) => {
    onFinish({ answers: settle(!skipAll), skip_all: skipAll })
    focusComposer()
  }
  const next = () => {
    if (!ready) return
    if (last) finish(false)
    else go(index + 1, true)
  }
  const collapse = () => {
    setCollapsed(true)
    focusComposer()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !collapsed) {
      event.preventDefault()
      collapse()
    } else if (
      event.key === "Enter" &&
      !collapsed &&
      event.target instanceof HTMLInputElement
    ) {
      event.preventDefault()
      next()
    }
  }

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
    setAnswers((now) => {
      const { [question.id]: _, ...rest } = now
      return words.trim() ? { ...now, [question.id]: { own: words } } : rest
    })

  return (
    <section
      aria-label="Design questions"
      className={cn(
        "@container flex max-h-[min(36rem,max(15rem,45dvh))] w-full flex-col rounded-[var(--composer-radius,var(--radius-4xl))] border border-border bg-card text-card-foreground",
        className
      )}
      data-slot="question-tray"
      onKeyDown={onKeyDown}
      ref={rootRef}
    >
      <p aria-live="polite" className="sr-only">
        {`Question ${index + 1} of ${total}`}
      </p>
      {collapsed ? (
        <button
          aria-expanded={false}
          className="flex w-full items-center gap-3 rounded-[var(--composer-radius,var(--radius-4xl))] px-5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-primary"
          onClick={() => setCollapsed(false)}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate font-medium text-base">
            {prompt}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {index + 1} of {total}
          </span>
          <CaretUpIcon aria-hidden className="size-4 shrink-0" />
        </button>
      ) : (
        <>
          <div className="flex items-center gap-2 border-border border-b py-3 pr-4 pl-5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="font-medium text-base" id={`${id}-question`}>
                {prompt}
              </h2>
              {multiple ? (
                <p className="text-muted-foreground text-xs" id={`${id}-hint`}>
                  Pick any that fit
                </p>
              ) : null}
            </div>
            <span
              aria-hidden
              className="shrink-0 text-muted-foreground text-xs tabular-nums"
            >
              {index + 1} of {total}
            </span>
            <Button
              aria-controls={`${id}-body`}
              aria-expanded
              aria-label="Collapse questions"
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
            <div
              className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-b-3xl bg-(--body) p-3"
              id={`${id}-body`}
              onScroll={measure}
              ref={bodyRef}
            >
              {question.visual === "font_pair" && <PreviewFaces />}
              {question.card.options.length > 0 ? (
                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: group and radiogroup both take a label; the rule cannot read a role chosen at runtime
                <div
                  aria-describedby={multiple ? `${id}-hint` : undefined}
                  aria-labelledby={`${id}-question`}
                  className={cn(
                    "grid grid-cols-1 gap-3",
                    // A pair's names are long, so they stay one to a row until
                    // two fit side by side.
                    question.visual === "font_pair"
                      ? "@md:grid-cols-2"
                      : "min-[380px]:grid-cols-2"
                  )}
                  key={question.id}
                  role={multiple ? "group" : "radiogroup"}
                >
                  {question.card.options.map((option) => {
                    const checked = multiple
                      ? ticks.includes(option.id)
                      : answer !== undefined &&
                        "choice" in answer &&
                        answer.choice === option.id
                    return (
                      <label
                        className={cn(
                          OPTION,
                          OPTION_TILE,
                          "rounded-xl has-[:focus-visible]:border-primary has-[:focus-visible]:ring-primary",
                          // Picked is a 2px line in the text colour: a border
                          // and an inset ring of one pixel each.
                          "has-[:checked]:inset-ring-1 has-[:checked]:inset-ring-foreground has-[:checked]:border-foreground has-[:checked]:bg-card"
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
                        <Picture option={option} stops={stops} />
                        <span className="flex items-center gap-1.5 font-medium text-sm">
                          {question.visual === "font_pair" ? (
                            <span className="sr-only">{option.label}</span>
                          ) : (
                            option.label
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
                        {option.hint ? (
                          <span className="text-muted-foreground text-xs">
                            {option.hint}
                          </span>
                        ) : null}
                      </label>
                    )
                  })}
                </div>
              ) : null}
              {other ? (
                <Input
                  aria-label={other.label}
                  className={cn(
                    "h-12 rounded-xl border-border bg-card px-3.5 md:text-sm",
                    ACCENT_RING
                  )}
                  autoComplete="off"
                  maxLength={200}
                  onChange={(event) => write(event.currentTarget.value)}
                  placeholder={other.placeholder}
                  value={own}
                />
              ) : null}
            </div>
            {more ? (
              // A fade, not a decoration: it says there are more options below.
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-3xl bg-linear-to-t from-(--body) to-transparent"
              />
            ) : null}
          </div>
          <div className="flex items-center gap-1 p-4">
            <Button
              aria-label="Previous question"
              className={ACCENT_RING}
              disabled={index === 0}
              onClick={() => go(index - 1, false)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <CaretLeftIcon aria-hidden />
            </Button>
            <Button
              aria-label="Next question"
              className={ACCENT_RING}
              disabled={last || !ready}
              onClick={() => go(index + 1, true)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <CaretRightIcon aria-hidden />
            </Button>
            <span className="flex-1" />
            <Button
              className={ACCENT_RING}
              onClick={() => finish(true)}
              size="default"
              type="button"
              variant="ghost"
            >
              Skip all
            </Button>
            {/* Filled with the accent, so its ring stands off the fill. */}
            <Button
              className={cn(
                ACCENT_RING,
                "px-5 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              )}
              disabled={!ready}
              onClick={next}
              size="default"
              type="button"
            >
              {last ? "Build my site" : "Next"}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

export type { Start as QuestionTrayStart }
export { QuestionTray }
