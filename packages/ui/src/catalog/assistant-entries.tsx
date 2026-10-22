import {
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  type ThreadSuggestion,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { CopyIcon } from "@phosphor-icons/react"
import {
  type AskChoiceInput,
  type Blueprint,
  type DomainPurchaseStatus,
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
import { SaveDesignAnswerProvider } from "@workspace/ui/components/assistant/ask-design"
import { UploadPhotosProvider } from "@workspace/ui/components/assistant/ask-upload"
import {
  BlueprintCard,
  type BlueprintCardProps,
  SiteNameProvider,
} from "@workspace/ui/components/assistant/blueprint-card"
import {
  type DomainPurchase,
  DomainPurchaseProvider,
} from "@workspace/ui/components/assistant/buy-domain"
import { CosToolsProvider } from "@workspace/ui/components/assistant/cos-tools"
import { MemoryChipUI } from "@workspace/ui/components/assistant/memory-chip"
import { ServerButtonUI } from "@workspace/ui/components/assistant/server-button"
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
import { GeneratedPhotos } from "@workspace/ui/components/generated-photos"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { WorkspaceShell } from "@workspace/ui/components/workspace-shell"
import { FACT_INPUTS } from "@workspace/ui/lib/answer"
import { BROKEN } from "@workspace/ui/lib/tool-state"
import { type ReactNode, useState } from "react"
import { BLUEPRINT, REPLAN } from "./blueprint-fixtures"
import { INPUT as ASK_DESIGN_INPUT } from "./tray-entries"

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
  stored,
  children,
}: {
  /** Mounted beside the thread, as the app mounts what registers a part's card. */
  children?: ReactNode
  /** The thread is this stored conversation, as at `/app/c/$id`. */
  stored?: string
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
    adapters: {
      ...(rates ? { feedback: { submit: noop } } : {}),
      ...(stored
        ? {
            threadList: {
              threadId: stored,
              threads: [
                {
                  id: stored,
                  remoteId: stored,
                  status: "regular" as const,
                  title: "Getting started",
                },
              ],
            },
          }
        : {}),
    },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
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
  { prompt: "What changed in the new version?" },
  { prompt: "What do you need from me?" },
  { prompt: "What is on my website now?" },
]

/** A thread with the owner app's composer settings. */
function OwnerThread(props: Parameters<typeof FixtureThread>[0]) {
  return (
    <FixtureThread
      {...props}
      settings={{
        assistant: "Ellie",
        placeholder: "Ask Ellie anything…",
        questionPlaceholder: "Or tell Ellie something else…",
        quickActions: OWNER_QUICK_ACTIONS,
        ...(props.stored ? { stored: props.stored } : {}),
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

/** A drawn picture, not a real one: a window, a worktop, a bowl. Grey by opacity alone. */
const KITCHEN = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="100" viewBox="0 0 150 100"><rect width="150" height="100" fill-opacity=".08"/><rect x="18" y="12" width="54" height="40" fill-opacity=".2"/><rect x="0" y="62" width="150" height="38" fill-opacity=".35"/><circle cx="108" cy="52" r="12" fill-opacity=".5"/></svg>'
)}`

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

/** An `ask_details` call in one of its states. */
const askDetails = (
  step: "contact" | "assistant",
  extra: {
    result?: unknown
    isError?: boolean
    skippable?: boolean
    prefill?: unknown[]
  } = {}
) => ({
  args: {
    step,
    prefill: (extra.prefill ?? []) as [],
    skippable: extra.skippable ?? false,
  },
  isError: extra.isError,
  result: extra.result,
  toolCallId: `details_${step}_${extra.isError ? "error" : extra.result ? "done" : "open"}`,
  toolName: "ask_details",
  type: "tool-call" as const,
})

const SIGN_IN_EMAIL = {
  key: "business.email",
  value: { address: "sam@brightclean.example" },
}

const ASK_DETAILS_STATES: ThreadMessageLike[] = [
  ...answeredStep(
    "How can customers reach Brightclean?",
    askDetails("contact", {
      result: {
        answer: "stated",
        facts: [
          { key: "business.phone", value: { e164: "+447700900123" } },
          SIGN_IN_EMAIL,
        ],
      },
    }),
    "07700 900123, sam@brightclean.example"
  ),
  ...answeredStep(
    "And your assistant?",
    askDetails("assistant", {
      result: { answer: "skipped" },
      skippable: true,
    }),
    "Skip for now"
  ),
  {
    content: [
      askDetails("contact", {
        isError: true,
        result: { error: TOOL_CALL_CANCELLED },
      }),
      askDetails("assistant", { isError: true, result: { error: BROKEN } }),
    ],
    role: "assistant",
    status: DONE,
  },
  {
    content: [
      question(
        "How can customers reach Brightclean? I have filled in the email you signed up with."
      ),
      askDetails("contact", { prefill: [SIGN_IN_EMAIL] }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("Last thing: what should your assistant be called?"),
      askDetails("assistant", { skippable: true }),
    ],
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

/** A question a chauffeur firm's quote form might ask. */
const quoteField = (
  key: string,
  label: string,
  type: string,
  extra: { required?: boolean; hint?: string; options?: string[] } = {}
) => ({
  key,
  label,
  type,
  required: extra.required ?? true,
  hint: extra.hint ?? null,
  options: extra.options ?? null,
})

const LIMOUSINE_QUESTIONS = [
  quoteField("pickup", "Pick-up address", "text", { hint: "Street and town" }),
  quoteField("dropoff", "Drop-off address", "text"),
  quoteField("journey_date", "Date of the journey", "date"),
  quoteField("passengers", "Passengers", "number"),
  quoteField("occasion", "Occasion", "select", {
    required: false,
    options: ["Wedding", "Airport transfer", "Night out", "Business"],
  }),
  quoteField("notes", "Anything else", "textarea", { required: false }),
]

/** A `review_blueprint` call in one of its states. */
const reviewBlueprint = (
  label: string,
  plan: Blueprint,
  extra: { result?: unknown; isError?: boolean } = {}
) => ({
  args: { blueprint: plan },
  isError: extra.isError,
  result: extra.result,
  toolCallId: `blueprint_${label}`,
  toolName: "review_blueprint",
  type: "tool-call" as const,
})

const PLANNED =
  "Here is the plan for your site. Read it, then build it or change it."

const REVIEW_BLUEPRINT_STATES: ThreadMessageLike[] = [
  ...answeredStep(
    PLANNED,
    reviewBlueprint("built", BLUEPRINT, { result: { decision: "build" } }),
    "Build it"
  ),
  {
    content: [
      reviewBlueprint("cancelled", BLUEPRINT, {
        isError: true,
        result: { error: TOOL_CALL_CANCELLED },
      }),
      reviewBlueprint("error", BLUEPRINT, {
        isError: true,
        result: { error: BROKEN },
      }),
    ],
    role: "assistant",
    status: DONE,
  },
  // A re-plan: the first plan was changed, so the second marks what differs.
  {
    content: [
      question(PLANNED),
      reviewBlueprint("first", BLUEPRINT, {
        result: {
          decision: "change",
          note: "Add a gallery page and make the colours warmer",
        },
      }),
    ],
    role: "assistant",
    status: DONE,
  },
  reply("Add a gallery page and make the colours warmer"),
  {
    content: [
      question("Updated. The changed lines are marked."),
      reviewBlueprint("replan", REPLAN),
    ],
    role: "assistant",
    status: WAITING,
  },
]

/** The plan card by itself: title, props, and an optional width. */
const BLUEPRINT_CARDS: [string, BlueprintCardProps, string?][] = [
  ["Feature plan", { blueprint: BLUEPRINT, onBuild: noop }],
  ["Collapsed", { blueprint: BLUEPRINT, defaultOpen: false, onBuild: noop }],
  [
    "After a re-plan, changed rows marked",
    { blueprint: REPLAN, previous: BLUEPRINT, onBuild: noop },
  ],
  [
    "Read-only, as the panel keeps it",
    { blueprint: BLUEPRINT, readOnly: true },
  ],
  [
    "Your own colour, photos written in",
    {
      blueprint: {
        ...BLUEPRINT,
        palette: { kind: "brand", brand: PALETTES[3]?.brand ?? "" },
      },
      photoDirection: "Daylight, tidy rooms, hands at work, never faces.",
      onBuild: noop,
    },
  ],
  ["Phone width", { blueprint: BLUEPRINT, onBuild: noop }, "max-w-[22.5rem]"],
]

/** A `review_quote_form` call in one of its states. */
const reviewQuote = (
  label: string,
  fields: ReturnType<typeof quoteField>[],
  extra: { result?: unknown; isError?: boolean; note?: string | null } = {}
) => ({
  args: {
    fields,
    note:
      extra.note === undefined
        ? "To quote a ride you need the route, the date and how many are travelling."
        : extra.note,
  },
  isError: extra.isError,
  result: extra.result,
  toolCallId: `quote_${label}`,
  toolName: "review_quote_form",
  type: "tool-call" as const,
})

const PROPOSED =
  "Here is what I would ask someone who wants a quote. Change anything that does not fit."

const REVIEW_QUOTE_STATES: ThreadMessageLike[] = [
  ...answeredStep(
    PROPOSED,
    reviewQuote("confirmed", LIMOUSINE_QUESTIONS, {
      result: {
        answer: "confirmed",
        fields: LIMOUSINE_QUESTIONS.slice(0, 4),
      },
    }),
    "Your quote form asks 4 questions: Pick-up address, Drop-off address, Date of the journey, Passengers."
  ),
  ...answeredStep(
    PROPOSED,
    reviewQuote("changes", LIMOUSINE_QUESTIONS, {
      result: {
        answer: "changes",
        text: "Ask about luggage too, and drop the occasion.",
      },
    }),
    "Ask about luggage too, and drop the occasion."
  ),
  {
    content: [
      reviewQuote("cancelled", LIMOUSINE_QUESTIONS, {
        isError: true,
        result: { error: TOOL_CALL_CANCELLED },
      }),
      reviewQuote("error", LIMOUSINE_QUESTIONS, {
        isError: true,
        result: { error: BROKEN },
      }),
    ],
    role: "assistant",
    status: DONE,
  },
  {
    content: [question(PROPOSED), reviewQuote("open", LIMOUSINE_QUESTIONS)],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("Two questions is the least a quote form can ask."),
      reviewQuote(
        "minimum",
        [
          quoteField("rooms", "How many rooms", "number"),
          quoteField("access", "How we get in", "textarea", {
            required: false,
            hint: "A key safe, a neighbour or someone at home",
          }),
        ],
        { note: null }
      ),
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
const EXPIRED_LINE =
  "approval_expired: the owner's yes on this card has expired, so nothing was done."

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
    call("expired", {
      approval: approval("expired", true),
      isError: true,
      result: { error: EXPIRED_LINE },
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

const RECORD_REVIEW_STATES = decisionStates(
  "record_review",
  {
    slot: 1,
    quote:
      "They worked around my hours and the kitchen has never looked so clean.",
    name: "Marta L.",
    permission: true,
  },
  { slot: 1, quote: "", name: "", permission: true },
  { outcome: "recorded", slot: 1 },
  refusal("review.unconfirmed", "The review could not be confirmed.")
)

const DOMAIN = "sparkleclean.co.uk"
const WWW = { type: "CNAME", name: "www", value: "domains.remeai.co.uk" }
const GODADDY = {
  name: "GoDaddy",
  settings_url: "https://dcc.godaddy.com/manage/dns",
}

/** A connect_domain call whose yes is in: the records to add, by case. */
const connecting = (id: string, output: unknown, name = DOMAIN) =>
  cosCall("connect_domain", `connect_${id}`, {
    args: { name },
    approval: { id: `approval_connect_${id}`, approved: true },
    result: output,
  })

// The records a domain needs, as the orchestrator answers: with the provider
// named and its own link, with only the bare-address alias, a subdomain's one
// record, one that may touch email, and one with no records to show.
const CONNECT_DOMAIN_STATES = [
  ...decisionStates(
    "connect_domain",
    { name: DOMAIN },
    { name: 7 },
    {
      outcome: "connecting",
      method: "records",
      email_affected: false,
      apex: "forward",
      provider: GODADDY,
      steps: [
        WWW,
        { type: "TXT", name: "_acme-challenge.www", value: "k3j9x2m1q8w7e6r5" },
      ],
    },
    refusal("domain.in_use", "That domain belongs to another business.")
  ),
  connecting("alias", {
    outcome: "connecting",
    method: "records",
    email_affected: false,
    apex: "alias",
    provider: { name: "Namecheap" },
    steps: [WWW],
  }),
  connecting("email", {
    outcome: "connecting",
    method: "records",
    email_affected: true,
    apex: "forward",
    steps: [WWW],
  }),
  connecting("no_steps", {
    outcome: "connecting",
    method: "domain_connect",
    email_affected: false,
  }),
  connecting(
    "subdomain",
    {
      outcome: "connecting",
      method: "records",
      email_affected: false,
      provider: GODADDY,
      steps: [{ type: "CNAME", name: "book", value: "domains.remeai.co.uk" }],
    },
    `book.${DOMAIN}`
  ),
]

const REMOVE_DOMAIN_STATES = decisionStates(
  "remove_domain",
  { name: DOMAIN },
  { name: 7 },
  { outcome: "removed" },
  refusal("domain.not_found", "That domain is not connected.")
)

const offer = (name: string, price: number, why: string) => ({
  name,
  price_gbp_year: price,
  why,
})

// What find_domain answers: the best pick and three others, none free, and
// a search still running.
const FIND_DOMAIN_STATES: ThreadMessageLike[] = [
  ask("I don't have a website address. Can you sort one?"),
  cosCall("find_domain", "find_running", { args: {} }, IN_FLIGHT),
  cosCall("find_domain", "find_found", {
    args: {},
    result: {
      outcome: "found",
      best: offer(DOMAIN, 8, "Short, matches your name, and .co.uk says UK."),
      options: [
        offer("sparklecleanbristol.co.uk", 8, "Says where you work."),
        offer("sparkleclean.uk", 8, "The shortest UK ending."),
        offer("sparklecleanbristol.com", 12, "Known everywhere."),
      ],
    },
  }),
  cosCall("find_domain", "find_none", {
    args: { query: "sparkle" },
    result: refusal("domain.unavailable", "That name isn't free to register."),
  }),
]

const REGISTRANT = {
  name: "Jane Smith",
  business_name: "Sparkle Clean",
  email: "jane@sparkleclean.example",
  phone: "+447700900123",
  address: {
    street: "12 Mill Lane",
    city: "Bristol",
    postal_code: "BS1 4AB",
    country_code: "GB",
  },
}

/** A buy_domain call for `name`, ready for payment. */
const buying = (id: string, name: string, price = 8) =>
  cosCall("buy_domain", `buy_${id}`, {
    args: { name, registrant: REGISTRANT, registrant_type: "STRA" },
    result: {
      outcome: "awaiting_payment",
      name,
      price_gbp: price,
      checkout: "embedded",
    },
  })

// Each purchase after payment has its own name, so the catalog's status
// read answers one state per card, as `GET /domains/{name}` would.
const PAID: Record<string, Omit<DomainPurchaseStatus, "name">> = {
  "authorised.co.uk": { state: "verifying", test: false },
  "serving.co.uk": { state: "verifying", test: false, outcome: "registered" },
  "registered.co.uk": { state: "active", test: false, outcome: "registered" },
  "testpurchase.com": {
    state: "verifying",
    test: true,
    outcome: "test_registered",
  },
  "failed.co.uk": { state: "failed", test: false, outcome: "payment_released" },
  "pricechanged.co.uk": {
    state: "failed",
    test: false,
    outcome: "price_changed",
  },
  "taken.co.uk": { state: "failed", test: false, outcome: "unavailable" },
  "abandoned.co.uk": { state: "abandoned", test: false, outcome: "expired" },
}

// No Stripe in the catalog: Continue answers as an environment without
// buying does.
const CATALOG_PURCHASE: DomainPurchase = {
  checkout: async () => ({
    outcome: "refused",
    code: "domain.buy_unavailable",
  }),
  status: async (name) => {
    const paid = PAID[name]
    return paid ? { name, ...paid } : null
  },
}

const BUY_DOMAIN_STATES: ThreadMessageLike[] = [
  cosCall(
    "buy_domain",
    "buy_running",
    { args: { name: DOMAIN, registrant: REGISTRANT } },
    IN_FLIGHT
  ),
  buying("awaiting", DOMAIN),
  buying("com", "sparklecleanbristol.com", 12),
  ...Object.keys(PAID).map((name) => buying(name, name)),
  cosCall("buy_domain", "buy_refused", {
    args: { name: DOMAIN, registrant: REGISTRANT, registrant_type: "STRA" },
    result: refusal(
      "domain.buy_unavailable",
      "Buying a domain isn't available yet."
    ),
  }),
]

/** A check_domain call by where the domain stands; one message each. */
const check = (id: string, status: unknown, state = "verifying") =>
  cosCall("check_domain", `check_${id}`, {
    args: { name: DOMAIN },
    result: {
      outcome: "checked",
      state,
      status,
      next_step: "Tell the owner where the domain stands.",
    },
  })

const CHECK_DOMAIN_STATES: ThreadMessageLike[] = [
  cosCall(
    "check_domain",
    "check_running",
    { args: { name: DOMAIN } },
    IN_FLIGHT
  ),
  check("waiting", { status: "pending_verification" }),
  check("not_found", { status: "not_found" }),
  check("invalid", { status: "invalid_configuration" }),
  check("certificate", { status: "pending_certificate" }),
  check("live", { status: "valid" }, "active"),
  check("conflict", {
    status: "conflicting_record",
    conflicts: [{ type: "A", name: `www.${DOMAIN}`, value: "192.0.2.10" }],
  }),
  check("unknown", { status: "unknown_error" }),
  cosCall("check_domain", "check_refused", {
    args: { name: DOMAIN },
    result: refusal("domain.not_found", "That domain is not connected."),
  }),
  cosCall("check_domain", "check_cancelled", {
    args: { name: DOMAIN },
    isError: true,
    result: { error: TOOL_CALL_CANCELLED },
  }),
]

/** A connect_google call in each state: a link, connected, off, refused. */
const CONNECT_GOOGLE_STATES: ThreadMessageLike[] = [
  cosCall("connect_google", "google_running", {}, IN_FLIGHT),
  cosCall("connect_google", "google_link", {
    result: { url: "https://staging.remeai.co.uk/api/google/start" },
  }),
  cosCall("connect_google", "google_connected", {
    result: { connected: true, email: "sam.sparkle@gmail.com" },
  }),
  cosCall("connect_google", "google_off", { result: { available: false } }),
  cosCall("connect_google", "google_refused", {
    result: refusal("search.not_owner", "Only the owner can connect Google."),
  }),
]

/** A reply that opens with what the assistant remembered since the owner last looked. */
const REMEMBERED: ThreadMessageLike[] = [
  ask("Thanks, that is all."),
  {
    content: [
      {
        type: "data",
        name: "memory",
        data: {
          version: 4,
          changes: [
            {
              kind: "added",
              text: "Prefers calls after 4pm",
              source: "owner_said",
            },
            {
              kind: "changed",
              text: "Quotes go out on Fridays",
              source: "reflection",
            },
            { kind: "removed", text: "Away in August", source: "owner_said" },
          ],
        },
      },
      { text: "Any time.", type: "text" },
    ],
    role: "assistant",
    status: DONE,
  },
]

/** Messages the assistant posted on its own, each with the button it can carry. */
const POSTED: ThreadMessageLike[] = [
  ask("Is my domain connected?"),
  {
    content: [
      { text: "Not yet. I'll message you the moment it is.", type: "text" },
    ],
    role: "assistant",
    status: DONE,
  },
  {
    content: [
      {
        text: `${DOMAIN} points at your website, and the certificate is ready.`,
        type: "text",
      },
      {
        type: "data",
        name: "button",
        data: {
          label: "Open GoDaddy DNS settings",
          action: { kind: "open", url: GODADDY.settings_url },
        },
      },
    ],
    role: "assistant",
    status: DONE,
  },
  {
    content: [
      { text: "Your website is live on the new address.", type: "text" },
      {
        type: "data",
        name: "button",
        data: {
          label: "Show me what changed",
          action: { kind: "ask", text: "Show me what changed." },
        },
      },
    ],
    role: "assistant",
    status: DONE,
  },
]

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
    content: [{ text: "A new version is ready for you to", type: "text" }],
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

const REPLY_WORDS =
  "Thanks, I have the number. I will put it on every page of your website, in the header and the footer, so people can ring you from wherever they land. Some customers would rather write than ring, so one more thing: which email address should enquiries go to?"

/** Onboarding up to a typed answer: the open card a typed message overtakes is gone. */
const BEFORE_SEND: ThreadMessageLike[] = [
  ...ONBOARDING.slice(0, 2),
  {
    content: [
      question("Brightclean, got it. What number should customers ring?"),
    ],
    role: "assistant",
    status: DONE,
  },
]

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

/**
 * A thread the owner sends in. The reply lands after a pause, whole or word
 * by word as a streamed model reply does, and ends on the next question's
 * card, so a test can watch the viewport from the send to the end of the turn.
 */
const OPENING: ThreadMessageLike[] = [
  {
    content: [
      question(
        "Hi Sam, I'm Reme. I will set up your website and look after enquiries while you work. To start, what is your business called?"
      ),
      askFact("business.name"),
    ],
    id: "opening",
    role: "assistant",
    status: WAITING,
  },
]

/**
 * Onboarding's opening message, played in as a live reply the first time it
 * is seen. It starts as seen, so a snapshot of it holds still; Play again
 * runs it from the top as a new owner sees it.
 */
function RevealSample() {
  const [run, setRun] = useState(0)
  return (
    <div className="flex flex-col gap-3">
      <Button
        className="self-start"
        onClick={() => setRun((count) => count + 1)}
        size="sm"
        variant="outline"
      >
        Play again
      </Button>
      <OwnerThread
        height="h-[28rem]"
        isDisabled={false}
        key={run}
        messages={OPENING}
        settings={{ reveal: { unseen: () => run > 0, seen: () => undefined } }}
      />
    </div>
  )
}

function SendingThread({ streamed }: { streamed: boolean }) {
  const [messages, setMessages] = useState<ThreadMessageLike[]>(BEFORE_SEND)
  const [isRunning, setRunning] = useState(false)
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => ({
      createdAt: FIXTURE_TIME,
      ...message,
    }),
    isRunning,
    messages,
    onNew: async (message) => {
      const sent = message.content.find((part) => part.type === "text")
      const turn = messages.length
      setMessages((all) => [
        ...all,
        { ...ask(sent?.type === "text" ? sent.text : ""), id: `sent_${turn}` },
      ])
      setRunning(true)
      await pause(600)
      const words = REPLY_WORDS.split(" ")
      const steps = streamed ? words.length : 1
      for (let step = 1; step <= steps; step++) {
        const text = streamed ? words.slice(0, step).join(" ") : REPLY_WORDS
        setMessages((all) => [
          ...all.filter((each) => each.id !== `reply_${turn}`),
          {
            // The next question's card follows the words, as onboarding's do.
            content: [
              { text, type: "text" },
              ...(step === steps ? [askFact("business.email")] : []),
            ],
            id: `reply_${turn}`,
            role: "assistant",
            status: step === steps ? WAITING : { type: "running" },
          },
        ])
        if (streamed) await pause(30)
      }
      setRunning(false)
    },
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="h-[44rem] overflow-hidden rounded-3xl border border-border">
        <Thread autoFocus={false} components={{ ToolFallback: Approval }} />
      </div>
    </AssistantRuntimeProvider>
  )
}

/**
 * The conversation in its frame, as `/app` renders it: the empty thread in
 * the middle. `?entry=Conversation` loads it
 * alone at phone and desktop widths.
 */
function ConversationSample({ stored }: { stored?: string }) {
  return (
    <WorkspaceShell
      className="h-192 border border-border"
      panel={
        <p className="text-muted-foreground text-sm">
          Nothing right now. Questions and approvals from your team land here.
        </p>
      }
      panelLine={
        <span className="text-muted-foreground text-sm">Nothing right now</span>
      }
      rail={<p className="text-sm">Brightclean</p>}
    >
      <OwnerThread
        bare
        height="h-full"
        isDisabled={false}
        messages={[]}
        {...(stored ? { stored } : {})}
        settings={{
          briefing:
            "Your website is live. A new version is ready for you to approve.",
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
    name: "AskDetails",
    render: () => (
      <FixtureThread height="h-[88rem]" messages={ASK_DETAILS_STATES} />
    ),
  },
  {
    name: "AskChoice",
    render: () => (
      <FixtureThread height="h-[150rem]" messages={ASK_CHOICE_STATES} />
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
  {
    name: "ReviewBlueprint",
    render: () => (
      <FixtureThread height="h-[60rem]" messages={REVIEW_BLUEPRINT_STATES} />
    ),
  },
  // The plan card on its own, in the states a card can be in.
  ...(["BlueprintCard", "SiteNameProvider"] as const).map((name) => ({
    name,
    render: () => (
      <SiteNameProvider value="Mop & Pail Cleaning">
        <div className="flex max-w-2xl flex-col gap-8">
          {BLUEPRINT_CARDS.map(([title, props, width]) => (
            <section
              className={`flex flex-col gap-3 ${width ?? ""}`}
              key={title}
            >
              <h3 className="font-medium text-muted-foreground text-xs">
                {title}
              </h3>
              <BlueprintCard {...props} />
            </section>
          ))}
        </div>
      </SiteNameProvider>
    ),
  })),
  {
    name: "ReviewQuoteForm",
    render: () => (
      <FixtureThread height="h-[150rem]" messages={REVIEW_QUOTE_STATES} />
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
  // The design tray as a thread docks it, and the providers it reads.
  ...(
    ["AskDesign", "SaveDesignAnswerProvider", "TraySlotProvider"] as const
  ).map((name) => ({
    name,
    render: () => (
      <SaveDesignAnswerProvider value={async () => undefined}>
        <FixtureThread
          height="h-[44rem]"
          isDisabled={false}
          settings={{
            placeholder: "Ask Fern anything…",
            questionPlaceholder: "Or tell Fern something else…",
          }}
          messages={[
            {
              content: [
                {
                  args: ASK_DESIGN_INPUT,
                  toolCallId: "design_pending",
                  toolName: "ask_design",
                  type: "tool-call" as const,
                },
              ],
              role: "assistant",
              status: WAITING,
            },
          ]}
        />
      </SaveDesignAnswerProvider>
    ),
  })),
  {
    name: "GeneratedPhotos",
    render: () => (
      <div className="max-w-xl">
        <GeneratedPhotos
          actions={{ onRemove: noop, onTryAnother: noop, onUseOwn: noop }}
          photos={[
            {
              alt: "A bright kitchen after a clean",
              section: "hero",
              slot_id: "hero",
              src: KITCHEN,
            },
            {
              alt: "The team at work",
              section: "about",
              slot_id: "about",
            },
          ]}
        />
      </div>
    ),
  },
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
          />
          <SiteReady
            error="A newer version replaced that one. Check the latest before you decide."
            onApprove={noop}
            onMakeChanges={noop}
            onSeePreview={noop}
          />
          <SiteReady
            approved
            onApprove={noop}
            onMakeChanges={noop}
            onSeePreview={noop}
          />
        </div>
      </div>
    ),
  },
  {
    // The photos the build made, each from its own thumbnail.
    name: "SiteReady with photos",
    render: () => (
      <div className="max-w-2xl">
        <SiteReady
          onApprove={noop}
          onMakeChanges={noop}
          onSeePreview={noop}
          photoActions={{ onRemove: noop, onTryAnother: noop, onUseOwn: noop }}
          photos={[
            {
              alt: "A bright, tidy living room in morning light",
              section: "hero",
              slot_id: "hero",
              src: KITCHEN,
            },
          ]}
        />
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
  {
    name: "RecordReview",
    render: () => (
      <FixtureThread height="h-[180rem]" messages={RECORD_REVIEW_STATES} />
    ),
  },
  {
    name: "ConnectDomain",
    render: () => (
      <FixtureThread height="h-[230rem]" messages={CONNECT_DOMAIN_STATES} />
    ),
  },
  {
    name: "RemoveDomain",
    render: () => (
      <FixtureThread height="h-[180rem]" messages={REMOVE_DOMAIN_STATES} />
    ),
  },
  {
    name: "FindDomain",
    render: () => (
      <FixtureThread height="h-[60rem]" messages={FIND_DOMAIN_STATES} />
    ),
  },
  // The purchase card and the provider that gives it the app's checkout.
  ...(["BuyDomain", "DomainPurchaseProvider"] as const).map((name) => ({
    name,
    render: () => (
      <DomainPurchaseProvider value={CATALOG_PURCHASE}>
        <FixtureThread height="h-[260rem]" messages={BUY_DOMAIN_STATES} />
      </DomainPurchaseProvider>
    ),
  })),
  {
    name: "DomainCheck",
    render: () => (
      <FixtureThread height="h-[100rem]" messages={CHECK_DOMAIN_STATES} />
    ),
  },
  {
    name: "ConnectGoogle",
    render: () => (
      <FixtureThread height="h-[60rem]" messages={CONNECT_GOOGLE_STATES} />
    ),
  },
  {
    name: "ServerButtonUI",
    render: () => (
      <FixtureThread height="h-[34rem]" messages={POSTED}>
        <ServerButtonUI />
      </FixtureThread>
    ),
  },
  {
    name: "MemoryChipUI",
    render: () => (
      <FixtureThread height="h-[24rem]" messages={REMEMBERED}>
        <MemoryChipUI />
      </FixtureThread>
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
          briefing:
            "Your website is live. A new version is ready for you to approve.",
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
  { name: "ThreadSend", render: () => <SendingThread streamed={false} /> },
  { name: "ThreadSendStreamed", render: () => <SendingThread streamed /> },
  { name: "ThreadReveal", render: () => <RevealSample /> },
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
      <div className="h-128">
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
  // A stored conversation with nothing in it yet, as onboarding opens: the
  // same welcome and suggestions, composer in the middle.
  {
    name: "Conversation stored and empty",
    render: () => <ConversationSample stored="stored-1" />,
  },
  {
    name: "ThreadError",
    render: () => <OwnerThread height="h-[28rem]" messages={FAILED} />,
  },
]

export { assistantCatalog }
