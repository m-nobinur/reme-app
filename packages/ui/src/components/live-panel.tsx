import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  GlobeIcon,
  ImageIcon,
  MinusCircleIcon,
  type Icon as PhosphorIcon,
  RocketLaunchIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import type {
  ApprovalTarget,
  AssignmentState,
  AvatarId,
  Blueprint,
  BuildActivity,
  BuildPhoto,
  DecisionRequest,
} from "@workspace/contracts"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Diffusing } from "@workspace/ui/components/diffusing"
import { Field } from "@workspace/ui/components/field"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { StatusIcon } from "@workspace/ui/components/status-line"
import { useCycle } from "@workspace/ui/hooks/use-cycle"
import { SKIPPED, type StatusKind } from "@workspace/ui/lib/activity-copy"
import {
  type AnswerSpec,
  FACT_INPUTS,
  type FactInput,
} from "@workspace/ui/lib/answer"
import {
  directionLabel,
  pairOfBlueprint,
  paletteName,
  paletteStops,
} from "@workspace/ui/lib/blueprint"
import { formatDateTime, relativeTime } from "@workspace/ui/lib/format"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  Children,
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

/** A section's way to the rest of its list, beside its heading. */
const SECTION_ACTION =
  "text-[0.8125rem] text-muted-foreground underline-offset-4 outline-none transition-colors hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"

/** Sections after the first are set off by a hairline. */
function PanelSection({
  title,
  icon: Icon,
  count,
  action,
  children,
}: {
  title: string
  /** A quiet mark before the heading. */
  icon?: PhosphorIcon
  count?: number
  /** A link or button to the rest of the list, at the heading's end. */
  action?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 border-border not-first:border-t not-first:pt-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1 font-semibold text-sm" id={id}>
          {Icon ? (
            <Icon aria-hidden className="size-4 text-muted-foreground" />
          ) : null}
          {title}
          {count ? (
            <span className="ms-1 rounded-full bg-muted px-1.5 font-medium text-[0.6875rem] text-muted-foreground tabular-nums leading-4">
              {count}
            </span>
          ) : null}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
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
            "size-full object-cover transition-opacity duration-enter motion-reduce:transition-none",
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
      // Waiting, being written (several at once, as the writers run side by
      // side), written.
      return row.items?.length ? (
        <ul aria-label="Pages" className="flex flex-wrap gap-1.5">
          {row.items.map((item) => (
            <li
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs",
                item.done || item.working
                  ? "border-border text-foreground"
                  : "border-dashed text-muted-foreground"
              )}
              data-state={item.done ? "done" : item.working ? "now" : "next"}
              key={item.label}
            >
              {item.done ? (
                <CheckCircleIcon
                  aria-hidden
                  className="size-3 text-primary"
                  weight="fill"
                />
              ) : null}
              {/* The shimmer masks its own box, so it takes the words, not the border. */}
              <span
                className={cn(
                  !item.done &&
                    item.working &&
                    "shimmer shimmer-color-foreground motion-reduce:animate-none"
                )}
              >
                {item.label}
              </span>
              {item.done ? (
                <span className="sr-only"> (written)</span>
              ) : item.working ? (
                <span className="sr-only"> (being written)</span>
              ) : null}
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
          Fixing what the checks found, then checking again.
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
      className="fade-in flex animate-in flex-col duration-enter motion-reduce:animate-none"
      data-slot="panel-segment"
      data-state={folded ? "folded" : state}
    >
      <div className="flex items-start gap-1">
        <span aria-hidden className="mt-0.5 flex size-4 shrink-0">
          {folded ? (
            <CheckCircleIcon className="size-4 text-primary" weight="fill" />
          ) : failed ? (
            <WarningCircleIcon className="size-4 text-destructive" />
          ) : (
            // Moving only while work runs; waiting on the owner, the step
            // under it moves instead.
            <StatusIcon
              className="text-primary"
              kind={icon}
              still={state !== "now"}
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
            "grid transition-[grid-template-rows] duration-enter ease-standard motion-reduce:transition-none",
            shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
          id={`${id}-steps`}
          inert={!shown}
        >
          <div className="min-h-0 overflow-hidden">
            {/* Set in a little from the header, so the steps read as the segment's own. */}
            <div className="flex flex-col gap-3 ps-3 pt-2">
              <p aria-live="polite" className="sr-only">
                {current && !done
                  ? `Now: ${current.said ?? current.label}.`
                  : ""}
              </p>
              <ol aria-label="Steps" className="flex flex-col">
                {shownSteps.map((step) => (
                  <li
                    className="group relative flex gap-1.5 pb-3 last:pb-0"
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
 * Work under way and what waits on the owner, one per list row, answered in
 * place. The first `limit` show; the rest open in place, and an item stays
 * until it is done. `status` is the last thing the owner did, announced
 * politely; `error` says the list could not be read and is shown above
 * whatever was read before. With nothing in it and nothing to say, it
 * renders nothing.
 */
function WaitingOnYou({
  children,
  title = "Waiting on you",
  icon,
  limit = Number.POSITIVE_INFINITY,
  status = null,
  error = null,
  onRetry,
}: {
  children?: ReactNode
  title?: string
  icon?: PhosphorIcon
  limit?: number
  status?: string | null
  error?: string | null
  /** Read the list again now, offered when it did not load. */
  onRetry?: () => Promise<void>
}) {
  const [all, setAll] = useState(false)
  const items = Children.toArray(children).filter(isValidElement)
  const hidden = all ? 0 : Math.max(0, items.length - limit)
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
    <PanelSection
      action={
        hidden ? (
          <button
            className={SECTION_ACTION}
            onClick={() => setAll(true)}
            type="button"
          >
            Show {hidden} more
          </button>
        ) : null
      }
      count={items.length}
      {...(icon ? { icon } : {})}
      title={title}
    >
      <p className="text-sm empty:hidden" role="status">
        {status}
      </p>
      {error ? <p className={META}>{error}</p> : null}
      {items.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {items.slice(0, items.length - hidden).map((item) => (
            // The list's ends sit on the heading and the next section, not padded off them.
            <li className="first:*:pt-0 last:*:pb-0" key={item.key}>
              {item}
            </li>
          ))}
        </ul>
      ) : null}
      {!items.length && error && onRetry ? <Retry onRetry={onRetry} /> : null}
    </PanelSection>
  )
}

const pending = (busy: boolean, idle: string, working: string) =>
  busy ? working : idle

function Retry({
  onRetry,
  label = "Try again",
  busyLabel = "Trying again",
}: {
  onRetry: () => Promise<void>
  label?: string
  busyLabel?: string
}) {
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
      {pending(busy, label, busyLabel)}
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
 * A question waiting on the owner. It is answered in the chat, never here:
 * the row says it waits and `action` takes the owner to the card.
 */
function QuestionItem({ title, action }: { title: string; action: ReactNode }) {
  const id = useId()
  return (
    <article
      aria-labelledby={`${id}-title`}
      className="flex flex-col items-start gap-1 py-3"
      data-slot="question-item"
    >
      <h3 className="font-medium text-sm" id={`${id}-title`}>
        {title}
      </h3>
      <p className={META}>Waiting on your answer</p>
      {action}
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

/** A signed preview of a version: the page to open. */
type Preview = { url: string }

/** One version's pictures: its home page's first screen on a laptop, the screen below, its first screen on a phone, and its icon. */
type VersionPictures = Record<"laptop" | "laptop-2" | "phone" | "icon", string>

/** Screenshots land about 10 s after the preview does; look again every 5 s for half a minute. */
const SHOT_RETRY_MS = 5000
const SHOT_TRIES = 6

/** The light a screenshot drifts in while it waits: the brand, faint, on the muted tile. */
const SHOT_LIGHT = [
  "color-mix(in oklab, var(--primary) 45%, transparent)",
  "color-mix(in oklab, var(--muted-foreground) 30%, transparent)",
]

/**
 * A screenshot of a version's home page. Until the image exists it is soft
 * light drifting on a muted tile, never a broken image, and it fades in once
 * it loads; still missing after the last look, it says there is no preview.
 * No `src` yet is a wait that never gives up.
 */
function Shot({
  src,
  alt = "",
  className,
}: {
  src: string | undefined
  alt?: string
  /** Its shape: the ratio and corners of where it sits. */
  className?: string
}) {
  const [tries, setTries] = useState(0)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const gaveUp = failed && tries + 1 >= SHOT_TRIES
  // A failed look waits before the next: a 404 comes back at once, and
  // retrying on it straight away spent every look in about a second.
  useEffect(() => {
    if (loaded || !failed || tries + 1 >= SHOT_TRIES) return
    const timer = setTimeout(() => {
      setFailed(false)
      setTries(tries + 1)
    }, SHOT_RETRY_MS)
    return () => clearTimeout(timer)
  }, [loaded, failed, tries])
  return (
    <span
      className={cn("relative block overflow-hidden bg-muted", className)}
      data-slot="shot"
    >
      {loaded ? null : (
        <Diffusing
          className="absolute inset-0"
          colors={SHOT_LIGHT}
          motion="motion-safe:animate-shot-drift"
          paper="var(--muted)"
        >
          {gaveUp && alt ? (
            <span className={META}>No preview to show yet</span>
          ) : null}
        </Diffusing>
      )}
      {src && !gaveUp ? (
        <img
          alt={alt}
          className={cn(
            "relative size-full object-cover object-top transition-opacity duration-enter motion-reduce:transition-none",
            loaded ? "opacity-100" : "opacity-0"
          )}
          height={250}
          // A fresh element per look, so the browser asks again.
          key={tries}
          loading="lazy"
          onError={() => setFailed(true)}
          onLoad={() => setLoaded(true)}
          ref={loadedWhenCached(setLoaded)}
          src={src}
          width={400}
        />
      ) : null}
    </span>
  )
}

/** The built site's own icon, or a globe until it loads and if it never does. */
function SiteIcon({
  src,
  className,
}: {
  src: string | undefined
  className?: string
}) {
  const [broken, setBroken] = useState<string | null>(null)
  return (
    <span
      aria-hidden
      className={cn(
        // A quarter round, the starter's own icon outline, so its corners never show past it.
        "grid size-9 shrink-0 place-items-center overflow-hidden rounded-[25%] bg-primary/10 text-primary",
        className
      )}
    >
      {src && src !== broken ? (
        <img
          alt=""
          className="size-full object-cover"
          onError={() => setBroken(src)}
          src={src}
        />
      ) : (
        <GlobeIcon className="size-1/2" />
      )}
    </span>
  )
}

/** Preview, opening the version in a new tab; a read that failed can be tried again. */
function PreviewLink({
  preview,
  onRetry,
  iconOnly = false,
}: {
  preview: Preview | "loading" | "error"
  onRetry?: (() => Promise<void>) | undefined
  /** The icon alone, named for a screen reader and on hover. */
  iconOnly?: boolean
}) {
  if (preview === "loading") {
    // Faded in late, so a read that comes back quickly shows no placeholder.
    return (
      <div className="fade-in shrink-0 animate-in fill-mode-backwards delay-300">
        <Skeleton className={cn("h-8 rounded-md", iconOnly ? "w-8" : "w-22")} />
      </div>
    )
  }
  if (preview === "error") {
    return onRetry ? (
      <Retry
        busyLabel="Reading it again"
        label="Retry preview"
        onRetry={onRetry}
      />
    ) : null
  }
  return (
    <a
      className={cn(
        buttonVariants({
          variant: iconOnly ? "outline" : "ghost",
          size: iconOnly ? "icon-sm" : "sm",
        }),
        "shrink-0"
      )}
      href={preview.url}
      rel="noopener noreferrer"
      target="_blank"
      title={iconOnly ? "Preview" : undefined}
    >
      <span className={iconOnly ? "sr-only" : undefined}>Preview</span>
      <span className="sr-only"> (opens in a new tab)</span>
      <ArrowSquareOutIcon aria-hidden />
    </a>
  )
}

/** The deck's cards, the home page first. */
const SLIDES = [
  { picture: "laptop", alt: "Your home page" },
  { picture: "laptop-2", alt: "Another page of your website" },
  { picture: "phone", alt: "Your home page on a phone" },
] as const

/** The cards edging out behind the front one, by how far back: raised, narrower and dimmer, so only a top edge shows. */
const BEHIND = [
  "z-20 -translate-y-2 scale-[0.94] opacity-70",
  "z-10 -translate-y-4 scale-[0.88] opacity-40",
]

/** A round control at the deck's side: quiet until it is hovered where there is a pointer, always there on touch. Centred by its margins, since a pressed button nudges its own translate. */
const ARROW =
  "absolute inset-y-0 z-10 my-auto size-7 rounded-full bg-background/60 shadow-sm backdrop-blur-sm transition-opacity focus-visible:opacity-100 motion-reduce:transition-none pointer-fine:opacity-0 pointer-fine:group-hover/stack:opacity-100"

/**
 * A phone holding the screenshot, whole and upright on the card: a hairline
 * black bezel inside a fine metal edge, large rounded corners, a camera
 * island over the screen, the action and volume keys on the left and the
 * power key on the right, at a current phone's proportions, 0.48 wide to
 * tall. Behind it, the same screenshot blurred into soft colour under a
 * faint glow of the brand, so the phone sits in light, not on a flat tile. The bezel is in pixels: a percentage
 * padding would be a share of the card's width, not the phone's.
 */
function PhoneMock({ src, alt }: { src: string | undefined; alt: string }) {
  const key = "absolute w-0.5 bg-device ring-1 ring-foreground/15"
  return (
    <span className="relative block size-full overflow-hidden bg-muted">
      {src ? (
        <img
          alt=""
          className="absolute inset-0 size-full scale-125 object-cover opacity-35 blur-2xl"
          src={src}
        />
      ) : null}
      <span
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(55%_65%_at_50%_45%,color-mix(in_oklab,var(--primary)_28%,transparent),transparent_75%)]"
      />
      <span className="absolute top-[4%] left-1/2 aspect-[48/100] h-[82%] -translate-x-1/2 rounded-[17%/8.2%] bg-device p-[2.5px] shadow-2xl ring-1 ring-foreground/25">
        <span
          aria-hidden
          className={cn(key, "top-[16%] -left-0.5 h-[4%] rounded-l-sm")}
        />
        <span
          aria-hidden
          className={cn(key, "top-[23%] -left-0.5 h-[7%] rounded-l-sm")}
        />
        <span
          aria-hidden
          className={cn(key, "top-[32%] -left-0.5 h-[7%] rounded-l-sm")}
        />
        <span
          aria-hidden
          className={cn(key, "top-[26%] -right-0.5 h-[11%] rounded-r-sm")}
        />
        <span className="relative block size-full overflow-hidden rounded-[15.5%/7.4%] bg-background">
          <Shot alt={alt} className="size-full" src={src} />
          <span
            aria-hidden
            className="absolute top-[2%] left-1/2 h-[3.4%] w-[30%] -translate-x-1/2 rounded-full bg-device"
          />
        </span>
      </span>
    </span>
  )
}

/** One card's face: the screenshot, or the phone holding it. */
function SlideFace({
  slide,
  src,
  alt,
}: {
  slide: (typeof SLIDES)[number]
  src: string | undefined
  alt: string
}) {
  return slide.picture === "phone" ? (
    <PhoneMock alt={alt} src={src} />
  ) : (
    <Shot alt={alt} className="size-full" src={src} />
  )
}

/**
 * The version as a small deck: the home page in front, the cards to come
 * edging out behind. The arrows at its sides and the dots under it move to
 * another card, which slides into the front; the front card opens the
 * preview once there is one.
 */
function ShotStack({
  pictures,
  url,
}: {
  pictures: VersionPictures | null
  url: string | null
}) {
  const [front, setFront] = useState(0)
  const step = (by: number) =>
    setFront((at) => (at + by + SLIDES.length) % SLIDES.length)
  return (
    <div className="group/stack relative isolate pt-4" data-slot="shot-stack">
      {BEHIND.map((place, depth) => {
        const slide = SLIDES[(front + depth + 1) % SLIDES.length] ?? SLIDES[0]
        return (
          <div
            aria-hidden
            className={cn(
              "absolute inset-x-0 top-4 aspect-[16/10] origin-top overflow-hidden rounded-lg border border-border bg-muted",
              place
            )}
            key={place}
          >
            <SlideFace alt="" slide={slide} src={pictures?.[slide.picture]} />
          </div>
        )
      })}
      <div className="relative z-30 aspect-[16/10] overflow-hidden rounded-lg border border-border bg-muted shadow-sm">
        <div
          className="flex size-full transition-transform duration-slow ease-standard motion-reduce:transition-none"
          style={{ transform: `translateX(-${front * 100}%)` }}
        >
          {SLIDES.map((slide, at) => {
            const shown = at === front
            const face = (
              <SlideFace
                alt={shown ? slide.alt : ""}
                slide={slide}
                src={pictures?.[slide.picture]}
              />
            )
            return (
              <div
                aria-hidden={!shown}
                className="size-full shrink-0"
                inert={!shown}
                key={slide.picture}
              >
                {url && shown ? (
                  // The same preview as the link above it, so a screen reader hears it once.
                  <a
                    className="block size-full"
                    href={url}
                    rel="noopener noreferrer"
                    tabIndex={-1}
                    target="_blank"
                  >
                    {face}
                  </a>
                ) : (
                  face
                )}
              </div>
            )
          })}
        </div>
        <Button
          aria-label="The previous picture"
          className={cn(ARROW, "left-1.5")}
          onClick={() => step(-1)}
          size="icon-xs"
          variant="ghost"
        >
          <CaretLeftIcon aria-hidden />
        </Button>
        <Button
          aria-label="The next picture"
          className={cn(ARROW, "right-1.5")}
          onClick={() => step(1)}
          size="icon-xs"
          variant="ghost"
        >
          <CaretRightIcon aria-hidden />
        </Button>
        <div className="absolute inset-x-0 bottom-1.5 z-10 flex justify-center">
          {/* Each dot's button is 20 px wide and 24 px from the next: a target a finger can hit, in a pill that stays small. */}
          <div className="flex gap-1 rounded-full bg-background/60 px-1 backdrop-blur-sm">
            {SLIDES.map((slide, at) => (
              <button
                aria-label={slide.alt}
                aria-pressed={at === front}
                className="group/dot grid h-4 w-5 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                key={slide.picture}
                onClick={() => setFront(at)}
                type="button"
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-enter motion-reduce:transition-none",
                    at === front
                      ? "w-3 bg-foreground"
                      : "w-1.5 bg-foreground/40 group-hover/dot:bg-foreground/70"
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {SLIDES[front]?.alt}
      </p>
    </div>
  )
}

/**
 * A version ready to publish, in the panel, under the step that waits on
 * it: the version as a stack of screenshots, then Publish, which
 * sends exactly the revision the approval is bound to, and Preview.
 */
function ApprovalItem({
  target,
  title,
  pictures,
  preview,
  onApprove,
  onRetryPreview,
  pending: busy = false,
  error = null,
}: {
  target: ApprovalTarget
  /** The site's name, which names the card for a screen reader. */
  title: string
  pictures: VersionPictures | null
  preview: Preview | "loading" | "error"
  onApprove: (decision: DecisionRequest) => void
  /** Reads the preview again after it could not be read. */
  onRetryPreview?: (() => Promise<void>) | undefined
  pending?: boolean
  error?: string | null
}) {
  const decision = approvalDecision(target, "approved")
  return (
    <article
      aria-label={title}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3"
      data-revision={decision?.revision_id}
      data-slot="approval-item"
    >
      <ShotStack
        pictures={pictures}
        url={typeof preview === "object" ? preview.url : null}
      />
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={!decision || busy}
          onClick={() => decision && onApprove(decision)}
          size="sm"
        >
          {busy ? (
            <SpinnerGapIcon aria-hidden className="animate-spin" />
          ) : (
            <RocketLaunchIcon aria-hidden />
          )}
          {pending(busy, "Publish", "Publishing")}
        </Button>
        <PreviewLink iconOnly onRetry={onRetryPreview} preview={preview} />
      </div>
      {error ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  )
}

/* Coming up, done today, your website ---------------------------------- */

/**
 * Things with a time, in the order given: what closes or is due next under
 * "Coming up", or what just happened under another title. Each row says how
 * far off it is ("in 25 min", "2 hr ago") beside its text; the exact time,
 * in `zone` once the reader's is known, is its tooltip. Nothing renders when
 * the list is empty.
 */
function ComingUp({
  items,
  title = "Coming up",
  icon = ClockIcon,
  count,
  zone,
  action,
  ahead = true,
}: {
  items: { id: string; text: string; at: string }[]
  title?: string
  icon?: PhosphorIcon
  /** How many there are in all, when `items` are only the first. */
  count?: number
  zone?: string | null
  /** The way to the whole list, when these are only the first. */
  action?: ReactNode
  /** Times still to come: one that has passed is due now, never "ago". */
  ahead?: boolean
}) {
  if (items.length === 0) return null
  return (
    <PanelSection
      action={action}
      count={count ?? items.length}
      icon={icon}
      title={title}
    >
      {/* Under the heading's text, past its icon, so the rows read as the section's own. */}
      <ul className="flex flex-col divide-y divide-border ps-5">
        {items.map((item) => (
          <li
            className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0"
            key={item.id}
          >
            <span className="wrap-break-word min-w-0 text-sm">{item.text}</span>
            <time
              className={cn(META, "shrink-0 tabular-nums")}
              dateTime={item.at}
              title={formatDateTime(item.at, zone ?? undefined) ?? undefined}
            >
              {ahead && Date.parse(item.at) <= Date.now()
                ? "due now"
                : relativeTime(item.at)}
            </time>
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
 * than its text, since a long one would not fit. The thumbnail holds its
 * ratio while it loads, so nothing moves when it arrives.
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
  const shot = live ? thumbnail : null
  const change = live && onRequestChanges
  return (
    <div className="flex flex-col gap-3" data-slot="your-website">
      {shot ? (
        <Shot
          alt="Your website's home page on a laptop"
          className="aspect-[16/10] w-full rounded-md border border-border"
          key={shot === "loading" ? "loading" : shot.src}
          src={shot === "loading" ? undefined : shot.src}
        />
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
            "fade-in slide-in-from-bottom-1 animate-in duration-enter motion-reduce:animate-none"
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

export type { Preview, SegmentStep, Thumbnail, VersionPictures }
export {
  AnswerInputs,
  ApprovalItem,
  approvalDecision,
  ComingUp,
  LiveLine,
  NextSteps,
  PanelSection,
  PanelSegment,
  PreviewLink,
  QuestionItem,
  ReminderList,
  ReminderNote,
  SECTION_ACTION,
  Shot,
  SiteIcon,
  StageDetail,
  StopBuild,
  stageWord,
  WaitingOnYou,
  YourWebsite,
}
