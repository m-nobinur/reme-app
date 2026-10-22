import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  ClockIcon,
  ImageIcon,
} from "@phosphor-icons/react"
import {
  type ApprovalTarget,
  type AssignmentState,
  type Blueprint,
  type BuildActivity,
  type BuildLane,
  type BuildPhoto,
  type DecisionRequest,
  GOAL_MAX,
} from "@workspace/contracts"
import { ApprovalTargetSummary } from "@workspace/ui/components/approval-target"
import { BlueprintCard } from "@workspace/ui/components/assistant/blueprint-card"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Field } from "@workspace/ui/components/field"
import {
  type GeneratedPhoto,
  GeneratedPhotos,
  type PhotoActions,
} from "@workspace/ui/components/generated-photos"
import { PersonaAvatar } from "@workspace/ui/components/persona"
import { Skeleton } from "@workspace/ui/components/skeleton"
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
import { currentRow, WORKING } from "@workspace/ui/lib/build-state"
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

const LINK =
  "inline-flex items-center gap-1 rounded-sm text-primary text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring [&_svg]:size-3.5"

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
function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={LINK} href={href} rel="noopener noreferrer" target="_blank">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
      <ArrowSquareOutIcon aria-hidden />
    </a>
  )
}

const expiryLine = (expiresAt: string | null, onExpiry: string) => {
  const expires = formatDateTime(expiresAt)
  return expires ? `Open until ${expires}. ${onExpiry}` : onExpiry
}

/* Working on ---------------------------------------------------------- */

const STEPS = ["Queued", "Building", "Checking", "Ready"] as const

/**
 * Where each build state sits on the stepper and what the owner is told.
 * Whether it is doing work (the bar pulses) is `WORKING`'s to say. Every
 * state has a row, so a state added to the contract fails the build until it
 * is placed.
 */
const BUILD_STAGES = {
  queued: { step: 0, note: "Waiting to start." },
  briefing: { step: 1, note: "Reading your brief." },
  planning: { step: 1, note: "Planning the changes." },
  implementing: { step: 1, note: "Making the changes." },
  revising: { step: 1, note: "Making your changes." },
  repairing: { step: 1, note: "Fixing what the checks found." },
  blocked_on_information: {
    step: 1,
    note: "Waiting on you: answer the question below.",
  },
  paused: { step: 1, note: "Paused. It spends nothing more." },
  validating: { step: 2, note: "Checking the site." },
  preview_ready: { step: 3, note: "Ready for you to look at." },
  awaiting_review: { step: 3, note: "Ready for your review." },
  blocked_on_approval: {
    step: 3,
    note: "Waiting on you: approve it below.",
  },
  release_candidate: { step: 3, note: "Publishing." },
  published: { step: 3, note: "Live." },
  failed: { step: 1, note: "It stopped: the build failed." },
  cancelled: { step: 0, note: "Stopped." },
} satisfies Record<AssignmentState, { step: 0 | 1 | 2 | 3; note: string }>

/** A build state in one or two words: its step, or why it waits. */
function stageWord(state: AssignmentState): string {
  if (state === "blocked_on_information" || state === "blocked_on_approval") {
    return "Waiting on you"
  }
  if (state === "paused") return "Paused"
  return STEPS[BUILD_STAGES[state].step]
}

/** The states a Stop still means something in. */
const STOPPABLE = (state: AssignmentState) =>
  BUILD_STAGES[state].step < 3 && state !== "failed" && state !== "cancelled"

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`
}

/**
 * The time since `startedAt`, ticking once a second. Null on the server and
 * on the first client render, so the markup the server sent still matches.
 * `now` pins it, for the catalog.
 */
function useElapsed(startedAt: string, now?: number): number | null {
  const [clock, setClock] = useState<number | null>(null)
  useEffect(() => {
    if (now !== undefined) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [now])
  const at = now ?? clock
  return at === null ? null : at - Date.parse(startedAt)
}

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
  awaiting,
}: {
  row: BuildActivity
  at: "done" | "now" | "next"
  plan?: Blueprint | undefined
  photos?: readonly BuildPhoto[] | undefined
  awaiting: boolean
}) {
  switch (row.id) {
    case "planning":
      return (
        <>
          {at === "now" ? (
            <p className={META}>
              {awaiting
                ? "Waiting for your review. The plan is in the chat."
                : "Choosing a look, colours and pages."}
            </p>
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
 * Every step of a full build, in order: done ones ticked and folded, the one
 * it is on marked, moving and open, the rest quiet. A done step's detail
 * opens on demand. A screen reader hears the step change, never the counts
 * ticking.
 */
function BuildSteps({
  rows,
  plan,
  photos,
  awaiting,
}: {
  rows: readonly BuildActivity[]
  plan?: Blueprint | undefined
  photos?: readonly BuildPhoto[] | undefined
  awaiting: boolean
}) {
  const now = currentRow(rows)
  const current = rows[now]
  const waiting = awaiting && current?.id === "planning"
  return (
    <>
      <p aria-live="polite" className="sr-only">
        {current
          ? `Now: ${waiting ? "waiting for your review" : current.label.toLowerCase()}.`
          : ""}
      </p>
      <ol aria-label="Build steps" className="flex flex-col">
        {rows.map((row, index) => {
          const at =
            index === now ? "now" : row.done >= row.total ? "done" : "next"
          return (
            <li
              className="group relative flex gap-2.5 pb-3 last:pb-0"
              data-state={at}
              key={row.id}
            >
              {/* The rail between markers, quiet, ticked off as steps finish. */}
              <span
                aria-hidden
                className={cn(
                  "absolute top-5 bottom-0.5 left-[7.5px] w-px group-last:hidden",
                  at === "done" ? "bg-primary/45" : "bg-border"
                )}
              />
              <span aria-hidden className="mt-px flex size-4 shrink-0">
                {at === "done" ? (
                  <CheckCircleIcon
                    className="size-4 text-primary"
                    weight="fill"
                  />
                ) : at === "next" ? (
                  <CircleIcon className="size-4 text-muted-foreground/60" />
                ) : waiting ? (
                  <ClockIcon className="size-4 text-primary" />
                ) : (
                  <CircleNotchIcon className="size-4 animate-spin text-primary motion-reduce:animate-none" />
                )}
              </span>
              {at === "done" ? (
                // A finished step folds to its line; its detail opens on demand.
                <details className="group/step flex min-w-0 flex-1 flex-col">
                  <summary className="flex cursor-pointer list-none items-baseline gap-1.5 rounded-sm text-[0.8125rem] focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 flex-1 text-foreground">
                      {row.label}
                      <span className="sr-only"> (done)</span>
                    </span>
                    {row.total > 1 ? (
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {row.done} of {row.total}
                      </span>
                    ) : null}
                    <CaretDownIcon
                      aria-hidden
                      className="size-3 shrink-0 self-center text-muted-foreground transition-transform group-open/step:rotate-180 motion-reduce:transition-none"
                    />
                  </summary>
                  <div className="flex flex-col gap-2 pt-2">
                    <StepDetail
                      at={at}
                      awaiting={awaiting}
                      photos={photos}
                      plan={plan}
                      row={row}
                    />
                  </div>
                </details>
              ) : (
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="flex items-baseline justify-between gap-2 text-[0.8125rem]">
                    <span
                      className={cn(
                        at === "now"
                          ? "font-medium text-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      {row.label}
                      <span className="sr-only">
                        {at === "now" ? " (now)" : " (next)"}
                      </span>
                    </span>
                    {row.total > 1 && at !== "next" ? (
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {row.done} of {row.total}
                      </span>
                    ) : null}
                  </p>
                  <StepDetail
                    at={at}
                    awaiting={awaiting}
                    photos={photos}
                    plan={plan}
                    row={row}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </>
  )
}

/**
 * The live stepper: the build the team is on, tied to its real state, with
 * the time it has taken against the measured typical, a Stop, and what is
 * queued behind it. The one bold thing in the panel.
 */
function WorkingOn({
  build,
  queued = [],
  expectedSeconds,
  now,
  onStop,
  stopping = false,
  error = null,
  defaultConfirming = false,
}: {
  build: {
    goal: string
    state: AssignmentState
    startedAt: string
    /** A build with no lane is a full one. */
    lane?: BuildLane
    /** A quick edit that moved to a fuller lane, which the panel says once. */
    fellThrough?: boolean
    /** Fixed-string progress rows from the orchestrator; none shows only the stepper. */
    activity?: BuildActivity[]
    /** The plan, once one is made: what it decided shows under its step. */
    plan?: Blueprint | undefined
    /** The plan waits on the owner's review, which the clock leaves out. */
    awaitingReview?: boolean
    /** The photos it is making, as each settles. */
    photos?: readonly BuildPhoto[] | undefined
    /** Time spent on decided plan reviews, left out of the clock. */
    reviewMs?: number | undefined
    /** When the build last changed state: the clock stops there once it is ready. */
    endedAt?: string | undefined
  }
  /** What the owner asked for in each build waiting behind this one. */
  queued?: string[]
  /** How long this build's lane usually takes, in seconds; absent says nothing about time. */
  expectedSeconds?: { p50: number; p95: number }
  now?: number
  onStop?: () => void
  stopping?: boolean
  error?: string | null
  /** Open on the Stop question, for the catalog. */
  defaultConfirming?: boolean
}) {
  const stage = BUILD_STAGES[build.state]
  // A ready build's clock stops where it got ready.
  const ended =
    stage.step === 3 && build.endedAt ? Date.parse(build.endedAt) : undefined
  const ran = useElapsed(build.startedAt, ended ?? now)
  // "Built in" is the build's own time: claim to preview_ready less the wait
  // on the owner's plan review. Perf run 2: 6 min 05 s less 16.6 s of review
  // shows 5 min 48 s, which is right.
  const elapsed = ran === null ? null : ran - (build.reviewMs ?? 0)
  // "asking" once Stop is pressed, "kept" once the owner keeps building.
  // A Stop in flight keeps the question on screen, with its buttons
  // disabled, until the build is read again.
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

  const quick = build.lane === "quick"
  const long =
    elapsed !== null &&
    expectedSeconds !== undefined &&
    elapsed > expectedSeconds.p95 * 1000
  const usually = expectedSeconds
    ? quick
      ? `Usually about ${expectedSeconds.p50} seconds.`
      : `Builds usually take ${Math.round(expectedSeconds.p50 / 60)} to ${Math.round(expectedSeconds.p95 / 60)} minutes.`
    : null
  // A quick edit has no stages to walk: one line while it works, the usual note when it waits.
  const note =
    quick && WORKING.has(build.state) ? "Updating your preview." : stage.note
  // A full build walks its steps; one with none, or waiting, shows the stepper and its note.
  const rows = quick ? [] : (build.activity ?? [])
  const steps = rows.length > 0
  const awaiting = build.awaitingReview === true && build.state === "planning"
  const waiting = awaiting && steps

  return (
    <PanelSection title="Working on">
      <div className="flex flex-col gap-3" data-slot="working-on">
        <p className="line-clamp-2 font-medium text-sm">{build.goal}</p>
        {quick || steps ? null : (
          <ol aria-label="Build progress" className="grid grid-cols-4 gap-1">
            {STEPS.map((label, index) => (
              <li
                aria-current={index === stage.step ? "step" : undefined}
                className="flex flex-col gap-1.5"
                key={label}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1 rounded-full transition-colors duration-200 motion-reduce:transition-none",
                    index < stage.step && "bg-primary/45",
                    index === stage.step && "bg-primary",
                    index === stage.step &&
                      WORKING.has(build.state) &&
                      "animate-pulse motion-reduce:animate-none",
                    index > stage.step && "bg-border"
                  )}
                  data-slot="step-bar"
                />
                <span
                  className={cn(
                    "text-[0.8125rem]",
                    index === stage.step
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  {label}
                </span>
              </li>
            ))}
          </ol>
        )}
        {steps ? (
          <BuildSteps
            awaiting={awaiting}
            photos={build.photos}
            plan={build.plan}
            rows={rows}
          />
        ) : (
          <p aria-live="polite" className="text-sm">
            {note}
          </p>
        )}
        {build.fellThrough ? (
          <p className="text-sm" data-slot="fell-through">
            This change needs more than a quick edit, so it will take a few
            minutes.
          </p>
        ) : null}
        <p className={cn(META, "tabular-nums")}>
          {waiting
            ? "The clock waits while you review the plan."
            : ended !== undefined
              ? elapsed === null
                ? null
                : `Built in ${duration(elapsed)}.`
              : [
                  elapsed === null ? null : `${duration(elapsed)} so far.`,
                  long ? "This one is taking longer than usual." : usually,
                ]
                  .filter(Boolean)
                  .join(" ")}
        </p>
        {onStop && STOPPABLE(build.state) ? (
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
        {queued.length ? (
          <ul className="flex flex-col gap-1 border-border border-t pt-2">
            {queued.map((goal, index) => (
              // Goals repeat, so the position is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is only ever replaced whole.
              <li className={cn(META, "line-clamp-1")} key={index}>
                Next: {goal}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </PanelSection>
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

const SHOTS = ["on a phone", "on a tablet", "on a laptop"] as const

/** Screenshots land about 10 s after the preview does; look again every 5 s for half a minute. */
const SHOT_RETRY_MS = 5000
const SHOT_TRIES = 6

/**
 * One width of the home page. Until the image exists it is a quiet block of
 * the same size, never a broken image; a screenshot still missing after the
 * last look tells the caller.
 */
function Shot({
  src,
  alt,
  where,
  onGiveUp,
}: {
  src: string | undefined
  alt: string
  where: string
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
    <div className="relative aspect-[3/4]">
      {loaded ? null : (
        <div
          className="absolute inset-0 rounded-md border border-border bg-muted"
          data-slot="screenshot-pending"
        >
          <span className="sr-only">
            Screenshot {where} is still being made
          </span>
        </div>
      )}
      <img
        alt={alt}
        className={cn(
          "size-full rounded-md border border-border bg-muted object-cover object-top",
          !loaded && "invisible"
        )}
        height={160}
        // A fresh element per look, so the browser asks again.
        key={tries}
        loading="lazy"
        onError={() => setFailed(true)}
        onLoad={() => setLoaded(true)}
        ref={loadedWhenCached(setLoaded)}
        src={src}
        width={120}
      />
    </div>
  )
}

/**
 * The version's home page at three widths. A preview that could not be
 * read says so and can be read again, with no link implied where there is
 * none. Screenshots that fail to load say so, and the preview link beside
 * them still opens the version.
 */
function Screenshots({
  preview,
  onRetry,
}: {
  preview: Preview | "loading" | "error"
  onRetry?: (() => Promise<void>) | undefined
}) {
  // Keyed by the preview, so a fresh read shows its own screenshots.
  const [broken, setBroken] = useState<Preview | null>(null)
  if (preview === "error") {
    return (
      <div className="flex flex-col gap-2">
        <p className={META}>
          The preview isn't available yet. Try again in a moment.
        </p>
        {onRetry ? <Retry onRetry={onRetry} /> : null}
      </div>
    )
  }
  if (preview !== "loading" && broken === preview) {
    return (
      <p className={META}>
        The screenshots did not load. Open the preview to see the new version.
      </p>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-2" data-slot="screenshots">
      {SHOTS.map((where, index) =>
        preview === "loading" ? (
          <Skeleton className="aspect-[3/4] rounded-md" key={where} />
        ) : (
          <Shot
            alt={`Home page ${where}`}
            key={where}
            onGiveUp={() => setBroken(preview)}
            src={preview.screenshots[index]}
            where={where}
          />
        )
      )}
    </div>
  )
}

/**
 * A version ready to publish. What it is bound to sits directly above the
 * buttons that act on it, and Approve sends exactly that revision. "Ask for changes" opens a note in place.
 */
function ApprovalItem({
  target,
  rationale,
  expiresAt,
  onExpiry,
  preview,
  onApprove,
  onAskForChanges,
  onRetryPreview,
  pending: busy = null,
  error = null,
  defaultAsking = false,
  photos = [],
  photoActions,
}: {
  target: ApprovalTarget
  rationale: string
  expiresAt: string
  onExpiry: string
  preview: Preview | "loading" | "error"
  onApprove: (decision: DecisionRequest) => void
  onAskForChanges: (text: string) => void
  /** Reads the preview again after it could not be read. */
  onRetryPreview?: (() => Promise<void>) | undefined
  pending?: "approve" | "change" | null
  error?: string | null
  /** Open on the change note, for the catalog. */
  defaultAsking?: boolean
  /** The pictures the assistant made for this version, to badge and offer changes on. */
  photos?: readonly GeneratedPhoto[]
  photoActions?: PhotoActions | undefined
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
    <article
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 py-3"
      data-slot="approval-item"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-sm" id={`${id}-title`}>
          Your new version is ready to publish
        </h3>
        <p className={META}>{rationale}</p>
      </div>
      <Screenshots onRetry={onRetryPreview} preview={preview} />
      {typeof preview === "object" ? (
        <OutLink href={preview.url}>Open preview</OutLink>
      ) : null}
      {photoActions ? (
        <GeneratedPhotos
          actions={photoActions}
          disabled={busy !== null}
          heroShot={
            typeof preview === "object" ? preview.screenshots[2] : undefined
          }
          photos={photos}
        />
      ) : null}
      <p className={META}>{expiryLine(expiresAt, onExpiry)}</p>
      <ApprovalTargetSummary className="bg-background" target={target} />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!decision || busy !== null}
          onClick={() => {
            if (decision) onApprove(decision)
          }}
          size="sm"
        >
          {pending(busy === "approve", "Approve and publish", "Publishing")}
        </Button>
        <Button
          aria-expanded={asking}
          disabled={busy !== null}
          onClick={() => {
            pressed.current = true
            setOpened(!opened)
          }}
          size="sm"
          variant="outline"
        >
          Ask for changes
        </Button>
      </div>
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
      {error ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  )
}

/* Coming up, your website, first steps -------------------------------- */

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
  blueprint = null,
  onRequestChanges,
}: {
  host: string | null
  /** Where `host` opens, as the api built it (http and a port on local dev). */
  url?: string | null
  live: number | null
  thumbnail?: Thumbnail
  /** The plan the live site was built from, kept under it read-only. */
  blueprint?: Blueprint | null
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
      {blueprint ? (
        <BlueprintCard
          blueprint={blueprint}
          className="my-0 rounded-2xl p-3"
          defaultOpen={false}
          readOnly
        />
      ) : null}
    </div>
  )
}

/* Today ---------------------------------------------------------------- */

/**
 * The panel's opening lines, written by the app from the workspace: one or
 * two short sentences, the first leading and the second quieter. No live
 * region: it changes with every read, and the sections below announce what
 * the owner did.
 */
function PanelDigest({ sentences }: { sentences: string[] }) {
  const [lead, ...rest] = sentences
  if (!lead) return null
  return (
    <div className="flex flex-col gap-0.5" data-slot="panel-digest">
      <p className="text-sm">{lead}</p>
      {rest.map((sentence) => (
        <p className={META} key={sentence}>
          {sentence}
        </p>
      ))}
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
function LiveLine({
  tone,
  lead,
  detail = null,
  progress = null,
}: {
  tone: "working" | "live" | "idle"
  lead: string
  detail?: string | null
  /** How far a build is through its steps, kept in view when the words truncate. */
  progress?: { done: number; total: number } | null
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-2 text-sm"
      data-slot="live-line"
      data-tone={tone}
    >
      {/* Reme, floating and blinking as it does everywhere; while it works a
          halo pulses behind it, and when the work is live the halo holds. */}
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
        <PersonaAvatar className="size-6" sway />
      </span>
      {progress ? (
        // A build's step is the news, so the lead gives way first.
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="min-w-0 truncate font-medium">{lead}</span>
          <span className="shrink-0 text-muted-foreground">{detail}</span>
          <span
            className="shrink-0 text-muted-foreground tabular-nums"
            data-slot="live-line-progress"
          >
            <span aria-hidden>
              {progress.done}/{progress.total}
            </span>
            <span className="sr-only">
              , step {progress.done} of {progress.total}
            </span>
          </span>
        </span>
      ) : (
        <span className="min-w-0 truncate">
          <span className="font-medium">{lead}</span>
          {detail ? (
            <span className="text-muted-foreground"> {detail}</span>
          ) : null}
        </span>
      )}
    </span>
  )
}

/**
 * The panel before there is anything to show: what the team still needs,
 * and the build it leads to. Each step is ticked from the workspace, never
 * from what the owner has clicked.
 */
function PanelBlank({
  steps,
  description = null,
  action = null,
}: {
  steps: { label: string; done: boolean }[]
  /** What to do next, in the words of the steps below it. */
  description?: string | null
  /** Where the next step is taken: a link, from the app. */
  action?: ReactNode
}) {
  return (
    <PanelSection title="First steps">
      {description ? <p className={META}>{description}</p> : null}
      <ul className="flex flex-col gap-1">
        {steps.map((step) => (
          <li className="flex items-center gap-2 text-sm" key={step.label}>
            {step.done ? (
              <CheckCircleIcon
                aria-hidden
                className="size-4 shrink-0 text-primary"
                weight="fill"
              />
            ) : (
              <CircleIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
            )}
            <span className="sr-only">{step.done ? "Done: " : "To do: "}</span>
            {step.label}
          </li>
        ))}
      </ul>
      {action}
    </PanelSection>
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

export type { Preview, Thumbnail }
export {
  AnswerInputs,
  ApprovalItem,
  approvalDecision,
  BUILD_STAGES,
  ComingUp,
  LiveLine,
  NextSteps,
  PanelBlank,
  PanelDigest,
  QuestionItem,
  ReminderList,
  ReminderNote,
  stageWord,
  WaitingOnYou,
  WorkingOn,
  YourWebsite,
}
