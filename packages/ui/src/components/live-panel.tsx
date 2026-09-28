import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleIcon,
} from "@phosphor-icons/react"
import {
  type ApprovalTarget,
  type AssignmentState,
  type DecisionRequest,
  GOAL_MAX,
} from "@workspace/contracts"
import { ApprovalTargetSummary } from "@workspace/ui/components/approval-target"
import { Button } from "@workspace/ui/components/button"
import { Field } from "@workspace/ui/components/field"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  type AnswerSpec,
  answerValue,
  FACT_INPUTS,
  type FactInput,
} from "@workspace/ui/lib/answer"
import { formatDateTime } from "@workspace/ui/lib/format"
import { cn } from "@workspace/ui/lib/utils"
import {
  Children,
  type FormEvent,
  isValidElement,
  type MouseEvent,
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

const META = "text-[0.8125rem] text-muted-foreground"
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
 * Where each build state sits on the stepper, what the owner is told, and
 * whether it is doing work (the bar pulses) or waiting. Every state has a
 * row, so a state added to the contract fails the build until it is placed.
 */
const STAGE = {
  queued: { step: 0, note: "Waiting to start.", running: false },
  briefing: { step: 1, note: "Reading your brief.", running: true },
  planning: { step: 1, note: "Planning the changes.", running: true },
  implementing: { step: 1, note: "Making the changes.", running: true },
  revising: { step: 1, note: "Making your changes.", running: true },
  repairing: { step: 1, note: "Fixing what the checks found.", running: true },
  blocked_on_information: {
    step: 1,
    note: "Waiting on you: answer the question below.",
    running: false,
  },
  paused: { step: 1, note: "Paused. It spends nothing more.", running: false },
  validating: { step: 2, note: "Checking the site.", running: true },
  preview_ready: { step: 3, note: "Ready for you to look at.", running: false },
  awaiting_review: { step: 3, note: "Ready for your review.", running: false },
  blocked_on_approval: {
    step: 3,
    note: "Waiting on you: approve it below.",
    running: false,
  },
  release_candidate: { step: 3, note: "Publishing.", running: true },
  published: { step: 3, note: "Live.", running: false },
  failed: { step: 1, note: "It stopped: the build failed.", running: false },
  cancelled: { step: 0, note: "Stopped.", running: false },
} satisfies Record<
  AssignmentState,
  { step: 0 | 1 | 2 | 3; note: string; running: boolean }
>

/** The states a Stop still means something in. */
const STOPPABLE = (state: AssignmentState) =>
  STAGE[state].step < 3 && state !== "failed" && state !== "cancelled"

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

/**
 * The live stepper: the build the team is on, tied to its real state, with
 * the time it has taken against the measured typical, a Stop, and what is
 * queued behind it. The one bold thing in the panel.
 */
function WorkingOn({
  build,
  queued = [],
  typical,
  now,
  onStop,
  stopping = false,
  error = null,
  defaultConfirming = false,
}: {
  build: {
    goal: string
    state: AssignmentState
    version: number | null
    startedAt: string
  }
  /** What the owner asked for in each build waiting behind this one. */
  queued?: string[]
  /** The measured range a build takes, in seconds. */
  typical: { min: number; max: number }
  now?: number
  onStop?: () => void
  stopping?: boolean
  error?: string | null
  /** Open on the Stop question, for the catalog. */
  defaultConfirming?: boolean
}) {
  const stage = STAGE[build.state]
  const elapsed = useElapsed(build.startedAt, now)
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

  const long = elapsed !== null && elapsed > typical.max * 1000
  const usually = `Builds usually take ${Math.round(typical.min / 60)} to ${Math.round(typical.max / 60)} minutes.`

  return (
    <PanelSection title="Working on">
      <div className="flex flex-col gap-3" data-slot="working-on">
        <p className="line-clamp-2 font-medium text-sm">
          {build.version ? `Version ${build.version}: ` : null}
          {build.goal}
        </p>
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
                    stage.running &&
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
        <p aria-live="polite" className="text-sm">
          {stage.note}
        </p>
        <p className={cn(META, "tabular-nums")}>
          {elapsed === null ? null : `${duration(elapsed)} so far. `}
          {long ? "This one is taking longer than usual." : usually}
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
 * list could not be read and is shown above whatever was read before.
 */
function WaitingOnYou({
  children,
  status = null,
  error = null,
  action = null,
  onRetry,
}: {
  children?: ReactNode
  status?: string | null
  error?: string | null
  /** The owner's next step while nothing waits on them. */
  action?: ReactNode
  /** Read the list again now, offered when it did not load. */
  onRetry?: () => Promise<void>
}) {
  const items = Children.toArray(children).filter(isValidElement)
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
      ) : error ? null : (
        <p className={META}>
          Nothing needs you right now. Questions and approvals from your team
          land here.
        </p>
      )}
      {items.length ? null : error ? (
        onRetry ? (
          <Retry onRetry={onRetry} />
        ) : null
      ) : (
        action
      )}
    </PanelSection>
  )
}

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

function Screenshots({
  preview,
  version,
}: {
  preview: Preview | "loading" | "error"
  version: number
}) {
  if (preview === "error") {
    return (
      <p className={META}>
        The screenshots did not load. Open the preview to see version {version}.
      </p>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-2" data-slot="screenshots">
      {SHOTS.map((where, index) =>
        preview === "loading" ? (
          <Skeleton className="aspect-[3/4] rounded-md" key={where} />
        ) : (
          <img
            alt={`Version ${version}, home page ${where}`}
            className="aspect-[3/4] w-full rounded-md border border-border bg-muted object-cover object-top"
            height={160}
            key={where}
            loading="lazy"
            src={preview.screenshots[index]}
            width={120}
          />
        )
      )}
    </div>
  )
}

/**
 * A version ready to publish. The version and its short id sit directly
 * above the buttons that act on it, and Approve sends exactly that
 * revision. "Ask for changes" opens a note in place.
 */
function ApprovalItem({
  target,
  version,
  rationale,
  expiresAt,
  onExpiry,
  preview,
  onApprove,
  onAskForChanges,
  pending: busy = null,
  error = null,
  defaultAsking = false,
}: {
  target: ApprovalTarget
  version: number
  rationale: string
  expiresAt: string
  onExpiry: string
  preview: Preview | "loading" | "error"
  onApprove: (decision: DecisionRequest) => void
  onAskForChanges: (text: string) => void
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
    <article
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 py-3"
      data-slot="approval-item"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-sm" id={`${id}-title`}>
          Version {version} is ready to publish
        </h3>
        <p className={META}>{rationale}</p>
      </div>
      <Screenshots preview={preview} version={version} />
      {typeof preview === "object" ? (
        <OutLink href={preview.url}>Open preview</OutLink>
      ) : null}
      <p className={META}>{expiryLine(expiresAt, onExpiry)}</p>
      <ApprovalTargetSummary
        className="bg-background"
        target={target}
        version={version}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!decision || busy !== null}
          onClick={() => {
            if (decision) onApprove(decision)
          }}
          size="sm"
        >
          {pending(
            busy === "approve",
            `Approve and publish v${version}`,
            `Publishing v${version}`
          )}
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
            className="min-h-20 w-full rounded-2xl border border-transparent bg-input/50 px-3 py-2 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50 md:text-sm"
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

/** What closes next, soonest first. Nothing renders when nothing is due. */
function ComingUp({
  items,
}: {
  items: { id: string; text: string; at: string }[]
}) {
  if (items.length === 0) return null
  return (
    <PanelSection title="Coming up">
      <ul className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <li className="flex flex-col py-2" key={item.id}>
            <span className="text-sm">{item.text}</span>
            <span className={META}>{formatDateTime(item.at)}</span>
          </li>
        ))}
      </ul>
    </PanelSection>
  )
}

/** One reminder: what needs doing, and where in the panel it is. */
type ReminderRow = {
  id: string
  text: string
  detail?: string | null
  /** `#` and the id of the panel element it points at. */
  href?: string | null
}

/**
 * Focus the element a reminder points at, which scrolls it into view, and
 * leave the address alone. The target carries `tabIndex={-1}`. Without one
 * on the page, the link does what a link does.
 */
function jump(event: MouseEvent<HTMLAnchorElement>) {
  const target = document.getElementById(event.currentTarget.hash.slice(1))
  if (!target) return
  event.preventDefault()
  target.focus()
}

/**
 * What needs the owner soon, in their words, each row linked to the item it
 * is about when the panel shows that item. Nothing renders when there are
 * none.
 */
function Reminders({ items }: { items: ReminderRow[] }) {
  if (items.length === 0) return null
  return (
    <PanelSection title="Reminders">
      <ul className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <li className="flex flex-col py-2" key={item.id}>
            {item.href ? (
              <a
                className="self-start rounded-sm py-0.5 text-sm underline decoration-muted-foreground underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring"
                href={item.href}
                onClick={jump}
              >
                {item.text}
              </a>
            ) : (
              <span className="text-sm">{item.text}</span>
            )}
            {item.detail ? <span className={META}>{item.detail}</span> : null}
          </li>
        ))}
      </ul>
    </PanelSection>
  )
}

/** A screenshot of the live site's home page, or "loading" while it is read. */
type Thumbnail = { src: string } | "loading" | null

/**
 * The site as it stands: the version that is live, and where. The
 * thumbnail is the panel's only image, at a fixed ratio so nothing moves
 * when it arrives; one that fails to load leaves the text alone.
 */
function YourWebsite({
  host,
  live,
  thumbnail = null,
}: {
  host: string | null
  live: number | null
  thumbnail?: Thumbnail
}) {
  const [broken, setBroken] = useState<string | null>(null)
  const shot = live ? thumbnail : null
  return (
    <PanelSection title="Your website">
      {shot === "loading" ? (
        <Skeleton className="aspect-[16/10] w-full rounded-md" />
      ) : shot && shot.src !== broken ? (
        <img
          alt={`Your website's home page on a laptop, version ${live}`}
          className="aspect-[16/10] w-full rounded-md border border-border bg-muted object-cover object-top"
          height={200}
          loading="lazy"
          onError={() => setBroken(shot.src)}
          src={shot.src}
          width={320}
        />
      ) : null}
      <p className="text-sm">
        {live ? `Version ${live} is live.` : "Nothing is published yet."}
      </p>
      {host && live ? <OutLink href={`https://${host}`}>{host}</OutLink> : null}
    </PanelSection>
  )
}

/**
 * The panel before there is anything to show: what the team still needs,
 * and the build it leads to. Each step is ticked from the workspace, never
 * from what the owner has clicked.
 */
function PanelBlank({
  steps,
  description,
  action = null,
}: {
  steps: { label: string; done: boolean }[]
  /** What to do next, in the words of the steps below it. */
  description: string
  /** Where the next step is taken: a link, from the app. */
  action?: ReactNode
}) {
  return (
    <PanelSection title="First steps">
      <p className={META}>{description}</p>
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

export type { Preview, ReminderRow, Thumbnail }
export {
  AnswerInputs,
  ApprovalItem,
  approvalDecision,
  ComingUp,
  PanelBlank,
  QuestionItem,
  Reminders,
  WaitingOnYou,
  WorkingOn,
  YourWebsite,
}
