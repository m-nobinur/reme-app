import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { CopyIcon } from "@phosphor-icons/react"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { TooltipIconButton } from "@workspace/ui/components/assistant/tooltip-icon-button"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
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
}: {
  height?: string
  messages: ThreadMessageLike[]
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    isDisabled: true,
    messages,
    onNew: noop,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        className={`${height} overflow-hidden rounded-3xl border border-border`}
      >
        <Thread autoFocus={false} components={{ ToolFallback: Approval }} />
      </div>
    </AssistantRuntimeProvider>
  )
}

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
  ask("How did last week go?"),
  {
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
  },
]

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
  { name: "Thread", render: () => <FixtureThread messages={CONVERSATION} /> },
]

export { assistantCatalog }
