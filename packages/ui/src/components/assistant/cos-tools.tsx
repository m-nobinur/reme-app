import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  useAuiState,
} from "@assistant-ui/react"
import {
  CaretDownIcon,
  CheckCircleIcon,
  ProhibitIcon,
  SealQuestionIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import {
  AnswerQuestionInput,
  AnswerQuestionOutput,
  CosFacts,
  CosWorkspace,
  CreateReminderOutput,
  CreateReminderRequest,
  GetPreviewOutput,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { stageWord } from "@workspace/ui/components/live-panel"
import { useRevealWaiting } from "@workspace/ui/hooks/use-reveal-waiting"
import { factLabel, factText } from "@workspace/ui/lib/facts"
import { formatDateTime } from "@workspace/ui/lib/format"
import {
  BROKEN,
  type DecisionView,
  decisionView,
  heldText,
  isHeld,
  NOT_DONE,
  type ReadView,
  readView,
  UNCONFIRMED,
} from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { type ReactNode, useId } from "react"

/**
 * The Chief of Staff's tools, in the owner's words. A read is one quiet line
 * that opens onto what it found, drawn as the panel draws its lists. A tool
 * that acts waits for the owner's yes on a card that names exactly what it
 * will do. No tool name, id or raw output reaches the screen, and the api's
 * error text, which is written for the model, never does either.
 */

const META = "text-[0.8125rem] text-muted-foreground"

/* Reads ----------------------------------------------------------------- */

type ReadLabels = {
  working: string
  done: string
  failed: string
  cancelled: string
}

/** One read: a line while it runs, then a line that opens onto its findings. */
function Read<O>({
  view,
  labels,
  slot,
  children,
}: {
  view: ReadView<O>
  labels: ReadLabels
  slot: string
  children: (output: O) => ReactNode
}) {
  if (view.state !== "done") {
    const text =
      view.state === "working"
        ? labels.working
        : view.state === "cancelled"
          ? labels.cancelled
          : labels.failed
    return (
      <p
        className={cn(
          "px-1 py-1.5 text-muted-foreground text-sm",
          view.state === "working" && "shimmer motion-reduce:animate-none"
        )}
        data-slot={slot}
        role={view.state === "working" ? "status" : undefined}
      >
        {text}
      </p>
    )
  }
  return (
    <Collapsible data-slot={slot}>
      <CollapsibleTrigger className="group/read flex items-center gap-1.5 rounded-lg px-1 py-1.5 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring">
        {labels.done}
        <CaretDownIcon
          aria-hidden
          className="size-3.5 -rotate-90 transition-transform duration-150 group-data-panel-open/read:rotate-0 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="ps-1 pb-2">
        {children(view.output)}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Label and value rows, separated by hairlines like the panel's lists. */
function Rows({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="flex max-w-md flex-col divide-y divide-border text-sm">
      {rows.map(({ label, value }) => (
        <div className="flex flex-col gap-0.5 py-2" key={label}>
          <dt className={META}>{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const WorkspaceRead: ToolCallMessagePartComponent = (props) => (
  <Read
    labels={{
      working: "Checking your workspace",
      done: "Checked your workspace",
      failed: "Could not check your workspace",
      cancelled: "Stopped checking your workspace",
    }}
    slot="cos-read-workspace"
    view={readView(props, CosWorkspace)}
  >
    {(workspace) => (
      <Rows
        rows={[
          {
            label: "Your website",
            value: workspace.site.live_version
              ? `Version ${workspace.site.live_version} is live`
              : "Not published yet",
          },
          {
            label: "Working on",
            value: workspace.builds.length ? (
              <ul className="flex flex-col gap-1">
                {workspace.builds.map((build) => (
                  <li className="flex flex-col" key={build.assignment_id}>
                    <span>{build.goal}</span>
                    <span className={META}>{stageWord(build.state)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              "Nothing"
            ),
          },
          {
            label: "Waiting on you",
            value:
              workspace.questions.length || workspace.approvals.length ? (
                <ul className="flex flex-col gap-1">
                  {workspace.questions.map((question) => (
                    <li key={question.request_id}>
                      A question about {factLabel(question.field).toLowerCase()}
                    </li>
                  ))}
                  {workspace.approvals.map((approval) => (
                    <li key={approval.version}>
                      Version {approval.version} to review by{" "}
                      {formatDateTime(approval.expires_at)}
                    </li>
                  ))}
                </ul>
              ) : (
                "Nothing"
              ),
          },
          ...(workspace.missing_facts.length
            ? [
                {
                  label: "Details still to give",
                  value: workspace.missing_facts.map(factLabel).join(", "),
                },
              ]
            : []),
        ]}
      />
    )}
  </Read>
)

const FactsRead: ToolCallMessagePartComponent = (props) => (
  <Read
    labels={{
      working: "Reading your business details",
      done: "Read your business details",
      failed: "Could not read your business details",
      cancelled: "Stopped reading your business details",
    }}
    slot="cos-read-facts"
    view={readView(props, CosFacts)}
  >
    {({ facts }) =>
      facts.length ? (
        <Rows
          rows={facts.map((fact) => ({
            label: factLabel(fact.key),
            value: factText(fact.key, fact.value),
          }))}
        />
      ) : (
        <p className={META}>No details saved yet.</p>
      )
    }
  </Read>
)

const PreviewRead: ToolCallMessagePartComponent = (props) => {
  const view = readView(props, GetPreviewOutput)
  return (
    <Read
      labels={{
        working: "Checking the preview",
        done:
          view.state === "done" && view.output.outcome === "ready"
            ? `Checked the preview of version ${view.output.version}`
            : "Checked for a preview",
        failed: "Could not check the preview",
        cancelled: "Stopped checking the preview",
      }}
      slot="cos-read-preview"
      view={view}
    >
      {(output) =>
        output.outcome === "ready" ? (
          <p className="text-sm">
            Open until {formatDateTime(output.expires_at)}. It shows under Your
            website.
          </p>
        ) : (
          <p className="text-sm">{output.error.message}</p>
        )
      }
    </Read>
  )
}

/* Decisions ------------------------------------------------------------- */

type Settled<I, O> = Extract<DecisionView<I, O>, { state: "done" }>

/**
 * A card that waits for the owner's yes. The target stays on screen in every
 * state. Never optimistic: after a tap the buttons wait for the server, and
 * a held answer says it has not been sent while another card in its step
 * still waits.
 */
function Decision<I, O>({
  slot,
  view,
  props,
  title,
  detail,
  yes,
  busy,
  outcome,
}: {
  slot: string
  view: DecisionView<I, O>
  props: ToolCallMessagePartProps
  title: (input: I) => string
  detail: (input: I) => string
  yes: string
  busy: string
  outcome: (settled: Settled<I, O>) => ReactNode
}) {
  const id = useId()
  const held = useAuiState((s) => isHeld(s.message.parts, props.toolCallId))
  useRevealWaiting(view.state === "asking")
  const deciding = view.state === "asking" || view.state === "responding"
  const input = "input" in view ? view.input : null

  if (view.state === "drafting" || view.state === "broken") {
    return (
      <p
        className={cn(
          "px-1 py-1.5 text-muted-foreground text-sm",
          view.state === "drafting" && "shimmer motion-reduce:animate-none"
        )}
        data-slot={slot}
        role={view.state === "drafting" ? "status" : undefined}
      >
        {view.state === "drafting" ? "Writing this out" : BROKEN}
      </p>
    )
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        "my-3 flex max-w-md flex-col gap-2",
        deciding && "rounded-2xl border border-border bg-card p-4"
      )}
      data-slot={slot}
    >
      {deciding ? (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <SealQuestionIcon aria-hidden className="size-4 text-primary" />
          Needs your yes
        </p>
      ) : null}
      <h3 className="break-words font-medium" id={`${id}-title`}>
        {input ? title(input) : "Something the assistant asked for"}
      </h3>
      {input && deciding ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          {detail(input)}
        </p>
      ) : null}
      {deciding ? (
        held && view.state === "responding" ? (
          // Answered while another card in the step waits: the answer is
          // recorded and nothing is running, so no buttons, only the answer.
          <p className={META} role="status">
            {heldText(view.approved)}
          </p>
        ) : (
          <div aria-busy={view.state === "responding"} className="flex gap-2">
            <Button
              disabled={view.state === "responding"}
              onClick={() => props.respondToApproval({ approved: true })}
              size="sm"
              type="button"
            >
              {view.state === "responding" && view.approved ? busy : yes}
            </Button>
            <Button
              disabled={view.state === "responding"}
              onClick={() => props.respondToApproval({ approved: false })}
              size="sm"
              type="button"
              variant="outline"
            >
              Not now
            </Button>
          </div>
        )
      ) : view.state === "done" ? (
        outcome(view)
      ) : (
        <Ended state={view.state} />
      )}
    </section>
  )
}

/** A decision that ended without an output. */
function Ended({
  state,
}: {
  state: "denied" | "cancelled" | "unconfirmed" | "failed"
}) {
  if (state === "denied") {
    return (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <ProhibitIcon aria-hidden className="size-4 shrink-0" />
        You said not now.
      </p>
    )
  }
  if (state === "cancelled") {
    return <p className={META}>Not done. You sent a message instead.</p>
  }
  return <Problem text={state === "unconfirmed" ? UNCONFIRMED : NOT_DONE} />
}

function Problem({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-destructive text-sm">
      <WarningCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      {text}
    </p>
  )
}

function Done({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <CheckCircleIcon aria-hidden className="size-4 shrink-0 text-primary" />
      {children}
    </p>
  )
}

/** An answer as the owner reads it: a fact with its label, or their words. */
const answerText = ({ value }: AnswerQuestionInput) =>
  typeof value === "string"
    ? value
    : `${factLabel(value.key)}: ${factText(value.key, value.value)}`

const AnswerQuestion: ToolCallMessagePartComponent = (props) => (
  <Decision
    busy="Sending"
    detail={() => "This answers the question your build is waiting on."}
    outcome={({ output }) =>
      output.outcome === "answered" ? (
        <Done>Sent. Your build carries on.</Done>
      ) : (
        <Problem text={output.error.message} />
      )
    }
    props={props}
    slot="answer-question"
    title={answerText}
    view={decisionView(props, AnswerQuestionInput, AnswerQuestionOutput)}
    yes="Send answer"
  />
)

const due = (at: string | null) =>
  at ? `Due ${formatDateTime(at)}` : "No date set"

const CreateReminder: ToolCallMessagePartComponent = (props) => (
  <Decision
    busy="Adding"
    detail={(input) => `${due(input.due_at)}. It shows under Reminders.`}
    outcome={({ output }) =>
      output.outcome === "created" ? (
        <Done>Added to Reminders. {due(output.due_at)}.</Done>
      ) : (
        <Problem text={output.error.message} />
      )
    }
    props={props}
    slot="create-reminder"
    title={(input) => input.title}
    view={decisionView(props, CreateReminderRequest, CreateReminderOutput)}
    yes="Add reminder"
  />
)

/** The reads, which the thread may fold together, by tool name. */
export const COS_READS: Record<string, ToolCallMessagePartComponent> = {
  get_workspace: WorkspaceRead,
  get_facts: FactsRead,
  get_preview: PreviewRead,
}

/** The Chief of Staff's cards that wait on the owner, by tool name. */
export const COS_CARDS: Record<string, ToolCallMessagePartComponent> = {
  answer_question: AnswerQuestion,
  create_reminder: CreateReminder,
}
