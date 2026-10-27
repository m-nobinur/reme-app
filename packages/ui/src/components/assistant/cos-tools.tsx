import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import {
  AnswerQuestionInput,
  AnswerQuestionOutput,
  CheckDomainInput,
  CheckDomainOutput,
  CosFacts,
  CosWorkspace,
  CreateReminderOutput,
  CreateReminderRequest,
  GetPreviewOutput,
  RecordReviewInput,
  RecordReviewOutput,
} from "@workspace/contracts"
import {
  BuyDomain,
  FindDomain,
} from "@workspace/ui/components/assistant/buy-domain"
import { Decision, Done } from "@workspace/ui/components/assistant/decision"
import {
  ConnectDomain,
  domainStatusText,
  RemoveDomain,
} from "@workspace/ui/components/assistant/domain"
import { ConnectGoogle } from "@workspace/ui/components/assistant/google"
import { StatusLine, ToolStatus } from "@workspace/ui/components/status-line"
import { type ToolArgs, toolKind } from "@workspace/ui/lib/activity-copy"
import { factLabel, factText } from "@workspace/ui/lib/facts"
import { formatDateTime } from "@workspace/ui/lib/format"
import { refusalText } from "@workspace/ui/lib/refusal"
import {
  decisionView,
  type ReadView,
  readView,
} from "@workspace/ui/lib/tool-state"
import { browserZone, wallText, zoneLabel } from "@workspace/ui/lib/zone"
import { createContext, useContext } from "react"

/**
 * The Chief of Staff's tools, in the owner's words. A read is one quiet
 * status line; the reply says what it found. A tool
 * that acts waits for the owner's yes on a card that names exactly what it
 * will do. No tool name, id or raw output reaches the screen, and the api's
 * error text, which is written for the model, never does either.
 */

/* Reads ----------------------------------------------------------------- */

/**
 * The few words the model wrote for what a read is doing, which the api
 * cleaned before the call was stored.
 */
const stepOf = ({ args }: { args: unknown }) => {
  const { step } = (args ?? {}) as { step?: unknown }
  return typeof step === "string" ? step : undefined
}

/** One read: its own few words, or the copy table's, while it runs, then nothing, since the reply says what it found. */
function Read<O>({
  view,
  tool,
  args,
  step,
  slot,
}: {
  view: ReadView<O>
  tool: string
  args?: ToolArgs
  step?: string | undefined
  slot: string
}) {
  // A read the stream left running is over once its message is.
  const running = useAuiState((s) => s.message.status?.type === "running")
  if (view.state === "done") return null
  const state =
    view.state === "working" && running
      ? "working"
      : view.state === "failed"
        ? "failed"
        : "stopped"
  const line = {
    className: "flex px-1 py-1.5 text-chat-step",
    "data-slot": slot,
    delay: state === "working" ? undefined : 0,
    state,
  } as const
  return step && state === "working" ? (
    <StatusLine {...line} kind={toolKind(tool)} label={step} />
  ) : (
    <ToolStatus {...line} args={args} tool={tool} />
  )
}

const WorkspaceRead: ToolCallMessagePartComponent = (props) => (
  <Read
    slot="cos-read-workspace"
    step={stepOf(props)}
    tool="get_workspace"
    view={readView(props, CosWorkspace)}
  />
)

const FactsRead: ToolCallMessagePartComponent = (props) => (
  <Read
    slot="cos-read-facts"
    step={stepOf(props)}
    tool="get_facts"
    view={readView(props, CosFacts)}
  />
)

const PreviewRead: ToolCallMessagePartComponent = (props) => (
  <Read
    slot="cos-read-preview"
    step={stepOf(props)}
    tool="get_preview"
    view={readView(props, GetPreviewOutput)}
  />
)

/**
 * Where a domain stands, as one plain sentence: a domain check is quick and
 * the assistant says what to do, so there is nothing to open.
 */
const DomainRead: ToolCallMessagePartComponent = (props) => {
  const view = readView(props, CheckDomainOutput)
  // The step is not part of the question the owner asked.
  const { step: _step, ...asking } = props.args
  const asked = CheckDomainInput.safeParse(asking).data?.name
  const name = asked ?? "Your domain"
  if (view.state === "done") {
    return (
      <p
        className="px-1 py-1.5 text-chat-step text-muted-foreground"
        data-slot="cos-read-domain"
      >
        {view.output.outcome === "checked"
          ? domainStatusText(name, view.output)
          : refusalText(
              view.output.error.code,
              "I couldn't check that domain."
            )}
      </p>
    )
  }
  return (
    <Read
      args={asked ? { domain: asked } : {}}
      slot="cos-read-domain"
      step={stepOf(props)}
      tool="check_domain"
      view={view}
    />
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
      cancelled="Not sent."
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
      cancelled="Not added."
      refused="The reminder could not be added."
      detail={(input) =>
        `${due(input.due_at ? wallText(input.due_at) : null)}. It shows under Reminders.`
      }
      done={(output) =>
        output?.outcome === "created" && output.due_at ? (
          <Done>
            Added to Reminders. {due(formatDateTime(output.due_at, zone))}.
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

// The owner's yes is their word that the customer agreed, so the card asks
// exactly that, and the button says it.
const RecordReview: ToolCallMessagePartComponent = (props) => (
  <Decision
    busy="Saving"
    cancelled="Not saved."
    refused="The review could not be saved."
    detail={(input) =>
      // A name that ends in a dot (an initial) already closes the sentence.
      `From ${input.name}${input.name.endsWith(".") ? "" : "."} Only say yes if ${input.name} agreed to be quoted on your website under that name. It becomes review ${input.slot}, replacing any review there.`
    }
    done={() => (
      <Done>Saved. Your website can show it from its next update.</Done>
    )}
    props={props}
    slot="record-review"
    title={(input) => `"${input.quote}"`}
    view={decisionView(props, RecordReviewInput, RecordReviewOutput)}
    yes="They agreed, save it"
  />
)

/**
 * Tools that show nothing in the thread: the chat tells the owner what was
 * remembered on the next reply, as a chip, so no tool card is drawn.
 */
export const COS_QUIET: Record<string, ToolCallMessagePartComponent> = {
  remember: () => null,
}

/** The reads, which the thread may fold together, by tool name. */
export const COS_READS: Record<string, ToolCallMessagePartComponent> = {
  get_workspace: WorkspaceRead,
  get_facts: FactsRead,
  get_preview: PreviewRead,
  check_domain: DomainRead,
}

/** The Chief of Staff's cards that wait on the owner, by tool name. */
export const COS_CARDS: Record<string, ToolCallMessagePartComponent> = {
  answer_question: AnswerQuestion,
  create_reminder: CreateReminder,
  record_review: RecordReview,
  connect_domain: ConnectDomain,
  remove_domain: RemoveDomain,
  connect_google: ConnectGoogle,
  find_domain: FindDomain,
  buy_domain: BuyDomain,
}
