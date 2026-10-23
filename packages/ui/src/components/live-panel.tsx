import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  ClockIcon,
  GlobeIcon,
  ImageIcon,
  MinusCircleIcon,
  PencilSimpleIcon,
  RocketLaunchIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import {
  type ApprovalTarget,
  type AssignmentState,
  type AvatarId,
  type Blueprint,
  type BuildActivity,
  type BuildPhoto,
  type DecisionRequest,
  GOAL_MAX,
} from "@workspace/contracts"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Field } from "@workspace/ui/components/field"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { StatusIcon } from "@workspace/ui/components/status-line"
import { useCycle } from "@workspace/ui/hooks/use-cycle"
import { SKIPPED, type StatusKind } from "@workspace/ui/lib/activity-copy"
import {
  type AnswerSpec,
  answerValue,
  FACT_INPUTS,
  type FactInput,
} from "@workspace/ui/lib/answer"
import {
  directionLabel,
  pairOfBlueprint,
  paletteName,
  paletteStops,
} from "@workspace/ui/lib/blueprint"
import { formatDateTime } from "@workspace/ui/lib/format"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  Children,
  type FormEvent,
  isValidElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

/**
 * The workspace panel: what is being built, what waits on the owner, what
 * is coming up and where the site stands. Every section is a list separated
 * by space and hairlines, not a stack of cards. The components take facts
 * and callbacks; the app owns the reads and writes, so this package still
 * imports no router and no client.
 */

function PanelSection({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 className="flex items-baseline gap-2 font-semibold text-sm" id={id}>
        {title}
        {count ? (
          <span className="font-normal text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  )
}

/** A link that opens outside the app, and says so to a screen reader. */
const expiryLine = (expiresAt: string | null, onExpiry: string) => {
  const expires = formatDateTime(expiresAt)
  return expires ? `Open until ${expires}. ${onExpiry}` : onExpiry
}

/* Segments ----------------------------------------------------------- */

const STEPS = ["Queued", "Building", "Checking", "Ready"] as const

/**
 * Where each build state sits among the four steps a build's state is
 * named by. Every state has a row, so a state added to the contract fails
 * the build until it is placed.
 */
const BUILD_STAGES = {
  queued: 0,
  briefing: 1,
  planning: 1,
  implementing: 1,
  revising: 1,
  repairing: 1,
  blocked_on_information: 1,
  paused: 1,
  validating: 2,
  preview_ready: 3,
  awaiting_review: 3,
  blocked_on_approval: 3,
  release_candidate: 3,
  published: 3,
  failed: 1,
  cancelled: 0,
} satisfies Record<AssignmentState, 0 | 1 | 2 | 3>

/** A build state in one or two words: its step, or why it waits. */
function stageWord(state: AssignmentState): string {
  if (state === "blocked_on_information" || state === "blocked_on_approval") {
    return "Waiting on you"
  }
  if (state === "paused") return "Paused"
  return STEPS[BUILD_STAGES[state]]
}

/** The states a Stop still means something in. */
const STOPPABLE = (state: AssignmentState) =>
  BUILD_STAGES[state] < 3 && state !== "failed" && state !== "cancelled"

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/**
 * What the plan settled, as it lands: the look, the site's own colours, its
 * lettering and how much there is to write. Fixed labels around the plan's
 * ids, never the planner's prose.
 */
function Decided({ plan }: { plan: Blueprint }) {
  const pair = pairOfBlueprint(plan.fonts)
  const sections = plan.pages.reduce((n, p) => n + p.sections.length, 0)
  return (
    <dl
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[0.8125rem]"
      data-slot="build-decided"
    >
      <dt className="text-muted-foreground">Look</dt>
      <dd className="truncate">{directionLabel(plan.direction)}</dd>
      <dt className="text-muted-foreground">Colours</dt>
      <dd className="flex min-w-0 items-center gap-2">
        {/* The site's own colours, whatever the app's theme, with a hairline so a white stop shows. */}
        <span
          aria-hidden
          className="flex h-4 w-16 shrink-0 overflow-hidden rounded-sm ring-1 ring-foreground/15"
        >
          {paletteStops(plan.palette).map((color) => (
            <span
              className="h-full flex-1"
              key={color}
              style={{ backgroundColor: color }}
            />
          ))}
        </span>
        <span className="truncate">{paletteName(plan.palette)}</span>
      </dd>
      <dt className="text-muted-foreground">Lettering</dt>
      <dd className="truncate">
        {pair.display} and {pair.body}
      </dd>
      <dt className="text-muted-foreground">Pages</dt>
      <dd className="truncate">
        {plural(plan.pages.length, "page")}, {plural(sections, "section")}
      </dd>
    </dl>
  )
}

/**
 * A ref callback for an image the browser may have finished before React
 * attached `onLoad`, as a cached one does after a hard reload.
 */
const loadedWhenCached =
  (setLoaded: (loaded: boolean) => void) => (img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setLoaded(true)
  }

/**
 * One generated photo as the build makes it: a quiet shimmer while it is
 * drawn, the picture once it exists, and a plain note when no model drew it. A picture that does not load is a quiet tile, never a broken image.
 */
function PhotoTile({ photo }: { photo: BuildPhoto }) {
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState(false)
  const tile =
    "relative aspect-[4/3] overflow-hidden rounded-lg border border-border"
  if (photo.state === "drawing") {
    return (
      <div className={tile} data-state="drawing">
        <Skeleton className="size-full rounded-none motion-reduce:animate-none" />
        <span className="sr-only">Still drawing</span>
      </div>
    )
  }
  if (photo.state === "fallback") {
    return (
      <div
        className={cn(
          tile,
          "flex items-end border-dashed p-1.5 text-[0.6875rem] text-muted-foreground leading-tight"
        )}
        data-state="fallback"
      >
        No photo, using a text layout
      </div>
    )
  }
  return (
    <div className={cn(tile, "bg-muted")} data-state="made">
      {photo.thumbnail && !broken ? (
        <img
          alt={photo.alt ?? ""}
          className={cn(
            "size-full object-cover transition-opacity duration-200 motion-reduce:transition-none",
            loaded ? "opacity-100" : "opacity-0"
          )}
          decoding="async"
          height={72}
          onError={() => setBroken(true)}
          onLoad={() => setLoaded(true)}
          ref={loadedWhenCached(setLoaded)}
          src={photo.thumbnail}
          width={96}
        />
      ) : (
        <ImageIcon
          aria-hidden
          className="absolute top-1.5 left-1.5 size-4 text-muted-foreground"
        />
      )}
    </div>
  )
}

/** The detail under a step: what it decided, made or is checking. */
function StepDetail({
  row,
  at,
  plan,
  photos,
}: {
  row: BuildActivity
  at: "done" | "now" | "next"
  plan?: Blueprint | undefined
  photos?: readonly BuildPhoto[] | undefined
}) {
  switch (row.id) {
    case "planning":
      return (
        <>
          {at === "now" ? (
            <p className={META}>Choosing a look, colours and pages.</p>
          ) : null}
          {plan ? <Decided plan={plan} /> : null}
        </>
      )
    case "photos": {
      if (at === "next" || !photos?.length) return null
      const fell = photos.filter((p) => p.state === "fallback").length
      return (
        <>
          <ul aria-label="Photos" className="grid max-w-sm grid-cols-3 gap-2">
            {photos.map((photo) => (
              <li key={photo.slot_id}>
                <PhotoTile photo={photo} />
              </li>
            ))}
          </ul>
          {fell ? (
            <p className={META}>
              {fell === 1
                ? "One section uses its text layout instead."
                : `${fell} sections use their text layout instead.`}
            </p>
          ) : null}
        </>
      )
    }
    case "writing":
      return row.items?.length ? (
        <ul aria-label="Pages" className="flex flex-wrap gap-1.5">
          {row.items.map((item) => (
            <li
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs",
                item.done
                  ? "border-border text-foreground"
                  : "border-dashed text-muted-foreground"
              )}
              data-state={item.done ? "done" : "next"}
              key={item.label}
            >
              {item.done ? (
                <CheckIcon aria-hidden className="size-3 text-primary" />
              ) : null}
              {item.label}
              {item.done ? <span className="sr-only"> (written)</span> : null}
            </li>
          ))}
        </ul>
      ) : null
    case "design":
      return at === "now" ? (
        <p className={META}>
          Reading the home page at phone, tablet and desktop widths.
        </p>
      ) : null
    case "polishing":
      return at === "now" ? (
        <p className={META}>Making the changes the design review asked for.</p>
      ) : null
    case "fixing":
      return at === "now" ? (
        <p className={META}>
          Putting right what the checks flagged, then checking again.
        </p>
      ) : null
    case "checking":
      return at === "now" ? (
        <p className={META}>Links, facts, accessibility and page weight.</p>
      ) : null
    default:
      return null
  }
}

/**
 * What a website stage decided or made, under its step: the plan, the
 * photos, the pages. Nothing for a stage not reached yet.
 */
function StageDetail({
  stage,
  state,
  activity,
  plan,
  photos,
}: {
  stage: string
  state: SegmentStep["state"]
  activity: readonly BuildActivity[]
  plan?: Blueprint | undefined
  photos?: readonly BuildPhoto[] | undefined
}) {
  // A website step is named by its build activity row.
  const row = activity.find((each) => each.id === stage)
  if (!row || state === "next" || state === "skipped") return null
  return (
    <StepDetail
      at={state === "done" ? "done" : "now"}
      photos={photos}
      plan={plan}
      row={row}
    />
  )
}

/** One step of a segment, as the panel draws it. */
type SegmentStep = {
  id: string
  label: string
  /** The label without its count: what a screen reader hears when this step becomes current. */
  said?: string
  state: "done" | "now" | "waiting" | "next" | "skipped"
  /** The icon the step moves while it is at work. */
  kind: StatusKind
  /** What the step decided or made, under its row. */
  detail?: ReactNode
}

/** How long a segment that finished on screen shows every step ticked before it folds. */
const FOLD_PAUSE_MS = 1200

/** Where a step stands, for a screen reader; a skipped step says so on screen. */
const STEP_SAID: Record<SegmentStep["state"], string> = {
  done: " (done)",
  now: " (now)",
  waiting: " (waiting on you)",
  next: " (next)",
  skipped: "",
}

function StepMark({ step, failed }: { step: SegmentStep; failed: boolean }) {
  if (step.state === "done") {
    return <CheckCircleIcon className="size-4 text-primary" weight="fill" />
  }
  if (failed && (step.state === "now" || step.state === "waiting")) {
    return <WarningCircleIcon className="size-4 text-destructive" />
  }
  switch (step.state) {
    // Neutral, so a step reads as part of its segment and the header's
    // brand-coloured icon stays the one that leads.
    case "now":
      return <StatusIcon className="text-foreground/80" kind={step.kind} />
    case "waiting":
      return step.kind === "question" ? (
        <StatusIcon className="text-foreground/80" kind="question" />
      ) : (
        <ChatCircleDotsIcon className="size-4 animate-status-fade text-foreground/80 motion-reduce:animate-none" />
      )
    case "skipped":
      return <MinusCircleIcon className="size-4 text-muted-foreground" />
    default:
      return <CircleIcon className="size-4 text-muted-foreground/60" />
  }
}

/**
 * One piece of work in the panel: a header with its icon, title and one
 * muted line, then its fixed steps, ticked as they finish. A caret folds the
 * steps while it runs. When it finishes on screen every step ticks, it
 * holds a moment, then the header turns to its done title and the steps
 * fold; a done segment is one line that does not open. A failed one keeps
 * its steps and marks the step that stopped. A screen reader hears the step
 * change, never a count ticking.
 */
function PanelSegment({
  icon,
  state,
  title,
  working = title,
  line = null,
  steps,
  children,
}: {
  icon: StatusKind
  state: "upcoming" | "now" | "waiting" | "done" | "failed"
  /** The title for where it stands: the done title once done. */
  title: string
  /** The working title, kept while a segment that just finished shows its steps. */
  working?: string
  line?: string | null
  steps: readonly SegmentStep[]
  /** What the owner can do in the segment: a review's buttons, Stop. */
  children?: ReactNode
}) {
  const id = useId()
  const done = state === "done"
  const failed = state === "failed"
  const [folded, setFolded] = useState(done)
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (!done) {
      setFolded(false)
      return
    }
    const timer = setTimeout(() => setFolded(true), FOLD_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [done])
  const shown = open && !folded
  const current = steps.find(
    (step) => step.state === "now" || step.state === "waiting"
  )
  // What is behind and what is at work; the steps to come stay out of the
  // list, and a rail fading out below says there are more.
  const shownSteps = steps.filter((step) => step.state !== "next")
  const more = shownSteps.length < steps.length
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="fade-in flex animate-in flex-col duration-200 motion-reduce:animate-none"
      data-slot="panel-segment"
      data-state={folded ? "folded" : state}
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="mt-0.5 flex size-4 shrink-0">
          {folded ? (
            <CheckCircleIcon className="size-4 text-primary" weight="fill" />
          ) : failed ? (
            <WarningCircleIcon className="size-4 text-destructive" />
          ) : (
            // Moving while the segment is under way, a question for the
            // owner included; still once it is upcoming.
            <StatusIcon
              className="text-primary"
              kind={icon}
              still={state !== "now" && state !== "waiting"}
            />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* The segment's title takes the brand sweep while it is under way;
              its steps stay plain text. */}
          <h3
            className={cn(
              "font-medium text-sm",
              (state === "now" || state === "waiting") &&
                "shimmer shimmer-color-foreground motion-reduce:animate-none"
            )}
            id={`${id}-title`}
          >
            {done && !folded ? working : title}
          </h3>
          {line && !done ? <p className={META}>{line}</p> : null}
        </div>
        {done || steps.length === 0 ? null : (
          <button
            aria-controls={`${id}-steps`}
            aria-expanded={open}
            aria-label={open ? "Hide the steps" : "Show the steps"}
            className="-m-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
            onClick={() => setOpen((was) => !was)}
            type="button"
          >
            <CaretDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                !open && "-rotate-90"
              )}
            />
          </button>
        )}
      </div>
      {steps.length || children ? (
        // Folds by its row's height, so the motion is the same for any list.
        <div
          aria-hidden={!shown}
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
          id={`${id}-steps`}
          inert={!shown}
        >
          <div className="min-h-0 overflow-hidden">
            {/* Indented under the title, so the steps read as the segment's own. */}
            <div className="flex flex-col gap-3 ps-6.5 pt-3">
              <p aria-live="polite" className="sr-only">
                {current && !done
                  ? `Now: ${current.said ?? current.label}.`
                  : ""}
              </p>
              <ol aria-label="Steps" className="flex flex-col">
                {shownSteps.map((step) => (
                  <li
                    className="group relative flex gap-2.5 pb-3 last:pb-0"
                    data-state={step.state}
                    key={step.id}
                  >
                    {/* The rail between markers, quiet, ticked off as steps finish. */}
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-5 bottom-0.5 left-[7.5px] w-px group-last:hidden",
                        step.state === "done" ? "bg-primary/45" : "bg-border"
                      )}
                    />
                    <span aria-hidden className="mt-px flex size-4 shrink-0">
                      <StepMark failed={failed} step={step} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <p className="flex min-w-0 items-baseline gap-1.5 text-[0.8125rem]">
                        <span
                          className={cn(
                            "min-w-0 truncate",
                            (step.state === "next" ||
                              step.state === "skipped") &&
                              "text-muted-foreground"
                          )}
                        >
                          {step.label}
                          {step.state === "skipped" ? ` · ${SKIPPED}` : null}
                          <span className="sr-only">
                            {STEP_SAID[step.state]}
                          </span>
                        </span>
                      </p>
                      {step.state === "done" || step.state === "skipped"
                        ? null
                        : step.detail}
                    </div>
                  </li>
                ))}
                {more && !Children.toArray(children).length ? (
                  <li aria-hidden className="relative h-5">
                    <span className="absolute inset-y-0 left-[7.5px] w-px bg-linear-to-b from-border to-transparent" />
                  </li>
                ) : null}
              </ol>
              {children}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

/**
 * Stop, for a build that can still be stopped: one press asks, and the
 * question stays on screen, its buttons disabled, while the Stop is in
 * flight. A quick edit that moved to a fuller lane says so once.
 */
function StopBuild({
  state,
  fellThrough = false,
  onStop,
  stopping = false,
  error = null,
  defaultConfirming = false,
}: {
  state: AssignmentState
  fellThrough?: boolean | undefined
  onStop?: (() => void) | undefined
  stopping?: boolean
  error?: string | null
  /** Open on the Stop question, for the catalog. */
  defaultConfirming?: boolean
}) {
  const [asked, setAsked] = useState(defaultConfirming)
  const confirming = asked || stopping
  const keep = useRef<HTMLButtonElement>(null)
  const stop = useRef<HTMLButtonElement>(null)
  // Focus follows the owner's press: to "Keep building" when Stop asks, and
  // back to Stop when they keep building. Never on a render nobody caused.
  const moveFocus = useRef<"keep" | "stop" | null>(null)
  useEffect(() => {
    if (asked && moveFocus.current === "keep") keep.current?.focus()
    if (!asked && moveFocus.current === "stop") stop.current?.focus()
    moveFocus.current = null
  }, [asked])

  return (
    <div className="flex flex-col gap-2" data-slot="stop-build">
      {fellThrough ? (
        <p className="text-sm" data-slot="fell-through">
          This change needs more than a quick edit, so it will take a few
          minutes.
        </p>
      ) : null}
      {onStop && STOPPABLE(state) ? (
        confirming ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={stopping}
              onClick={onStop}
              size="sm"
              variant="destructive"
            >
              {stopping ? "Stopping" : "Stop this build"}
            </Button>
            <Button
              disabled={stopping}
              onClick={() => {
                moveFocus.current = "stop"
                setAsked(false)
              }}
              ref={keep}
              size="sm"
              variant="ghost"
            >
              Keep building
            </Button>
          </div>
        ) : (
          <Button
            className="self-start"
            onClick={() => {
              moveFocus.current = "keep"
              setAsked(true)
            }}
            ref={stop}
            size="sm"
            variant="outline"
          >
            Stop
          </Button>
        )
      ) : null}
      {error ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/* Waiting on you ------------------------------------------------------ */

/**
 * Questions and approvals, one per list row, answered in place. `status`
 * is the last thing the owner did, announced politely; `error` says the
 * list could not be read and is shown above whatever was read before. With
 * nothing in it and nothing to say, it renders nothing.
 */
function WaitingOnYou({
  children,
  status = null,
  error = null,
  onRetry,
}: {
  children?: ReactNode
  status?: string | null
  error?: string | null
  /** Read the list again now, offered when it did not load. */
  onRetry?: () => Promise<void>
}) {
  const items = Children.toArray(children).filter(isValidElement)
  // Only there when something waits: with nothing, the last thing the owner
  // did stays said, and there is no heading over an empty list.
  if (!items.length && !error) {
    return status ? (
      <p className="text-sm" role="status">
        {status}
      </p>
    ) : null
  }
  return (
    <PanelSection count={items.length} title="Waiting on you">
      <p className="text-sm empty:hidden" role="status">
        {status}
      </p>
      {error ? <p className={META}>{error}</p> : null}
      {items.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((item) => (
            <li key={item.key}>{item}</li>
          ))}
        </ul>
      ) : null}
      {!items.length && error && onRetry ? <Retry onRetry={onRetry} /> : null}
    </PanelSection>
  )
}

/** A change note's text box, for a review and for the live site alike. */
const NOTE =
  "min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-field-focus disabled:opacity-50 md:text-sm"

const pending = (busy: boolean, idle: string, working: string) =>
  busy ? working : idle

function Retry({ onRetry }: { onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      className="self-start"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void onRetry().finally(() => setBusy(false))
      }}
      size="sm"
      variant="outline"
    >
      {pending(busy, "Try again", "Trying again")}
    </Button>
  )
}

/** One native input of a fact, from the `FACT_INPUTS` row. */
function FactField({
  id,
  input,
  invalid,
  min,
  onChange,
  defaultValue,
}: {
  id: string
  input: FactInput
  invalid: boolean
  min?: string
  onChange?: (value: string) => void
  defaultValue?: string
}) {
  return (
    <Field
      aria-invalid={invalid || undefined}
      autoComplete={input.autoComplete}
      className="min-w-0"
      defaultValue={defaultValue}
      id={`${id}-${input.name}`}
      inputMode={input.type === "number" ? "decimal" : undefined}
      label={input.label}
      max={input.max}
      maxLength={input.maxLength}
      min={min ?? input.min}
      name={input.name}
      onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      placeholder={input.placeholder}
      required
      step={input.step}
      type={input.type}
    />
  )
}

/**
 * The inputs that answer one question, named by field so `answerValue` can
 * read them from the form. `prefill` starts a fact's text fields from a value
 * the owner already gave (the business name at signup).
 */
function AnswerInputs({
  id,
  spec,
  title,
  invalid,
  prefill = null,
}: {
  id: string
  spec: AnswerSpec
  title: string
  invalid: boolean
  prefill?: Record<string, unknown> | null
}) {
  // `min` steers the closing time's picker. The form is `noValidate`, so it
  // blocks nothing: `answerValue` refuses a closing time that is not after
  // the opening one, and the error shows in place.
  const [opens, setOpens] = useState<string | undefined>(undefined)

  if (spec.kind === "choice") {
    return (
      <fieldset className="flex flex-col">
        <legend className="sr-only">{title}</legend>
        {spec.options.map((option, index) => (
          <label
            className="flex min-h-9 cursor-pointer items-center gap-2 text-sm"
            // biome-ignore lint/suspicious/noArrayIndexKey: options are a fixed list for the life of the question.
            key={index}
          >
            <input
              aria-invalid={invalid || undefined}
              className="size-4 accent-primary"
              name="answer"
              required
              type="radio"
              value={option}
            />
            {option}
          </label>
        ))}
      </fieldset>
    )
  }
  if (spec.kind === "text") {
    return (
      <Field
        aria-invalid={invalid || undefined}
        autoComplete={spec.email ? "email" : "off"}
        id={`${id}-answer`}
        label="Your answer"
        maxLength={spec.maxLength}
        name="answer"
        required
        type={spec.email ? "email" : "text"}
      />
    )
  }
  const { fields } = FACT_INPUTS[spec.key]
  return (
    <div
      // Opening and closing times sit side by side; every other pair stacks,
      // because the panel is 20rem wide whatever the viewport.
      className={cn(
        "grid gap-2",
        spec.key === "hours.weekday" && "grid-cols-2"
      )}
      data-slot="fact-inputs"
    >
      {fields.map((input: FactInput) => (
        <FactField
          // Text only: a number field shows the owner's units, not the
          // value's (pence), and only the business name is ever prefilled.
          defaultValue={
            typeof prefill?.[input.name] === "string"
              ? (prefill[input.name] as string)
              : undefined
          }
          id={id}
          input={input}
          invalid={invalid}
          key={input.name}
          min={input.name === "close" ? opens : undefined}
          onChange={input.name === "open" ? setOpens : undefined}
        />
      ))}
    </div>
  )
}

/**
 * A question from the team, answered in place with native inputs: `time`,
 * `tel` and `email` where the fact is one, a closed choice where the team
 * offered options, and text held to the question's own limits otherwise.
 * The value is checked the way the orchestrator checks it before it is sent.
 */
function QuestionItem({
  title,
  why,
  askedBy,
  expiresAt,
  onExpiry,
  spec,
  onAnswer,
  pending: busy = false,
  error = null,
}: {
  title: string
  /** The team's reason, shown as the text it is and never as markup. */
  why: string
  askedBy: string
  expiresAt: string | null
  onExpiry: string
  spec: AnswerSpec
  onAnswer: (value: unknown) => void
  pending?: boolean
  error?: string | null
}) {
  const id = useId()
  const [invalid, setInvalid] = useState<string | null>(null)
  const shown = invalid ?? error

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const parsed = answerValue(spec, (name) => String(form.get(name) ?? ""))
    if ("error" in parsed) {
      setInvalid(parsed.error)
      return
    }
    setInvalid(null)
    onAnswer(parsed.value)
  }

  return (
    <article
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2 py-3"
      data-slot="question-item"
    >
      <h3 className="font-medium text-sm" id={`${id}-title`}>
        {title}
      </h3>
      <p className={META}>
        {askedBy} asked: {why}
      </p>
      <form className="flex flex-col gap-2" noValidate onSubmit={submit}>
        <AnswerInputs
          id={id}
          invalid={shown !== null}
          spec={spec}
          title={title}
        />
        {shown ? (
          <p className="text-[0.8125rem] text-destructive" role="alert">
            {shown}
          </p>
        ) : null}
        <Button className="self-start" disabled={busy} size="sm" type="submit">
          {pending(busy, "Send answer", "Sending")}
        </Button>
      </form>
      <p className={META}>{expiryLine(expiresAt, onExpiry)}</p>
    </article>
  )
}

/**
 * The decision an approve button sends: bound to the revision the item
 * shows, or null when the item is not bound to a revision, in which case
 * the button is disabled. There is no other source for the id.
 */
function approvalDecision(
  target: ApprovalTarget,
  decision: DecisionRequest["decision"]
): DecisionRequest | null {
  return target.kind === "revision"
    ? { decision, revision_id: target.revision_id }
    : null
}

/** A signed preview: the page, and its home page at three widths. */
type Preview = { url: string; screenshots: string[] }

/** The laptop width of a preview's screenshots, the one a card shows. */
const LAPTOP = 2

/** Screenshots land about 10 s after the preview does; look again every 5 s for half a minute. */
const SHOT_RETRY_MS = 5000
const SHOT_TRIES = 6

/**
 * The home page on a laptop. Until the image exists it is a quiet block of
 * the same size, never a broken image; a screenshot still missing after the
 * last look tells the caller.
 */
function Shot({
  src,
  onGiveUp,
}: {
  src: string | undefined
  onGiveUp: () => void
}) {
  const [tries, setTries] = useState(0)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // A failed look waits before the next: a 404 comes back at once, and
  // retrying on it straight away spent every look in about a second.
  useEffect(() => {
    if (loaded || !failed) return
    if (tries + 1 >= SHOT_TRIES) {
      onGiveUp()
      return
    }
    const timer = setTimeout(() => {
      setFailed(false)
      setTries(tries + 1)
    }, SHOT_RETRY_MS)
    return () => clearTimeout(timer)
  }, [loaded, failed, tries, onGiveUp])
  return (
    <div className="relative aspect-[16/9] bg-muted">
      {loaded ? null : <Skeleton className="absolute inset-0 rounded-none" />}
      <img
        alt="Your home page on a laptop"
        className={cn(
          "size-full object-cover object-top",
          !loaded && "invisible"
        )}
        height={180}
        // A fresh element per look, so the browser asks again.
        key={tries}
        loading="lazy"
        onError={() => setFailed(true)}
        onLoad={() => setLoaded(true)}
        ref={loadedWhenCached(setLoaded)}
        src={src}
        width={320}
      />
    </div>
  )
}

/**
 * A version waiting for the owner, as one compact card: what it is, a
 * preview, then Publish and Request changes side by side. With `shot`, the
 * home page sits under the header and opens the preview too. A preview that
 * could not be read says so and can be read again, with no link implied.
 */
function VersionCard({
  title,
  meta,
  preview,
  onRetryPreview,
  shot = false,
  onPublish,
  onRequestChanges,
  requesting,
  revision,
  pending: busy = null,
  error = null,
  children,
}: {
  title: string
  meta: string
  preview: Preview | "loading" | "error"
  /** Reads the preview again after it could not be read. */
  onRetryPreview?: (() => Promise<void>) | undefined
  /** Show the home page on a laptop under the header. */
  shot?: boolean
  /** Null when there is no revision this card can publish. */
  onPublish: (() => void) | null
  onRequestChanges: () => void
  /** Whether a change note is open under the buttons. */
  requesting?: boolean | undefined
  /** The revision Publish sends, on the card for a reader to check, never printed. */
  revision?: string | undefined
  pending?: "approve" | "change" | null
  error?: string | null
  /** Under the buttons: the change note, where the card has one. */
  children?: ReactNode
}) {
  const id = useId()
  const ready = typeof preview === "object" ? preview : null
  // Keyed by the preview, so a fresh read shows its own screenshot.
  const [broken, setBroken] = useState<Preview | null>(null)
  return (
    <article
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card p-3"
      data-revision={revision}
      data-slot="version-card"
    >
      <div className="flex items-center gap-3">
        {/* The site's mark on the wide card; the panel's narrow one keeps its width for the name. */}
        {shot ? (
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"
          >
            <GlobeIcon className="size-5" />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="font-medium text-sm" id={`${id}-title`}>
            {title}
          </h3>
          <p className={META}>{meta}</p>
        </div>
        {ready ? (
          <a
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "shrink-0"
            )}
            href={ready.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            Preview
            <span className="sr-only"> (opens in a new tab)</span>
            <ArrowSquareOutIcon aria-hidden />
          </a>
        ) : preview === "loading" ? (
          <Skeleton className="h-8 w-20 rounded-md" />
        ) : null}
      </div>
      {shot && ready && broken !== ready ? (
        // The same preview as the link above, so a screen reader hears it once.
        <a
          className="-mx-3 block border-border border-y"
          href={ready.url}
          rel="noopener noreferrer"
          tabIndex={-1}
          target="_blank"
        >
          <Shot
            onGiveUp={() => setBroken(ready)}
            src={ready.screenshots[LAPTOP]}
          />
        </a>
      ) : null}
      {preview === "error" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className={META}>
            The preview isn't available yet. Try again in a moment.
          </p>
          {onRetryPreview ? <Retry onRetry={onRetryPreview} /> : null}
        </div>
      ) : null}
      {/* Each as wide as its words, then sharing what is left, so the two stay on one line in the panel. */}
      <div className="flex flex-wrap gap-2 *:flex-auto">
        <Button
          disabled={!onPublish || busy !== null}
          onClick={() => onPublish?.()}
          size="sm"
        >
          {busy === "approve" ? (
            <SpinnerGapIcon aria-hidden className="animate-spin" />
          ) : (
            <RocketLaunchIcon aria-hidden />
          )}
          {pending(busy === "approve", "Publish", "Publishing")}
        </Button>
        <Button
          aria-expanded={requesting}
          disabled={busy !== null}
          onClick={onRequestChanges}
          size="sm"
          variant="outline"
        >
          <PencilSimpleIcon aria-hidden />
          Request changes
        </Button>
      </div>
      {children}
      {error ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  )
}

/**
 * A version ready to publish, in the panel: the version card, whose Publish
 * sends exactly the revision the approval is bound to, and whose Request
 * changes opens a note in place.
 */
function ApprovalItem({
  target,
  title,
  meta,
  preview,
  onApprove,
  onAskForChanges,
  onRetryPreview,
  pending: busy = null,
  error = null,
  defaultAsking = false,
}: {
  target: ApprovalTarget
  title: string
  meta: string
  preview: Preview | "loading" | "error"
  onApprove: (decision: DecisionRequest) => void
  onAskForChanges: (text: string) => void
  /** Reads the preview again after it could not be read. */
  onRetryPreview?: (() => Promise<void>) | undefined
  pending?: "approve" | "change" | null
  error?: string | null
  /** Open on the change note, for the catalog. */
  defaultAsking?: boolean
}) {
  const id = useId()
  const decision = approvalDecision(target, "approved")
  const [opened, setOpened] = useState(defaultAsking)
  // A change in flight keeps its note on screen until the build is read
  // again.
  const asking = opened || busy === "change"
  const note = useRef<HTMLTextAreaElement>(null)
  const pressed = useRef(false)
  useEffect(() => {
    if (opened && pressed.current) note.current?.focus()
    pressed.current = false
  }, [opened])

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = note.current?.value.trim() ?? ""
    if (text) onAskForChanges(text)
  }

  return (
    <VersionCard
      error={error}
      meta={meta}
      onPublish={decision ? () => onApprove(decision) : null}
      onRequestChanges={() => {
        pressed.current = true
        setOpened(!opened)
      }}
      onRetryPreview={onRetryPreview}
      pending={busy}
      preview={preview}
      requesting={asking}
      revision={decision?.revision_id}
      title={title}
    >
      {asking ? (
        <form className="flex flex-col gap-2" onSubmit={send}>
          <label className="font-medium text-sm" htmlFor={`${id}-change`}>
            What should change?
          </label>
          <textarea
            className={NOTE}
            disabled={busy !== null}
            id={`${id}-change`}
            maxLength={GOAL_MAX}
            name="change"
            ref={note}
            required
          />
          <Button
            className="self-start"
            disabled={busy !== null}
            size="sm"
            type="submit"
          >
            {pending(busy === "change", "Send changes", "Sending")}
          </Button>
        </form>
      ) : null}
    </VersionCard>
  )
}

/* Coming up, done today, your website ---------------------------------- */

/**
 * Things with a time, in the order given: what closes or is due next under
 * "Coming up", or what just happened under another title. Times are in
 * `zone` once the reader's is known, UTC before. Nothing renders when the
 * list is empty.
 */
function ComingUp({
  items,
  title = "Coming up",
  zone,
}: {
  items: { id: string; text: string; at: string }[]
  title?: string
  zone?: string | null
}) {
  if (items.length === 0) return null
  return (
    <PanelSection title={title}>
      <ul className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <li className="flex flex-col py-2" key={item.id}>
            <span className="wrap-break-word text-sm">{item.text}</span>
            <span className={META}>
              {formatDateTime(item.at, zone ?? undefined)}
            </span>
          </li>
        ))}
      </ul>
    </PanelSection>
  )
}

/**
 * A reminder someone wrote down, completed in place. The title is the
 * owner's text, rendered as text. `due` is already in the reader's own zone,
 * or null while that zone is not known, so one time is never shown two ways.
 * `soon` marks one due within the hour, `overdue` one whose time has passed.
 * Pending shows the reminder as done until the list is read again; a failure
 * puts it back, with the reason under it.
 */
function ReminderNote({
  title,
  due,
  soon = false,
  overdue = false,
  byAssistant,
  onDone,
  pending: busy = false,
  error = null,
}: {
  title: string
  due: string | null
  soon?: boolean
  overdue?: boolean
  /** Set by the assistant (Reme to the owner) rather than by the owner. */
  byAssistant: boolean
  onDone: () => void
  pending?: boolean
  error?: string | null
}) {
  return (
    <div
      className="flex items-start gap-3 py-2.5"
      data-slot="reminder-note"
      data-overdue={overdue || undefined}
      data-soon={soon || undefined}
      data-state={busy ? "done" : "open"}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "wrap-break-word font-medium text-sm",
            busy && "text-muted-foreground line-through"
          )}
        >
          {title}
        </span>
        {due ? (
          <span
            className={cn(
              META,
              "flex items-center gap-1 tabular-nums",
              soon && "font-medium text-primary",
              overdue && "font-medium text-destructive"
            )}
          >
            <ClockIcon
              aria-hidden
              className="size-3.5 shrink-0"
              weight={soon || overdue ? "fill" : "regular"}
            />
            <span className="sr-only">
              {overdue ? "Overdue, was due " : "Due "}
            </span>
            {due}
          </span>
        ) : null}
        {byAssistant ? (
          <span className={META}>Set by your assistant</span>
        ) : null}
        {error ? (
          <p className="text-[0.8125rem] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        aria-label={`Done: ${title}`}
        disabled={busy}
        // Focus stays on the button while it waits, so a failure hands it back.
        focusableWhenDisabled
        onClick={onDone}
        size="sm"
        variant="outline"
      >
        Done
      </Button>
    </div>
  )
}

/**
 * The reminders still ahead (the children, `ReminderNote`s, soonest first),
 * under a tab that names them, so there is no heading here. `status` is the
 * last thing the owner did, announced politely.
 */
function ReminderList({
  children,
  status = null,
}: {
  children: ReactNode
  status?: string | null
}) {
  const notes = Children.toArray(children).filter(isValidElement)
  return (
    <div className="flex flex-col gap-2" data-slot="reminder-list">
      <p className="text-sm empty:hidden" role="status">
        {status}
      </p>
      <ul className="flex flex-col divide-y divide-border">
        {notes.map((note) => (
          <li key={note.key}>{note}</li>
        ))}
      </ul>
    </div>
  )
}

/** A screenshot of the live site's home page, or "loading" while it is read. */
type Thumbnail = { src: string } | "loading" | null

/**
 * The site as it stands: the version that is live, a link to it and, beside
 * the link, "Request changes", which the app answers by putting the chat's
 * composer into website change mode. The host is the link's title rather
 * than its text, since a long one would not fit. The thumbnail is the
 * panel's only image, at a fixed ratio so nothing moves when it arrives; one
 * that fails to load leaves the text alone.
 */
function YourWebsite({
  host,
  url,
  live,
  thumbnail = null,
  onRequestChanges,
}: {
  host: string | null
  /** Where `host` opens, as the api built it (http and a port on local dev). */
  url?: string | null
  live: number | null
  thumbnail?: Thumbnail
  /** Starts a change to the live site in the chat. */
  onRequestChanges?: (() => void) | undefined
}) {
  const [broken, setBroken] = useState<string | null>(null)
  // Once a screenshot has shown, a newer one loads behind it: the browser
  // keeps painting the old image until the new one is ready.
  const [loaded, setLoaded] = useState(false)
  const shot = live ? thumbnail : null
  const change = live && onRequestChanges
  return (
    <div className="flex flex-col gap-3" data-slot="your-website">
      {shot === "loading" ? (
        <Skeleton className="aspect-[16/10] w-full rounded-md" />
      ) : shot && shot.src !== broken ? (
        <div className="relative aspect-[16/10] w-full">
          {loaded ? null : <Skeleton className="absolute inset-0 rounded-md" />}
          <img
            alt="Your website's home page on a laptop"
            className={cn(
              "size-full rounded-md border border-border object-cover object-top",
              !loaded && "invisible"
            )}
            height={200}
            loading="lazy"
            onError={() => setBroken(shot.src)}
            onLoad={() => setLoaded(true)}
            ref={loadedWhenCached(setLoaded)}
            src={shot.src}
            width={320}
          />
        </div>
      ) : null}
      <p className="flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            live ? "bg-primary" : "bg-muted-foreground/40"
          )}
        />
        {live ? "Your website is live" : "Nothing is published yet"}
      </p>
      {live && (host || change) ? (
        // Side by side, each growing to share the row; a row too narrow for
        // both wraps rather than squeezing the words.
        <div className="flex flex-wrap gap-2">
          {host ? (
            <a
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "grow"
              )}
              href={url ?? `https://${host}`}
              rel="noreferrer"
              target="_blank"
              title={host}
            >
              Visit your website
              <span className="sr-only"> (opens in a new tab)</span>
              <ArrowSquareOutIcon
                aria-hidden
                className="text-muted-foreground"
              />
            </a>
          ) : null}
          {change ? (
            <Button
              className="grow"
              // It moves the owner to the composer, so the phone sheet goes.
              data-leaves-panel
              onClick={onRequestChanges}
              size="lg"
              variant="outline"
            >
              Request changes
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* The minimised panel ---------------------------------------------------- */

/**
 * The panel in one line, for its header and for all of it when minimised:
 * a dot for the site (pulsing while a build works, the accent while a
 * version is live), the lead words, and the rest quieter. It never wraps;
 * the app picks what the line says. Spans only, and no live region: the
 * shell puts it inside the button that opens the panel.
 */
/** How long each line holds the panel's header when several share it. */
const LINE_TURN_MS = 4000

/**
 * The panel's header line. With several `lines`, such as two jobs at work,
 * each takes a turn: the next slides in every few seconds, and a pointer
 * resting on it holds the one showing. The persona and its halo stay put.
 */
function LiveLine({
  tone,
  lead,
  detail = null,
  lines,
  avatar = null,
}: {
  tone: "working" | "live" | "idle"
  lead: string
  detail?: string | null
  lines?: readonly { lead: string; detail?: string | null }[] | undefined
  /** The assistant's face, Reme's own when null. */
  avatar?: AvatarId | null
}) {
  const [held, setHeld] = useState(false)
  const turns = lines && lines.length > 1 ? lines : [{ lead, detail }]
  const { item, at } = useCycle(turns, LINE_TURN_MS, held)
  const shown = item ?? { lead, detail }
  return (
    <span
      className="flex min-w-0 items-center gap-2 text-sm"
      data-slot="live-line"
      data-tone={tone}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
    >
      {/* The assistant, moving as it does everywhere; while it works a halo
          pulses behind it, and when the work is live the halo holds. */}
      <span aria-hidden className="relative flex size-6 shrink-0">
        {tone === "idle" ? null : (
          <span
            className={cn(
              "absolute -inset-1 rounded-full bg-primary/30",
              tone === "working" && "animate-pulse motion-reduce:animate-none"
            )}
            data-slot="live-line-halo"
          />
        )}
        <AssistantAvatar className="size-6" id={avatar} sway />
      </span>
      <span
        className={cn(
          "min-w-0 truncate",
          turns.length > 1 &&
            "fade-in slide-in-from-bottom-1 animate-in duration-300 motion-reduce:animate-none"
        )}
        // A new key per turn replays the slide.
        key={turns.length > 1 ? `${at}:${shown.lead}` : "line"}
      >
        <span className="font-medium">{shown.lead}</span>
        {shown.detail ? (
          <span className="text-muted-foreground"> {shown.detail}</span>
        ) : null}
      </span>
    </span>
  )
}

/**
 * What the owner can do next, from the app: links and buttons drawn as
 * outline buttons, side by side and wrapping on a narrow panel. No heading,
 * since each one names its action; a list named for a screen reader. With
 * nothing in it, it renders nothing.
 */
function NextSteps({ children }: { children?: ReactNode }) {
  const items = Children.toArray(children).filter(isValidElement)
  if (!items.length) return null
  return (
    <ul
      aria-label="Next steps"
      className="flex flex-wrap gap-2"
      data-slot="next-steps"
    >
      {items.map((item) => (
        <li key={item.key}>{item}</li>
      ))}
    </ul>
  )
}

export type { Preview, SegmentStep, Thumbnail }
export {
  AnswerInputs,
  ApprovalItem,
  approvalDecision,
  ComingUp,
  LiveLine,
  NextSteps,
  PanelSection,
  PanelSegment,
  QuestionItem,
  ReminderList,
  ReminderNote,
  StageDetail,
  StopBuild,
  stageWord,
  VersionCard,
  WaitingOnYou,
  YourWebsite,
}
