import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckCircleIcon,
} from "@phosphor-icons/react"
import {
  type AskDesignInput,
  type AskDesignOutput,
  FONT_PAIRS,
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
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/**
 * The design questions of a build as one tray, docked above the composer at
 * its width. One question shows at a time: the options as a native radio
 * group (arrow keys, Space and the screen reader come with it), Write your
 * own, back and forward, Skip all and Next, which reads Build my site on the
 * last question. Collapsed it is one row, the question and "2 of 4". The
 * tray holds its own state and never touches the composer, so a message
 * typed while it is open is an ordinary turn and the tray stays where it
 * was. On a phone it is a full-width sheet with a handle, still in the flow
 * above the composer so the composer stays reachable. Answers are code's:
 * `onAnswer` gets each one as the owner leaves its question, `onFinish` the
 * `AskDesignOutput` on Build my site or Skip all.
 */

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

function Box({
  className,
  ...rect
}: { className: string } & ComponentProps<"rect">) {
  return <rect className={className} rx="1.5" {...rect} />
}

/**
 * A wireframe of a hero and the services under it, in theme tokens, so two
 * directions that differ in those two variants differ at a glance.
 * A variant the sketch does not know draws the first of each.
 */
function LayoutSketch({ hero, services }: Layout) {
  const ink = "fill-foreground/75"
  const block = "fill-muted-foreground/25"
  const tint = "fill-primary/15"
  return (
    <svg
      aria-hidden
      className="h-auto w-full rounded-xl border border-border bg-background"
      data-hero={hero}
      data-services={services}
      viewBox="0 0 120 84"
    >
      <Box className={ink} height="3" width="14" x="6" y="4" />
      <Box className={block} height="2" width="26" x="70" y="4.5" />
      {hero === "dark_center" ? (
        <>
          <rect className="fill-foreground" height="38" width="120" y="11" />
          <Box
            className="fill-background"
            height="5"
            width="56"
            x="32"
            y="21"
          />
          <Box
            className="fill-background/50"
            height="2"
            width="40"
            x="40"
            y="30"
          />
          <Box className="fill-primary" height="5" width="16" x="52" y="37" />
        </>
      ) : hero === "wash" ? (
        <>
          <rect className="fill-primary/25" height="38" width="120" y="11" />
          <Box className={ink} height="5" width="44" x="8" y="21" />
          <Box className={ink} height="5" width="32" x="8" y="28" />
          <Box className="fill-primary" height="5" width="14" x="8" y="37" />
          <Box
            className="fill-background/70"
            height="4"
            rx="2"
            width="22"
            x="90"
            y="42"
          />
        </>
      ) : hero === "split_frame" ? (
        <>
          <Box className={ink} height="5" width="40" x="8" y="19" />
          <Box className={ink} height="5" width="30" x="8" y="26" />
          <Box className={block} height="2" width="34" x="8" y="34" />
          <Box className="fill-primary" height="5" width="14" x="8" y="40" />
          <rect
            className="fill-card stroke-border"
            height="34"
            rx="1.5"
            width="46"
            x="66"
            y="13"
          />
          <Box className={tint} height="28" width="40" x="69" y="16" />
          <Box
            className="fill-card stroke-border"
            height="10"
            width="20"
            x="58"
            y="38"
          />
        </>
      ) : hero === "text_led" ? (
        <>
          <Box className={ink} height="7" width="70" x="8" y="17" />
          <Box className={ink} height="7" width="56" x="8" y="27" />
          <Box className={block} height="2" width="44" x="8" y="38" />
          <Box className="fill-primary" height="5" width="14" x="8" y="43" />
          <Box className={tint} height="18" width="18" x="94" y="26" />
        </>
      ) : (
        <>
          <Box className={ink} height="5" width="40" x="8" y="19" />
          <Box className={ink} height="5" width="30" x="8" y="26" />
          <Box className={block} height="2" width="34" x="8" y="34" />
          <Box className="fill-primary" height="5" width="14" x="8" y="40" />
          <path
            className="fill-primary/25"
            d="M70 48 V30 a18 18 0 0 1 36 0 V48 Z"
          />
        </>
      )}
      {services === "numbered_rows"
        ? [54, 64, 74].map((y) => (
            <g key={y}>
              <circle className={tint} cx="12" cy={y + 3} r="3.5" />
              <Box className={ink} height="2.5" width="36" x="22" y={y + 1} />
              <Box className={block} height="2" width="60" x="22" y={y + 5} />
              <line
                className="stroke-border"
                x1="6"
                x2="114"
                y1={y + 9}
                y2={y + 9}
              />
            </g>
          ))
        : services === "alternating"
          ? [53, 68].map((y, row) => (
              <g key={y}>
                <Box
                  className={tint}
                  height="12"
                  width="34"
                  x={row ? 80 : 6}
                  y={y}
                />
                <Box
                  className={ink}
                  height="2.5"
                  width="40"
                  x={row ? 8 : 46}
                  y={y + 2}
                />
                <Box
                  className={block}
                  height="2"
                  width="52"
                  x={row ? 8 : 46}
                  y={y + 7}
                />
              </g>
            ))
          : services === "fleet"
            ? [6, 62].map((x) => (
                <g key={x}>
                  <Box className={tint} height="16" width="52" x={x} y="54" />
                  <Box
                    className={block}
                    height="3"
                    rx="1.5"
                    width="12"
                    x={x}
                    y="73"
                  />
                  <Box
                    className={block}
                    height="3"
                    rx="1.5"
                    width="12"
                    x={x + 15}
                    y="73"
                  />
                </g>
              ))
            : services === "practice_list"
              ? [54, 63, 72].map((y, row) => (
                  <g key={y}>
                    <Box
                      className={ink}
                      height="2.5"
                      width="6"
                      x="6"
                      y={y + 1}
                    />
                    <Box
                      className={ink}
                      height="2.5"
                      width={30 + row * 4}
                      x="18"
                      y={y + 1}
                    />
                    <Box
                      className={block}
                      height="2"
                      width="70"
                      x="18"
                      y={y + 5}
                    />
                  </g>
                ))
              : [6, 44, 82].map((x) => (
                  <g key={x}>
                    <Box className={tint} height="14" width="32" x={x} y="53" />
                    <Box className={ink} height="2.5" width="22" x={x} y="70" />
                    <Box className={block} height="2" width="30" x={x} y="75" />
                  </g>
                ))}
    </svg>
  )
}

/** What an option shows above its label, from the question's visual and the option's own data. */
function Picture({ option }: { option: Option }) {
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
          className="truncate text-lg leading-tight"
          style={{
            fontFamily: face(display),
            fontWeight: displayWeight(display),
          }}
        >
          Title · {display}
        </span>
        <span
          className="truncate text-muted-foreground text-sm"
          style={{ fontFamily: face(body) }}
        >
          Body · {body}
        </span>
      </span>
    )
  }
  if (visual?.kind === "layout") {
    return <LayoutSketch hero={visual.hero} services={visual.services} />
  }
  return null
}

/** The tray's heading row, whichever way it is open. */
function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 px-4 py-3">{children}</div>
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
      return first ? [[each.id, { choice: first }]] : []
    })
  )
  const [answers, setAnswers] = useState(start?.answers ?? ticked)
  const firstOpen = questions.findIndex((each) => !(each.id in answers))
  const [index, setIndex] = useState(
    start?.index ?? (firstOpen < 0 ? questions.length - 1 : firstOpen)
  )
  const [collapsed, setCollapsed] = useState(start?.collapsed ?? false)
  const rootRef = useRef<HTMLElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
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
      groupRef.current
        ?.querySelector<HTMLInputElement>("input:checked, input")
        ?.focus()
    }
  }, [index])

  const question = questions[index]
  if (!question) return null
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
  const pick = (value: string) =>
    setAnswers((now) => ({ ...now, [question.id]: { choice: value } }))
  const write = (words: string) =>
    setAnswers((now) => {
      const { [question.id]: _, ...rest } = now
      return words.trim() ? { ...now, [question.id]: { own: words } } : rest
    })

  return (
    <section
      aria-label="Design questions"
      className={cn(
        "flex max-h-[min(36rem,72dvh)] w-full flex-col rounded-t-3xl border border-border border-b-0 bg-card text-card-foreground",
        className
      )}
      data-slot="question-tray"
      onKeyDown={onKeyDown}
      ref={rootRef}
    >
      <p aria-live="polite" className="sr-only">
        {`Question ${index + 1} of ${total}`}
      </p>
      <span
        aria-hidden
        className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border sm:hidden"
      />
      {collapsed ? (
        <button
          aria-expanded={false}
          className="flex w-full items-center gap-3 rounded-t-3xl px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring"
          onClick={() => setCollapsed(false)}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate font-medium text-sm">
            {prompt}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {index + 1} of {total}
          </span>
          <CaretUpIcon aria-hidden className="size-4 shrink-0" />
        </button>
      ) : (
        <>
          <Row>
            <h2
              className="min-w-0 flex-1 font-medium text-sm"
              id={`${id}-question`}
            >
              {prompt}
            </h2>
            <span
              aria-hidden
              className="shrink-0 text-muted-foreground text-xs"
            >
              {index + 1} of {total}
            </span>
            <Button
              aria-controls={`${id}-body`}
              aria-expanded
              aria-label="Collapse questions"
              onClick={collapse}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <CaretDownIcon aria-hidden />
            </Button>
          </Row>
          <div
            className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-3"
            id={`${id}-body`}
          >
            {question.visual === "font_pair" && <PreviewFaces />}
            <div
              aria-labelledby={`${id}-question`}
              className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2"
              key={question.id}
              ref={groupRef}
              role="radiogroup"
            >
              {question.card.options.map((option) => {
                const checked =
                  answer !== undefined &&
                  "choice" in answer &&
                  answer.choice === option.id
                return (
                  <label
                    className={cn(
                      OPTION,
                      OPTION_TILE,
                      "has-[:checked]:inset-ring-1 has-[:checked]:inset-ring-primary"
                    )}
                    key={option.id}
                  >
                    <input
                      checked={checked}
                      className="sr-only"
                      name={`${id}-${question.id}`}
                      onChange={() => pick(option.id)}
                      type="radio"
                      value={option.id}
                    />
                    <Picture option={option} />
                    <span className="flex items-center gap-1.5 font-medium text-sm">
                      {question.visual === "font_pair" ? (
                        <span className="sr-only">{option.label}</span>
                      ) : (
                        option.label
                      )}
                      {checked ? (
                        <CheckCircleIcon
                          aria-hidden
                          className="ml-auto size-4 shrink-0 text-primary"
                          weight="fill"
                        />
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
            {other ? (
              <Input
                aria-label={other.label}
                autoComplete="off"
                maxLength={200}
                onChange={(event) => write(event.currentTarget.value)}
                placeholder={other.placeholder}
                value={own}
              />
            ) : null}
          </div>
          <div className="flex items-center gap-1 border-border border-t px-3 py-2">
            <Button
              aria-label="Previous question"
              disabled={index === 0}
              onClick={() => go(index - 1, false)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <CaretLeftIcon aria-hidden />
            </Button>
            <Button
              aria-label="Next question"
              disabled={last || !ready}
              onClick={() => go(index + 1, true)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <CaretRightIcon aria-hidden />
            </Button>
            <span className="flex-1" />
            <Button
              onClick={() => finish(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Skip all
            </Button>
            <Button disabled={!ready} onClick={next} size="sm" type="button">
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
