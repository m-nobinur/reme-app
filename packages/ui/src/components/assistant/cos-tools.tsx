import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import { CaretDownIcon } from "@phosphor-icons/react"
import {
  AnswerQuestionInput,
  AnswerQuestionOutput,
  CosFacts,
  CosWorkspace,
  CreateReminderOutput,
  CreateReminderRequest,
  GetPreviewOutput,
} from "@workspace/contracts"
import { Decision, Done } from "@workspace/ui/components/assistant/decision"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { stageWord } from "@workspace/ui/components/live-panel"
import { factLabel, factText } from "@workspace/ui/lib/facts"
import { refusalText } from "@workspace/ui/lib/refusal"
import {
  decisionView,
  type ReadView,
  readView,
} from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import {
  browserZone,
  wallText,
  zonedText,
  zoneLabel,
} from "@workspace/ui/lib/zone"
import { createContext, type ReactNode, useContext } from "react"

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
  // A read the stream left running is over once its message is: it says
  // it stopped rather than shimmering on.
  const running = useAuiState((s) => s.message.status?.type === "running")
  if (view.state !== "done") {
    const working = view.state === "working" && running
    const text = working
      ? labels.working
      : view.state === "working" || view.state === "cancelled"
        ? labels.cancelled
        : labels.failed
    return (
      <p
        className={cn(
          "px-1 py-1.5 text-muted-foreground text-sm",
          working && "shimmer motion-reduce:animate-none"
        )}
        data-slot={slot}
        role={working ? "status" : undefined}
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

/** An instant on the owner's clock, with its zone named. */
const useOwnerTime = () => {
  const { zone } = useCosTools()
  return (at: string) => `${zonedText(at, zone) ?? at} ${zoneLabel(zone)}`
}

const WorkspaceRead: ToolCallMessagePartComponent = (props) => {
  const time = useOwnerTime()
  return (
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
                        A question about{" "}
                        {factLabel(question.field).toLowerCase()}
                      </li>
                    ))}
                    {workspace.approvals.map((approval) => (
                      <li key={approval.version}>
                        Version {approval.version} to review by{" "}
                        {time(approval.expires_at)}
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
}

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
  const time = useOwnerTime()
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
            Open until {time(output.expires_at)}. It shows under Your website.
          </p>
        ) : (
          <p className="text-sm">
            {refusalText(output.error.code, "There is no preview to check.")}
          </p>
        )
      }
    </Read>
  )
}

/* Decisions ------------------------------------------------------------- */

/**
 * What the cards need from the app: the owner's zone, which is the one each
 * turn carries, and the open question a request id names. Without a
 * provider there is no question to find, so no answer is offered a yes.
 */
type CosTools = {
  zone: string
  /** The open question's title, or null when the workspace has no such question. */
  question: (requestId: string) => string | null
}

const CosToolsContext = createContext<CosTools | null>(null)

/** Gives the Chief of Staff's cards the owner's zone and open questions. */
export const CosToolsProvider = CosToolsContext.Provider

function useCosTools(): CosTools {
  return (
    useContext(CosToolsContext) ?? {
      zone: browserZone(),
      question: () => null,
    }
  )
}

/** An answer as the owner reads it: a fact with its label, or their words. */
const answerText = ({ value }: AnswerQuestionInput) =>
  typeof value === "string"
    ? value
    : `${factLabel(value.key)}: ${factText(value.key, value.value)}`

const AnswerQuestion: ToolCallMessagePartComponent = (props) => {
  const { question } = useCosTools()
  return (
    <Decision
      // A steered model could aim the owner's words at another request, so
      // the card names the question it answers, and offers no yes when the
      // workspace holds no such open question.
      blocked={(input) =>
        question(input.request_id)
          ? null
          : "This answers a question that is no longer open, so it cannot be sent."
      }
      busy="Sending"
      cancelled="Not sent. You sent a message instead."
      refused="The answer could not be sent."
      detail={(input) => {
        const asked = question(input.request_id)
        return asked
          ? `This answers your build's question: ${asked}.`
          : "This answers a question."
      }}
      done={() => <Done>Sent. Your build carries on.</Done>}
      props={props}
      slot="answer-question"
      title={answerText}
      view={decisionView(props, AnswerQuestionInput, AnswerQuestionOutput)}
      yes="Send answer"
    />
  )
}

const CreateReminder: ToolCallMessagePartComponent = (props) => {
  const { zone } = useCosTools()
  // Before the yes, the digits the model wrote, which the api reads as the
  // owner's wall time; after it, the stored instant on the owner's clock.
  const due = (text: string | null) =>
    text ? `Due ${text} ${zoneLabel(zone)}` : "No date set"
  return (
    <Decision
      busy="Adding"
      cancelled="Not added. You sent a message instead."
      refused="The reminder could not be added."
      detail={(input) =>
        `${due(input.due_at ? wallText(input.due_at) : null)}. It shows under Reminders.`
      }
      done={(output) =>
        output?.outcome === "created" && output.due_at ? (
          <Done>
            Added to Reminders. {due(zonedText(output.due_at, zone))}.
          </Done>
        ) : (
          <Done>Added to Reminders.</Done>
        )
      }
      props={props}
      slot="create-reminder"
      title={(input) => input.title}
      view={decisionView(props, CreateReminderRequest, CreateReminderOutput)}
      yes="Add reminder"
    />
  )
}

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
