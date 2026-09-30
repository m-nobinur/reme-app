import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  type ThreadSuggestion,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { CopyIcon } from "@phosphor-icons/react"
import {
  type AskChoiceInput,
  FONTS,
  INDUSTRIES,
  PALETTES,
  PRONOUNS,
  TEMPLATES,
  TONES,
  TOOL_CALL_CANCELLED,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_TYPES,
} from "@workspace/contracts"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { ChoiceForm } from "@workspace/ui/components/assistant/ask-choice"
import { UploadPhotosProvider } from "@workspace/ui/components/assistant/ask-upload"
import { CosToolsProvider } from "@workspace/ui/components/assistant/cos-tools"
import { SiteReady } from "@workspace/ui/components/assistant/site-ready"
import {
  OWNER_QUICK_ACTIONS,
  SITE_CHANGE_MODE,
  Thread,
  type ThreadProps,
} from "@workspace/ui/components/assistant/thread"
import {
  ThreadHistorySkeleton,
  ThreadPending,
} from "@workspace/ui/components/assistant/thread-pending"
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
import { BROKEN } from "@workspace/ui/lib/tool-state"
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
/** A fixed zone, so the catalog reads the same on every machine, and the one open question. */
const COS_TOOLS_FIXTURE = {
  zone: "Europe/London",
  question: (requestId: string) =>
    requestId === "0f4b2c8e-1a3d-4e5f-9b6c-7d8e9f0a1b2c"
      ? "Service area"
      : null,
}

const FIXTURE_TIME = new Date("2026-09-24T09:00:00Z")

function FixtureThread({
  height = "h-[48rem]",
  messages,
  settings,
  suggestions,
  isDisabled = true,
  isRunning = false,
  isLoading = false,
  bare = false,
  rates = false,
}: {
  height?: string
  /** Records a thumb on a reply, as the app does, so the thumbs show. */
  rates?: boolean
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
    // A fixed time, so a message without a stored date shows the same time
    // on every run rather than the moment it rendered.
    convertMessage: (message: ThreadMessageLike) => ({
      createdAt: FIXTURE_TIME,
      ...message,
    }),
    isDisabled,
    isLoading,
    isRunning,
    messages,
    onNew: noop,
    suggestions,
    ...(rates ? { adapters: { feedback: { submit: noop } } } : {}),
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
        <CosToolsProvider value={COS_TOOLS_FIXTURE}>
          <Thread
            autoFocus={false}
            components={{ ToolFallback: Approval }}
            {...settings}
          />
        </CosToolsProvider>
      </div>
    </AssistantRuntimeProvider>
  )
}

/** The composer's surroundings as the owner app sets them: the "+" starters. */
const SUGGESTIONS: ThreadSuggestion[] = [
  { prompt: "What changed in version 4?" },
  { prompt: "What do you need from me?" },
  { prompt: "What is on my website now?" },
]

/** A thread with the owner app's composer settings. */
function OwnerThread(props: Parameters<typeof FixtureThread>[0]) {
  return (
    <FixtureThread
      {...props}
      settings={{
        placeholder: "Ask Reme anything…",
        quickActions: OWNER_QUICK_ACTIONS,
        ...props.settings,
      }}
    />
  )
}

/** The composer in website change mode, as Request changes leaves it; × leaves it. */
function SiteChangeThread() {
  const [on, setOn] = useState(true)
  return (
    <OwnerThread
      height="h-[32rem]"
      isDisabled={false}
      messages={[]}
      settings={{
        mode: on
          ? { ...SITE_CHANGE_MODE, onClear: () => setOn(false) }
          : undefined,
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

const question = (text: string) => ({ text, type: "text" as const })

/** The owner's reply to a card, as the app sends it once they answer. */
const reply = (text: string): ThreadMessageLike => ({
  content: [{ text, type: "text" }],
  role: "user",
})

/**
 * One step a card asked and the owner answered: the question, the card,
 * which shows nothing once answered, and the owner's reply.
 */
const answeredStep = (
  asked: string,
  card: Exclude<ThreadMessageLike["content"], string>[number],
  said: string
): ThreadMessageLike[] => [
  {
    content: [question(asked), card],
    role: "assistant",
    status: DONE,
  },
  reply(said),
]

const ASK_FACT_STATES: ThreadMessageLike[] = [
  ...answeredStep(
    "What is your business called?",
    askFact("business.name", stated("business.name", { name: "Brightclean" })),
    "Brightclean"
  ),
  ...answeredStep(
    "What number should customers ring?",
    askFact(
      "business.phone",
      stated("business.phone", { e164: "+447700900123" })
    ),
    "+447700900123"
  ),
  ...answeredStep(
    "How would you sum up Brightclean in one line?",
    askFact("business.tagline", {
      result: { answer: "skipped" },
      skippable: true,
    }),
    "Skip for now"
  ),
  {
    content: [
      askFact("hours.weekday", {
        isError: true,
        result: { error: TOOL_CALL_CANCELLED },
      }),
      askFact("business.email", {
        isError: true,
        result: {
          error: BROKEN,
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
    content: [askFact("business.tagline", { skippable: true })],
    role: "assistant",
    status: WAITING,
  },
]

type Choice = {
  id: string
  label: string
  hint?: string
  visual?: { kind: string; colors?: string[]; family?: string; id?: string }
}

/** An `ask_choice` call in one of its states, from a contract preset list. */
const askChoice = (
  step: string,
  options: readonly Choice[],
  extra: {
    result?: unknown
    isError?: boolean
    multiple?: boolean
    preselected?: string[]
    other?: { label: string; placeholder: string } | null
    skippable?: boolean
    initial?: string[]
    color?: boolean
  } = {}
) => ({
  args: {
    step,
    options: options.map((each) => ({
      id: each.id,
      label: each.label,
      hint: each.hint ?? null,
      visual: each.visual ?? null,
    })),
    multiple: extra.multiple ?? false,
    preselected: extra.preselected ?? [],
    other: extra.other ?? null,
    skippable: extra.skippable ?? false,
    ...(extra.initial ? { initial: extra.initial } : {}),
    ...(extra.color ? { color: true } : {}),
  },
  isError: extra.isError,
  result: extra.result,
  toolCallId: `choice_${step}_${extra.isError ? "error" : extra.result ? "done" : "open"}`,
  toolName: "ask_choice",
  type: "tool-call" as const,
})

const chosen = (ids: string[], other: string | null = null) => ({
  result: { answer: "chosen", ids, other },
})

const PALETTE_OPTIONS = PALETTES.map((each) => ({
  ...each,
  visual: { kind: "swatches", colors: [...each.swatches] },
}))
/** The colour card as the api sends it: the whole pool, four first, a picker behind Other. */
const COLOUR_CARD = {
  other: {
    label: "Your own colour",
    placeholder: "A colour code, or describe your colours",
  },
  initial: ["ocean", "lagoon", "sunset", "damson"],
  color: true,
}
const FONT_OPTIONS = FONTS.map((each) => ({
  ...each,
  visual: { kind: "font", family: each.family },
}))
const TEMPLATE_OPTIONS = TEMPLATES.map((each) => ({
  ...each,
  visual: { kind: "template", id: each.id },
}))

/** The colour card on its own, in each state the owner can put it in. */
const COLOUR_INPUT: AskChoiceInput = {
  step: "palette",
  options: PALETTES.map((each) => ({
    id: each.id,
    label: each.label,
    hint: each.hint ?? null,
    visual: { kind: "swatches", colors: each.swatches },
  })),
  multiple: false,
  preselected: [],
  skippable: false,
  ...COLOUR_CARD,
}
const brandOf = (id: string) =>
  PALETTES.find((each) => each.id === id)?.brand ?? ""
const COLOUR_STATES: [string, Parameters<typeof ChoiceForm>[0]["start"]][] = [
  ["Four first", undefined],
  [
    "After Show other colours",
    { shown: ["harbour", "sage", "cardinal", "graphite"] },
  ],
  ["Own colour, picked", { other: brandOf("harbour") }],
  [
    "Own colour, too light for white text",
    {
      other:
        PALETTES.find((each) => each.id === "sunset")?.swatches[1] ??
        brandOf("sunset"),
    },
  ],
  ["Own colour, in words", { other: "Navy and gold, like our vans" }],
]

const ASK_CHOICE_STATES: ThreadMessageLike[] = [
  ...answeredStep(
    "Which pronouns should Sam use?",
    askChoice("pronouns", PRONOUNS, chosen(["they_them"])),
    "they/them"
  ),
  ...answeredStep(
    "Which colours feel like Brightclean?",
    askChoice("palette", PALETTE_OPTIONS, chosen([], "Navy and gold")),
    "Navy and gold"
  ),
  ...answeredStep(
    "And the type?",
    askChoice("font", FONT_OPTIONS, {
      result: { answer: "skipped" },
      skippable: true,
    }),
    "Skip for now"
  ),
  {
    content: [
      askChoice("tone", TONES, {
        isError: true,
        result: { error: TOOL_CALL_CANCELLED },
      }),
      askChoice("pages", TONES, { isError: true, result: { error: BROKEN } }),
    ],
    role: "assistant",
    status: DONE,
  },
  {
    content: [
      question("What kind of business is Brightclean?"),
      askChoice("industry", INDUSTRIES.slice(0, 6), {
        other: { label: "Something else", placeholder: "Your industry" },
      }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("How should Sam sound when talking to your customers?"),
      askChoice("tone", TONES, { preselected: ["friendly"] }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("Which colours feel like Brightclean?"),
      askChoice("palette", PALETTE_OPTIONS, COLOUR_CARD),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("And the type?"),
      askChoice("font", FONT_OPTIONS, { skippable: true }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("Which layout suits you best?"),
      askChoice("template", TEMPLATE_OPTIONS, { preselected: ["modern"] }),
    ],
    role: "assistant",
    status: WAITING,
  },
]

/** An `ask_upload` call in one of its states. */
const askUpload = (
  label: string,
  extra: { result?: unknown; isError?: boolean } = {}
) => ({
  args: {
    accept: [...UPLOAD_TYPES],
    max_files: UPLOAD_MAX_FILES,
    max_bytes: UPLOAD_MAX_BYTES,
    skippable: true,
  },
  isError: extra.isError,
  result: extra.result,
  toolCallId: `upload_${label}`,
  toolName: "ask_upload",
  type: "tool-call" as const,
})

const PHOTO = {
  id: "0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
  name: "kitchen.jpg",
  content_type: "image/jpeg" as const,
  bytes: 812_000,
}

const ASK_UPLOAD_STATES: ThreadMessageLike[] = [
  ...answeredStep(
    "Do you have a photo of your van?",
    askUpload("one", {
      result: { answer: "uploaded", assets: [PHOTO] },
    }),
    "Uploaded kitchen.jpg"
  ),
  ...answeredStep(
    "Any photos of a room after a clean?",
    askUpload("two", {
      result: {
        answer: "uploaded",
        assets: [
          PHOTO,
          { ...PHOTO, id: "1b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d4e" },
        ],
      },
    }),
    "Uploaded 2 photos"
  ),
  ...answeredStep(
    "And one of your team at work?",
    askUpload("skipped", { result: { answer: "skipped" } }),
    "Skip for now"
  ),
  {
    content: [
      askUpload("cancelled", {
        isError: true,
        result: { error: TOOL_CALL_CANCELLED },
      }),
    ],
    role: "assistant",
    status: DONE,
  },
  {
    content: [
      question(
        "Do you have photos of a kitchen or bathroom after a clean? Real rooms help visitors picture the result."
      ),
      askUpload("open"),
    ],
    role: "assistant",
    status: WAITING,
  },
]

/** Stands in for the web's upload: a moment's wait, then the one photo stored. */
const fakeUpload = async (files: File[]) => {
  await new Promise((resolve) => setTimeout(resolve, 600))
  return {
    assets: files.map((file, index) => ({
      ...PHOTO,
      id: `0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d${String(index).padStart(2, "0")}`,
      name: file.name,
    })),
  }
}

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

type ToolCallContent = Exclude<ThreadMessageLike["content"], string>[number]

/** The Developer's question, as the Chief of Staff offers to answer it. */
const answerQuestion = (
  id: string,
  approved: boolean | undefined
): ToolCallContent => ({
  approval: { approved, id: `approval_${id}` },
  args: {
    request_id: "0f4b2c8e-1a3d-4e5f-9b6c-7d8e9f0a1b2c",
    value: "Saturdays, 9 to 1",
  },
  toolCallId: `call_${id}`,
  toolName: "answer_question",
  type: "tool-call",
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
    result: { error: TOOL_CALL_CANCELLED },
  }),
  requestChange("error", "Swap the hero photo.", {
    approval: false,
    isError: true,
    result: {
      error: BROKEN,
    },
  }),
  // One step of two cards, each answered while the other still waits: the
  // answer is held back, and nothing has been sent.
  {
    content: [
      ...(requestChange("held", "Add Saturday hours, 9 to 1.", {
        approved: true,
      }).content as ToolCallContent[]),
      answerQuestion("held_other", undefined),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      answerQuestion("held_question", true),
      ...(requestChange("held_waiting", "Add Saturday hours, 9 to 1.")
        .content as ToolCallContent[]),
    ],
    role: "assistant",
    status: WAITING,
  },
  // The same two steps, each held answer a no.
  {
    content: [
      ...(requestChange("held_no", "Add Saturday hours, 9 to 1.", {
        approved: false,
      }).content as ToolCallContent[]),
      answerQuestion("held_no_other", undefined),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      answerQuestion("held_no_question", false),
      ...(requestChange("held_no_waiting", "Add Saturday hours, 9 to 1.")
        .content as ToolCallContent[]),
    ],
    role: "assistant",
    status: WAITING,
  },
  // A yes already sent, loaded while its turn runs: no other card waits.
  {
    ...requestChange("sent", "Add Saturday hours, 9 to 1.", { approved: true }),
    status: WAITING,
  },
  // The model still writing the change: nothing to approve yet.
  {
    ...requestChange("drafting", "Add Saturday hours", { approval: false }),
    status: { type: "running" },
  },
  // A no already sent, waiting on the server.
  {
    ...requestChange("declining", "Swap the hero photo.", { approved: false }),
    status: { type: "running" },
  },
]

/* The Chief of Staff's tools, in every state. Fixture content is fictional. */

const IN_FLIGHT = { type: "running" } as const
const LATER = "2026-10-02T09:00:00.000Z"
// The one error that says nothing was done; any other reads as unconfirmed.
const TOOL_FAILED =
  "tool_failed (orchestrator.off_contract): the builder answered in a shape we do not accept, so nothing was done."
const UNKNOWN =
  "unknown_outcome (orchestrator.timeout): the tool did not report back."

type CallFields = {
  args?: unknown
  result?: unknown
  isError?: boolean
  approval?: { id: string; approved?: boolean }
}

/** One tool call as its own message, so no two reads fold together. */
const cosCall = (
  toolName: string,
  id: string,
  fields: CallFields,
  status: ThreadMessageLike["status"] = DONE
): ThreadMessageLike => ({
  content: [
    {
      args: {},
      ...fields,
      toolCallId: `call_${id}`,
      toolName,
      type: "tool-call",
    } as ToolCallContent,
  ],
  role: "assistant",
  status,
})

const WORKSPACE_READ = {
  site: { host: "brightclean.example.net", live_version: 3 },
  builds: [
    {
      assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
      kind: "site.revise",
      state: "implementing",
      goal: "Add Saturday hours, 9 to 1.",
      version: null,
    },
  ],
  questions: [
    {
      request_id: "0f4b2c8e-1a3d-4e5f-9b6c-7d8e9f0a1b2c",
      field: "service_area.radius",
      why: "The areas page needs how far you travel.",
      options: null,
      blocking: true,
    },
  ],
  approvals: [{ version: 4, expires_at: LATER }],
  missing_facts: ["business.tagline"],
}

/** Each read: running, done, failed and stopped. */
const COS_READ_STATES: ThreadMessageLike[] = [
  cosCall("get_workspace", "ws_running", {}, IN_FLIGHT),
  cosCall("get_workspace", "ws_done", { result: WORKSPACE_READ }),
  cosCall("get_workspace", "ws_failed", {
    isError: true,
    result: { error: TOOL_FAILED },
  }),
  cosCall("get_facts", "facts_done", {
    result: {
      facts: [
        { key: "business.name", value: { name: "Brightclean" } },
        { key: "hours.weekday", value: { open: "08:00", close: "18:00" } },
      ],
    },
  }),
  cosCall("get_facts", "facts_cancelled", {
    isError: true,
    result: { error: TOOL_CALL_CANCELLED },
  }),
  cosCall("get_preview", "preview_ready", {
    args: { assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e" },
    result: {
      outcome: "ready",
      assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
      version: 4,
      expires_at: LATER,
    },
  }),
  cosCall("get_preview", "preview_none", {
    args: { assignment_id: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e" },
    result: {
      outcome: "refused",
      error: {
        class: "resource",
        code: "assignment.not_found",
        message: "No assignment with that id in this business.",
      },
    },
  }),
]

/** Every state of a tool that waits on the owner, for one tool and input. */
function decisionStates(
  toolName: string,
  args: unknown,
  broken: unknown,
  done: unknown,
  refused: unknown
): ThreadMessageLike[] {
  const call = (
    id: string,
    fields: CallFields,
    status: ThreadMessageLike["status"] = DONE
  ) => cosCall(toolName, `${toolName}_${id}`, { args, ...fields }, status)
  const approval = (id: string, approved?: boolean) => ({
    id: `approval_${toolName}_${id}`,
    ...(approved === undefined ? {} : { approved }),
  })
  return [
    call("drafting", {}, IN_FLIGHT),
    // Left unfinished when the stream stopped.
    call("unfinished", {}),
    call("asking", { approval: approval("asking") }, WAITING),
    // A target that does not parse: no yes, only a no to let the step go on.
    cosCall(
      toolName,
      `${toolName}_broken`,
      { args: broken, approval: approval("broken") },
      WAITING
    ),
    call("sent", { approval: approval("sent", true) }, IN_FLIGHT),
    call("declining", { approval: approval("declining", false) }, IN_FLIGHT),
    {
      content: [
        ...(call("held", { approval: approval("held", true) })
          .content as ToolCallContent[]),
        ...(requestChange("held_other", "Add Saturday hours, 9 to 1.")
          .content as ToolCallContent[]),
      ],
      role: "assistant",
      status: WAITING,
    },
    call("done", { approval: approval("done", true), result: done }),
    call("refused", { approval: approval("refused", true), result: refused }),
    call("denied", {
      approval: approval("denied", false),
      isError: true,
      result: { error: "Tool approval denied" },
    }),
    call("cancelled", {
      isError: true,
      result: { error: TOOL_CALL_CANCELLED },
    }),
    call("unconfirmed", {
      approval: approval("unconfirmed", true),
      isError: true,
      result: { error: UNKNOWN },
    }),
    call("failed", {
      approval: approval("failed", true),
      isError: true,
      result: { error: TOOL_FAILED },
    }),
  ]
}

const refusal = (code: string, message: string) => ({
  outcome: "refused",
  error: { class: "validation", code, message },
})

// The api's own refusals, codes and messages as it sends them; the card
// shows its own line for each code, never the message.
const ANSWER_QUESTION_STATES = decisionStates(
  "answer_question",
  {
    request_id: "0f4b2c8e-1a3d-4e5f-9b6c-7d8e9f0a1b2c",
    value: { key: "hours.weekday", value: { open: "08:00", close: "18:00" } },
  },
  { request_id: "not-a-request", value: "" },
  { outcome: "answered", request_id: "0f4b2c8e-1a3d-4e5f-9b6c-7d8e9f0a1b2c" },
  refusal("request.not_found", "No build asked that question.")
)

// Written as 09:00 with the model's offset; stored as 09:00 London time,
// which is 08:00 UTC on 2 October.
const CREATE_REMINDER_STATES = decisionStates(
  "create_reminder",
  { title: "Call the window supplier", due_at: "2026-10-02T09:00:00+01:00" },
  { title: "", due_at: null },
  { outcome: "created", due_at: "2026-10-02T08:00:00.000Z" },
  refusal("reminder.due_past", "A reminder cannot be due in the past.")
)

/** Two replies with words: one the owner rated up, one not yet rated. */
const RATED: ThreadMessageLike[] = [
  ask("What is live now?"),
  {
    content: [
      { text: "Version 3 is live, with your Saturday hours.", type: "text" },
    ],
    metadata: { submittedFeedback: { type: "positive" } },
    role: "assistant",
    status: DONE,
  },
  ask("And the services page?"),
  {
    content: [{ text: "It lists the services you gave.", type: "text" }],
    role: "assistant",
    status: DONE,
  },
]

/** A new owner's onboarding, two answers in and waiting on the third. */
/**
 * Onboarding as the app stores it: every step a message of its own, with
 * its own time and thumbs, and every answer the owner's reply.
 */
const ONBOARDING: ThreadMessageLike[] = [
  on("27T09:00:00.000", {
    content: [
      question("Hi Sam, I'm Reme. What is your business called?"),
      askFact(
        "business.name",
        stated("business.name", { name: "Brightclean" })
      ),
    ],
    role: "assistant",
    status: DONE,
  }),
  on("27T09:00:40.000", reply("Brightclean")),
  on("27T09:00:41.000", {
    content: [
      question("Brightclean, got it. What number should customers ring?"),
      askFact(
        "business.phone",
        stated("business.phone", { e164: "+447700900123" })
      ),
    ],
    role: "assistant",
    status: DONE,
  }),
  on("27T09:02:10.000", reply("+447700900123")),
  on("27T09:02:11.000", {
    content: [
      question("Thanks. What are your hours on weekdays?"),
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

![Front of the shop](https://example.net/shop.png)Photos of the shop front are on [the site](https://example.net/).

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
      panelLine={
        <span className="text-muted-foreground text-sm">Nothing right now</span>
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
    name: "AskChoice",
    render: () => (
      <FixtureThread height="h-[140rem]" messages={ASK_CHOICE_STATES} />
    ),
  },
  {
    name: "ChoiceForm",
    render: () => (
      <div className="flex max-w-2xl flex-col gap-8">
        {COLOUR_STATES.map(([title, start]) => (
          <section className="flex flex-col gap-3" key={title}>
            <h3 className="font-medium text-muted-foreground text-xs">
              {title}
            </h3>
            <ChoiceForm input={COLOUR_INPUT} onAnswer={noop} start={start} />
          </section>
        ))}
      </div>
    ),
  },
  // The upload card and the provider that gives it the app's upload.
  ...(["AskUpload", "UploadPhotosProvider"] as const).map((name) => ({
    name,
    render: () => (
      <UploadPhotosProvider value={fakeUpload}>
        <FixtureThread height="h-[60rem]" messages={ASK_UPLOAD_STATES} />
      </UploadPhotosProvider>
    ),
  })),
  // At the end of an open thread, then its other states on their own:
  // approving, refused and approved.
  {
    name: "SiteReady",
    render: () => (
      <div className="flex flex-col gap-6">
        <FixtureThread
          height="h-[30rem]"
          messages={[
            ask("Can you add a line about pets?"),
            {
              content: [
                {
                  text: "Noted. I will add it once the first version is ready.",
                  type: "text",
                },
              ],
              role: "assistant",
              status: DONE,
            },
          ]}
          settings={{
            after: (
              <SiteReady
                onApprove={noop}
                onMakeChanges={noop}
                onSeePreview={noop}
                version={1}
              />
            ),
          }}
        />
        <div className="flex max-w-xl flex-col gap-6">
          <SiteReady
            onApprove={noop}
            onMakeChanges={noop}
            onSeePreview={noop}
            pending
            version={2}
          />
          <SiteReady
            error="A newer version replaced that one. Check the latest before you decide."
            onApprove={noop}
            onMakeChanges={noop}
            onSeePreview={noop}
            version={2}
          />
          <SiteReady
            approved
            onApprove={noop}
            onMakeChanges={noop}
            onSeePreview={noop}
            version={3}
          />
        </div>
      </div>
    ),
  },
  {
    name: "RequestChange",
    render: () => (
      <FixtureThread height="h-[130rem]" messages={REQUEST_CHANGE_STATES} />
    ),
  },
  // The card the three tools share, its outcome lines and its provider, on
  // a waiting card, a done one and a refused one.
  ...(["Decision", "Done", "Problem", "CosToolsProvider"] as const).map(
    (name) => ({
      name,
      render: () => (
        <FixtureThread
          height="h-[36rem]"
          messages={[
            CREATE_REMINDER_STATES[2],
            CREATE_REMINDER_STATES[8],
            CREATE_REMINDER_STATES[9],
          ].filter((message) => message !== undefined)}
        />
      ),
    })
  ),
  {
    name: "ReplyFeedback",
    render: () => <FixtureThread height="h-[30rem]" messages={RATED} rates />,
  },
  {
    name: "CosReads",
    render: () => (
      <FixtureThread height="h-[60rem]" messages={COS_READ_STATES} />
    ),
  },
  {
    name: "AnswerQuestion",
    render: () => (
      <FixtureThread height="h-[180rem]" messages={ANSWER_QUESTION_STATES} />
    ),
  },
  {
    name: "CreateReminder",
    render: () => (
      <FixtureThread height="h-[180rem]" messages={CREATE_REMINDER_STATES} />
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
    // A new owner, or a workspace that could not be read: no line.
    name: "ThreadEmptyUnread",
    render: () => (
      <OwnerThread height="h-[32rem]" isDisabled={false} messages={[]} />
    ),
  },
  { name: "ThreadSiteChange", render: () => <SiteChangeThread /> },
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
    name: "ThreadHistorySkeleton",
    render: () => (
      <div className="max-w-md">
        <ThreadHistorySkeleton />
      </div>
    ),
  },
  {
    // What the server sends before the chat chunk loads.
    name: "ThreadPending",
    render: () => (
      <div className="h-[32rem]">
        <ThreadPending />
      </div>
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
