import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  type ThreadSuggestion,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { CopyIcon } from "@phosphor-icons/react"
import { Approval } from "@workspace/ui/components/assistant/approval"
import {
  OWNER_QUICK_ACTIONS,
  Thread,
  type ThreadMode,
  type ThreadProps,
} from "@workspace/ui/components/assistant/thread"
import { TooltipIconButton } from "@workspace/ui/components/assistant/tooltip-icon-button"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import {
  ConversationMenu,
  WorkspaceShell,
} from "@workspace/ui/components/workspace-shell"
import { FACT_INPUTS } from "@workspace/ui/lib/answer"
import { useState } from "react"

/**
 * The chat surface's catalog entries. They live apart from the rest because
 * every assistant component reads a thread runtime, and one fixture thread per
 * entry is what puts each of them in the context it actually renders in.
 *
 * Everything here is invented, and it names no organisation: a tool call in a
 * catalog carries the same arguments a real one does, and the tenant is never
 * one of them (R3).
 */

/** A thread over fixed messages. Nothing sends; the composer is disabled. */
// Tall enough that nothing scrolls: the viewport pins to the bottom of the
// conversation, so a box shorter than its content hides the states above.
//
// "Tall enough" needs slack, not a snug fit. Each height here used to be tuned
// to the pixel, and at a snug fit the viewport overflows for one layout pass
// while text and icons settle. That is enough for it to latch "not at the
// bottom", which shows the scroll-to-bottom button, and the state never
// re-evaluates: these threads are mounted off screen on a long page, where the
// viewport's observers do not run. So the button's visibility came out
// path-dependent, stable within a run and different between runs, and the
// snapshots recorded whichever state that run happened to reach. It failed
// under load because a slow paint changes which entries are painted while off
// screen. `catalog.spec.ts` now asserts no scroll-to-bottom button is visible,
// so a height that is too tight fails with that message rather than flaking.
function FixtureThread({
  height = "h-[48rem]",
  messages,
  settings,
  suggestions,
  isDisabled = true,
  isRunning = false,
  isLoading = false,
  bare = false,
}: {
  height?: string
  /** No box of its own, for a thread that sits in the workspace frame. */
  bare?: boolean
  messages: ThreadMessageLike[]
  settings?: Omit<ThreadProps, "components" | "autoFocus">
  suggestions?: ThreadSuggestion[]
  isDisabled?: boolean
  isRunning?: boolean
  isLoading?: boolean
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    isDisabled,
    isLoading,
    isRunning,
    messages,
    onNew: noop,
    suggestions,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        className={
          bare
            ? height
            : `${height} overflow-hidden rounded-3xl border border-border`
        }
      >
        <Thread
          autoFocus={false}
          components={{ ToolFallback: Approval }}
          {...settings}
        />
      </div>
    </AssistantRuntimeProvider>
  )
}

/**
 * The composer's surroundings as the owner app sets them: the business on the
 * chip, the mode, and the "+" starters. Brightclean is a fixture business.
 */
const CONTEXT = { name: "Brightclean", status: "site live on v3", live: true }
const SUGGESTIONS: ThreadSuggestion[] = [
  { prompt: "What changed in version 4?" },
  { prompt: "What do you need from me?" },
  { prompt: "What is on my website now?" },
]

/** A thread whose mode chip works, the way the app holds it. */
function OwnerThread(props: Parameters<typeof FixtureThread>[0]) {
  const [mode, setMode] = useState<ThreadMode>("act")
  return (
    <FixtureThread
      {...props}
      settings={{
        context: CONTEXT,
        mode,
        onModeChange: setMode,
        placeholder: "Ask, or tell me what to change",
        quickActions: OWNER_QUICK_ACTIONS,
        ...props.settings,
      }}
    />
  )
}

/** Stored messages carry the day they were written; the runtime's own date is render time. */
const on = (at: string, message: ThreadMessageLike): ThreadMessageLike => ({
  ...message,
  metadata: { custom: { createdAt: `2026-09-${at}Z` } },
})

const noop = async () => undefined

const ask = (text: string): ThreadMessageLike => ({
  content: [{ text, type: "text" }],
  role: "user",
})

const PUBLISH_TARGET = {
  changes: 3,
  domain: "example.com",
  revision: "rev_2f41c9",
}

/**
 * A tool call in each state the runtime can leave one in. The part's status is
 * the message's while it has no result, which is why each state needs its own
 * message rather than four parts in one.
 */
const TOOL_STATES = {
  cancelled: { reason: "cancelled", type: "incomplete" },
  complete: { reason: "stop", type: "complete" },
  failed: {
    error: "The facts store did not answer in time.",
    reason: "error",
    type: "incomplete",
  },
  running: { type: "running" },
} as const

const toolCall = (state: keyof typeof TOOL_STATES): ThreadMessageLike => ({
  content: [
    { text: `The ${state} call:`, type: "text" },
    {
      args: { window: "last_7_days" },
      result:
        state === "complete"
          ? { assignmentsClosed: 3, enquiriesAnswered: 11 }
          : undefined,
      toolCallId: `call_${state}`,
      toolName: "read_week",
      type: "tool-call",
    },
  ],
  role: "assistant",
  status: TOOL_STATES[state],
})

const approvalCall = (approved: boolean | undefined): ThreadMessageLike => ({
  content: [
    {
      approval: {
        approved,
        id: "approval_publish_revision",
        reason: "Publishing a revision changes what visitors see.",
      },
      args: PUBLISH_TARGET,
      result: approved ? { published: true } : undefined,
      toolCallId: "call_publish_revision",
      toolName: "publish_revision",
      type: "tool-call",
    },
  ],
  role: "assistant",
  status:
    approved === undefined
      ? { reason: "tool-calls", type: "requires-action" }
      : { reason: "stop", type: "complete" },
})

/**
 * Onboarding's two tools in every state they reach. Brightclean is the
 * fixture business; the number is in Ofcom's drama range.
 */
const CANCELLED_TEXT = "User cancelled tool call by sending a new message."
const DONE = { reason: "stop", type: "complete" } as const
const WAITING = { reason: "tool-calls", type: "requires-action" } as const

const askFact = (
  key: string,
  extra: {
    result?: unknown
    isError?: boolean
    skippable?: boolean
    prefill?: unknown
  } = {}
) => ({
  args: {
    key,
    prefill: (extra.prefill ?? null) as null,
    skippable: extra.skippable ?? false,
  },
  isError: extra.isError,
  result: extra.result,
  toolCallId: `ask_${key}_${extra.isError ? "error" : extra.result ? "done" : "open"}`,
  toolName: "ask_fact",
  type: "tool-call" as const,
})

const stated = (key: string, value: object) => ({
  result: { answer: "stated", fact: { key, value } },
})

const ASK_FACT_STATES: ThreadMessageLike[] = [
  {
    content: [
      askFact(
        "business.name",
        stated("business.name", { name: "Brightclean" })
      ),
      askFact(
        "business.phone",
        stated("business.phone", { e164: "+447700900123" })
      ),
      askFact("pricing.standard_clean_hourly", {
        result: { answer: "skipped" },
        skippable: true,
      }),
      askFact("hours.weekday", {
        isError: true,
        result: { error: CANCELLED_TEXT },
      }),
      askFact("business.email", {
        isError: true,
        result: {
          error: "This step did not come through. Reload the conversation.",
        },
      }),
    ],
    role: "assistant",
    status: DONE,
  },
  {
    content: [askFact("business.name", { prefill: { name: "Brightclean" } })],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [askFact("pricing.standard_clean_hourly", { skippable: true })],
    role: "assistant",
    status: WAITING,
  },
]

const ONBOARDING_GOAL = "Build my website from the details I gave you."
const BUILD_AT = "2026-09-27T10:00:00.000Z"

const requestChange = (
  id: string,
  text: string,
  extra: {
    approved?: boolean
    result?: unknown
    isError?: boolean
    approval?: false
  } = {}
): ThreadMessageLike => ({
  content: [
    {
      ...(extra.approval === false
        ? {}
        : { approval: { approved: extra.approved, id: `approval_${id}` } }),
      args: { text },
      isError: extra.isError,
      result: extra.result,
      toolCallId: `call_${id}`,
      toolName: "request_change",
      type: "tool-call",
    },
  ],
  role: "assistant",
  status:
    extra.result === undefined && !extra.isError
      ? extra.approved === undefined
        ? WAITING
        : { type: "running" }
      : DONE,
})

const build = (revision: object | null) => ({
  outcome: "started",
  build: {
    assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
    created_at: BUILD_AT,
    goal: ONBOARDING_GOAL,
    kind: "site.build",
    revision,
    state: "queued",
    updated_at: BUILD_AT,
  },
})

const REQUEST_CHANGE_STATES: ThreadMessageLike[] = [
  requestChange("requested", ONBOARDING_GOAL),
  requestChange("responding", "Add Saturday hours, 9 to 1.", {
    approved: true,
  }),
  requestChange("started", ONBOARDING_GOAL, {
    approved: true,
    result: build(null),
  }),
  requestChange("started_version", "Make the hero say we cover Leeds.", {
    approved: true,
    result: build({
      revision_id: "9c3e1f2a-4b5d-4e6f-8a7b-1c2d3e4f5a6b",
      version: 4,
    }),
  }),
  requestChange("refused", "Change the phone number on the contact page.", {
    approved: true,
    result: {
      error: {
        class: "validation",
        code: "change.question_open",
        detail: { assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e" },
        message: "A build is waiting on your answer. Answer it first.",
      },
      outcome: "refused",
    },
  }),
  requestChange("denied", "Add Saturday hours, 9 to 1.", {
    approved: false,
    isError: true,
    result: { error: "Tool approval denied" },
  }),
  requestChange("cancelled", "Swap the hero photo.", {
    approval: false,
    isError: true,
    result: { error: CANCELLED_TEXT },
  }),
  requestChange("error", "Swap the hero photo.", {
    approval: false,
    isError: true,
    result: {
      error: "This step did not come through. Reload the conversation.",
    },
  }),
]

/** A new owner's onboarding, two answers in and waiting on the third. */
const ONBOARDING: ThreadMessageLike[] = [
  on("27T09:00:00.000", {
    content: [
      askFact(
        "business.name",
        stated("business.name", { name: "Brightclean" })
      ),
      askFact(
        "business.phone",
        stated("business.phone", { e164: "+447700900123" })
      ),
      askFact("hours.weekday", {}),
    ],
    role: "assistant",
    status: WAITING,
  }),
]

/** Every fact's native inputs, as a question and the transcript both use them. */
function AnswerInputsSample() {
  return (
    <div className="grid max-w-md gap-6">
      {FACT_KEYS.map((key) => (
        <form key={key} noValidate>
          <AnswerInputs
            id={`sample-${key.replace(".", "-")}`}
            invalid={false}
            prefill={key === "business.name" ? { name: "Brightclean" } : null}
            spec={{ kind: "fact", key }}
            title={FACT_INPUTS[key].ask}
          />
        </form>
      ))}
    </div>
  )
}

const FACT_KEYS = Object.keys(FACT_INPUTS) as (keyof typeof FACT_INPUTS)[]

const REASONING_ONE: ThreadMessageLike[] = [
  ask("Anything blocked?"),
  {
    content: [
      {
        text: "One assignment is waiting on a decision, so that is the only thing worth raising.",
        type: "reasoning",
      },
      { text: "One thing is waiting on you.", type: "text" },
    ],
    role: "assistant",
    status: { reason: "stop", type: "complete" },
  },
]

const REASONING_MANY: ThreadMessageLike[] = [
  ask("Anything blocked?"),
  {
    content: [
      { text: "Three assignments closed this week.", type: "reasoning" },
      {
        text: "One is waiting on a decision from the owner.",
        type: "reasoning",
      },
      { text: "One thing is waiting on you.", type: "text" },
    ],
    role: "assistant",
    status: { reason: "stop", type: "complete" },
  },
]

const TOOL_GROUP: ThreadMessageLike[] = [
  ask("What happened this week?"),
  {
    content: [
      {
        args: {},
        result: { assignmentsClosed: 3 },
        toolCallId: "call_a",
        toolName: "read_week",
        type: "tool-call",
      },
      {
        args: {},
        result: { enquiries: 11 },
        toolCallId: "call_b",
        toolName: "read_enquiries",
        type: "tool-call",
      },
      { text: "Three closed, eleven answered.", type: "text" },
    ],
    role: "assistant",
    status: { reason: "stop", type: "complete" },
  },
]

const MARKDOWN: ThreadMessageLike[] = [
  ask("Show me everything you can render."),
  {
    content: [
      {
        text: `## The week

Three assignments closed and **one** is waiting on you. See the [revision](#).

| Assignment | State |
| --- | --- |
| Service areas | Closed |
| Opening hours | Waiting |

1. Corrected the service-area list.
2. Corrected two opening hours.

> Nothing was published without you.

Set with \`revision: rev_2f41c9\`.

\`\`\`json
{ "revision": "rev_2f41c9" }
\`\`\``,
        type: "text",
      },
    ],
    role: "assistant",
    status: { reason: "stop", type: "complete" },
  },
]

const CONVERSATION: ThreadMessageLike[] = [
  on("24T09:30:00", ask("Is the Saturday change live?")),
  on("24T09:31:00", {
    content: [
      { text: "Yes. Version 3 is live with the new hours.", type: "text" },
    ],
    role: "assistant",
    status: { reason: "stop", type: "complete" },
  }),
  on("25T23:30:00", ask("How did last week go?")),
  on("26T08:00:00", {
    content: [
      {
        text: "Three assignments closed and one is blocked on a decision.",
        type: "reasoning",
      },
      {
        args: { window: "last_7_days" },
        result: { assignmentsClosed: 3, enquiriesAnswered: 11 },
        toolCallId: "call_read_week",
        toolName: "read_week",
        type: "tool-call",
      },
      {
        text: "Three assignments closed and eleven enquiries answered. One thing is waiting on you.",
        type: "text",
      },
      {
        approval: {
          id: "approval_publish_revision",
          reason: "Publishing a revision changes what visitors see.",
        },
        args: PUBLISH_TARGET,
        toolCallId: "call_publish_revision",
        toolName: "publish_revision",
        type: "tool-call",
      },
    ],
    role: "assistant",
    status: { reason: "tool-calls", type: "requires-action" },
  }),
]

const RUNNING: ThreadMessageLike[] = [
  ask("What is waiting on me?"),
  {
    content: [{ text: "Version 4 is ready for you to", type: "text" }],
    role: "assistant",
    status: { type: "running" },
  },
]

const FAILED: ThreadMessageLike[] = [
  ask("What is waiting on me?"),
  {
    content: [],
    role: "assistant",
    status: {
      error: "The workspace did not answer. Try again in a moment.",
      reason: "error",
      type: "incomplete",
    },
  },
]

/**
 * The conversation in its frame, as `/app` renders it: the title and ··· in
 * the top bar, the empty thread in the middle. `?entry=Conversation` loads it
 * alone at phone and desktop widths.
 */
function ConversationSample() {
  return (
    <WorkspaceShell
      className="h-[48rem] border border-border"
      menu={<ConversationMenu newChat={<a href="#new" />} />}
      panel={
        <p className="text-muted-foreground text-sm">
          Nothing right now. Questions and approvals from your team land here.
        </p>
      }
      rail={<p className="text-sm">Brightclean</p>}
      title="New chat"
    >
      <OwnerThread
        bare
        height="h-full"
        isDisabled={false}
        messages={[]}
        settings={{
          briefing: "v3 is live. Version 4 is ready for you to approve.",
        }}
        suggestions={SUGGESTIONS}
      />
    </WorkspaceShell>
  )
}

function CollapsibleSample() {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible className="max-w-md" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="rounded-lg px-1 py-1.5 text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring">
        What changed in this revision
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-1 text-sm">
        The service-area list and two opening hours.
      </CollapsibleContent>
    </Collapsible>
  )
}

function TooltipSample() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <div className="relative flex min-h-24 items-end gap-3" ref={setContainer}>
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger render={<Button variant="outline" />}>
            Copy transcript
          </TooltipTrigger>
          <TooltipContent container={container}>Copy transcript</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

const assistantCatalog = [
  { name: "Collapsible", render: () => <CollapsibleSample /> },
  { name: "CollapsibleTrigger", render: () => <CollapsibleSample /> },
  { name: "CollapsibleContent", render: () => <CollapsibleSample /> },
  { name: "TooltipProvider", render: () => <TooltipSample /> },
  { name: "Tooltip", render: () => <TooltipSample /> },
  { name: "TooltipTrigger", render: () => <TooltipSample /> },
  { name: "TooltipContent", render: () => <TooltipSample /> },
  {
    name: "TooltipIconButton",
    render: () => (
      <div className="flex min-h-16 items-end gap-2">
        <TooltipIconButton tooltip="Copy">
          <CopyIcon aria-hidden />
        </TooltipIconButton>
        <TooltipIconButton disabled tooltip="Copy, unavailable">
          <CopyIcon aria-hidden />
        </TooltipIconButton>
      </div>
    ),
  },
  { name: "MarkdownText", render: () => <FixtureThread messages={MARKDOWN} /> },
  {
    name: "Reasoning",
    render: () => <FixtureThread messages={REASONING_ONE} />,
  },
  {
    name: "ReasoningGroup",
    render: () => <FixtureThread messages={REASONING_MANY} />,
  },
  { name: "ToolGroup", render: () => <FixtureThread messages={TOOL_GROUP} /> },
  {
    name: "ToolFallback",
    render: () => (
      <FixtureThread
        height="h-[88rem]"
        messages={[
          ask("Run the weekly read."),
          toolCall("running"),
          toolCall("complete"),
          toolCall("failed"),
          toolCall("cancelled"),
        ]}
      />
    ),
  },
  {
    name: "Approval",
    render: () => (
      <FixtureThread
        height="h-[76rem]"
        messages={[
          ask("Publish the revision."),
          approvalCall(undefined),
          approvalCall(true),
          approvalCall(false),
        ]}
      />
    ),
  },
  {
    name: "AskFact",
    render: () => (
      <FixtureThread height="h-[72rem]" messages={ASK_FACT_STATES} />
    ),
  },
  {
    name: "RequestChange",
    render: () => (
      <FixtureThread height="h-[92rem]" messages={REQUEST_CHANGE_STATES} />
    ),
  },
  { name: "AnswerInputs", render: () => <AnswerInputsSample /> },
  {
    name: "Onboarding",
    render: () => <OwnerThread height="h-[44rem]" messages={ONBOARDING} />,
  },
  {
    name: "Thread",
    render: () => <OwnerThread height="h-[56rem]" messages={CONVERSATION} />,
  },
  {
    name: "ThreadEmpty",
    render: () => (
      <OwnerThread
        height="h-[40rem]"
        isDisabled={false}
        messages={[]}
        settings={{
          briefing: "v3 is live. Version 4 is ready for you to approve.",
        }}
        suggestions={SUGGESTIONS}
      />
    ),
  },
  {
    // A new owner, or a workspace that could not be read: no line, no chip.
    name: "ThreadEmptyUnread",
    render: () => (
      <OwnerThread
        height="h-[32rem]"
        isDisabled={false}
        messages={[]}
        settings={{ context: null }}
      />
    ),
  },
  {
    name: "ThreadLoading",
    render: () => (
      <OwnerThread
        height="h-[32rem]"
        isDisabled={false}
        isLoading
        messages={[]}
      />
    ),
  },
  {
    name: "ThreadRunning",
    render: () => (
      <OwnerThread
        height="h-[28rem]"
        isDisabled={false}
        isRunning
        messages={RUNNING}
      />
    ),
  },
  { name: "Conversation", render: () => <ConversationSample /> },
  {
    name: "ConversationMenu",
    render: () => <ConversationMenu newChat={<a href="#new" />} />,
  },
  {
    name: "ThreadError",
    render: () => <OwnerThread height="h-[28rem]" messages={FAILED} />,
  },
]

export { assistantCatalog }
