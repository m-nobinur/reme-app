import {
  AssistantRuntimeProvider,
  AuiConfig,
  type ThreadMessageLike,
  type ThreadSuggestion,
  Tools,
  useExternalStoreRuntime,
} from "@assistant-ui/react"
import { CopyIcon, GlobeIcon, GoogleLogoIcon } from "@phosphor-icons/react"
import {
  ADDRESS_ASK,
  type AskChoiceInput,
  type DomainPurchaseStatus,
  FONTS,
  INDUSTRIES,
  ONBOARDING_GOAL,
  PALETTES,
  PRONOUNS,
  type QuoteField,
  type ServerMessageKind,
  TEMPLATES,
  TONES,
  TOOL_CALL_CANCELLED,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_TYPES,
} from "@workspace/contracts"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { ChoiceForm } from "@workspace/ui/components/assistant/ask-choice"
import { BuildQuestionsUI } from "@workspace/ui/components/assistant/build-questions"
import {
  type DomainPurchase,
  SKIP_DOMAIN,
} from "@workspace/ui/components/assistant/buy-domain"
import { ChangeAskedUI } from "@workspace/ui/components/assistant/change-asked"
import { ChipRow } from "@workspace/ui/components/assistant/chip-row"
import { makeEnquiryCardUI } from "@workspace/ui/components/assistant/enquiry-card"
import { ConnectGoogleRow } from "@workspace/ui/components/assistant/google"
import { MemoryChipUI } from "@workspace/ui/components/assistant/memory-chip"
import { PayDialog } from "@workspace/ui/components/assistant/pay-dialog"
import { PersonaCardUI } from "@workspace/ui/components/assistant/persona-card"
import { TrayFrame } from "@workspace/ui/components/assistant/question-tray"
import { QuoteFormPreview } from "@workspace/ui/components/assistant/quote-form-preview"
import { ReplyPill } from "@workspace/ui/components/assistant/reply-pill"
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
import { ownerToolkit } from "@workspace/ui/components/assistant/toolkit"
import { TooltipIconButton } from "@workspace/ui/components/assistant/tooltip-icon-button"
import {
  DockedUpdates,
  type Update,
  UpdateDeck,
  UpdateIcon,
  UpdateKindIcon,
  UpdateRow,
} from "@workspace/ui/components/assistant/update-deck"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import { SitePictures } from "@workspace/ui/components/site-pictures"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { WorkspaceShell } from "@workspace/ui/components/workspace-shell"
import { FACT_INPUTS } from "@workspace/ui/lib/answer"
import { ChatServicesProvider } from "@workspace/ui/lib/chat-services"
import { BROKEN, designText } from "@workspace/ui/lib/tool-state"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { ICON } from "./panel-entries"
import {
  INPUT as ASK_DESIGN_INPUT,
  DESIGN_ANSWERS,
  TRAY_SERVICES,
} from "./tray-entries"

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
/** The cards a thread draws, registered as the app registers them. */
const TOOLKIT = AuiConfig({ tools: Tools({ toolkit: ownerToolkit }) })

/** A fixed zone, so the catalog reads the same on every machine, and the one open question. */
const COS_TOOLS_FIXTURE = {
  zone: "Europe/London",
  question: (requestId: string) =>
    requestId === "0f4b2c8e-1a3d-4e5f-9b6c-7d8e9f0a1b2c"
      ? "Service area"
      : null,
  removeReminder: async () => ({ done: true }),
}

const FIXTURE_TIME = new Date("2026-09-24T09:00:00Z")

const REMEMBER_CALL: ThreadMessageLike[] = [
  { content: "I'd rather you call me after 4pm.", role: "user" },
  {
    content: [
      {
        args: {
          target: "user",
          operations: [{ action: "add", content: "Prefers calls after 4pm" }],
        },
        result: {
          outcome: "saved",
          target: "user",
          note: "Saved.",
          fullness: "2%, 23/1,500 chars",
        },
        toolCallId: "call_memory",
        toolName: "memory",
        type: "tool-call",
      },
      { text: "Got it, after 4pm from now on.", type: "text" },
    ],
    role: "assistant",
  },
]

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
    // A card's answer goes nowhere in a fixture, which is not an error.
    onAddToolResult: noop,
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
    <AssistantRuntimeProvider config={TOOLKIT} runtime={runtime}>
      {children}
      <div
        className={
          bare
            ? height
            : `${height} overflow-hidden rounded-3xl border border-border`
        }
      >
        <ChatServicesProvider value={{ cosTools: COS_TOOLS_FIXTURE }}>
          <Thread
            autoFocus={false}
            components={{ ToolFallback: Approval }}
            {...settings}
          />
        </ChatServicesProvider>
      </div>
    </AssistantRuntimeProvider>
  )
}

/**
 * An ask in its settled states, in one thread, then each open question in a
 * thread of its own, so its tray docks alone above the composer as it does
 * in the app.
 */
function TrayStates({
  settled,
  open,
  height,
}: {
  settled: ThreadMessageLike[]
  open: ThreadMessageLike[]
  height: string
}) {
  return (
    <div className="flex flex-col gap-8">
      <FixtureThread height={height} messages={settled} />
      {open.map((message, index) => (
        <FixtureThread
          height="h-[44rem]"
          isDisabled={false}
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of fixtures
          key={index}
          messages={[message]}
          settings={{
            placeholder: "Ask Sam anything…",
            questionPlaceholder: "Tell Sam what to do instead…",
          }}
        />
      ))}
    </div>
  )
}

/** The composer's surroundings as the owner app sets them: the "+" starters. */
const SUGGESTIONS: ThreadSuggestion[] = [
  { prompt: "What changed in the new version?" },
  { prompt: "What do you need from me?" },
  { prompt: "What is on my website now?" },
]

/** More than a phone's width holds, as the owner's follow-ups can be. */
const LONG_SUGGESTIONS: ThreadSuggestion[] = [
  { prompt: "Draft three onboarding prompts" },
  { prompt: "Turn this into a checklist" },
  { prompt: "Write copy for the welcome screen" },
  { prompt: "Summarise this week's enquiries" },
]

/** A row of chips on a phone, scrolled in from both edges so both fades show. */
function ScrolledChips() {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    box.current
      ?.querySelector('[data-slot="chip-row"]')
      ?.scrollTo({ left: 120 })
  }, [])
  return (
    <div className="w-[390px] px-4" ref={box}>
      <ChipRow aria-label="Suggestions" role="group">
        {LONG_SUGGESTIONS.map(({ prompt }) => (
          <ReplyPill key={prompt}>{prompt}</ReplyPill>
        ))}
      </ChipRow>
    </div>
  )
}

/** A thread as the app mounts it for the owner: its composer settings, and thumbs on every reply with words. */
function OwnerThread(props: Parameters<typeof FixtureThread>[0]) {
  return (
    <FixtureThread
      rates
      {...props}
      settings={{
        assistant: "Reme",
        placeholder: "Ask Reme anything…",
        questionPlaceholder: "Tell Reme what to do instead…",
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

/** An `ask_open` call in one of its states. */
const askOpen = (
  about: string,
  extra: { result?: unknown; isError?: boolean; skippable?: boolean } = {}
) => ({
  args: { about, ...(extra.skippable ? { skippable: true } : {}) },
  isError: extra.isError,
  result: extra.result,
  toolCallId: `open_${about}_${extra.isError ? "error" : extra.result ? "done" : "open"}`,
  toolName: "ask_open",
  type: "tool-call" as const,
})

const ASK_OPEN_STATES: ThreadMessageLike[] = [
  ...answeredStep(
    "Which areas do you cover?",
    askOpen("service_area.text", {
      result: { answer: "stated", text: "Leeds and about ten miles round" },
    }),
    "Leeds and about ten miles round"
  ),
  ...answeredStep(
    "Who are your customers?",
    askOpen("business.audience", { result: { answer: "skipped" } }),
    "Skipped"
  ),
  {
    content: [
      askOpen("business.proof", {
        isError: true,
        result: { error: TOOL_CALL_CANCELLED },
      }),
    ],
    role: "assistant",
    status: DONE,
  },
]

const ASK_OPEN_OPEN: ThreadMessageLike[] = [
  {
    content: [
      question(
        "To quote a clean, what do you need to know first? Rooms, how often, anything else."
      ),
      askOpen("quote.form"),
    ],
    role: "assistant",
    status: WAITING,
  },
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
    "Skipped"
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
]

/** The questions still open, each docked in a thread of its own. */
const ASK_FACT_OPEN: ThreadMessageLike[] = [
  {
    content: [
      askFact("business.email", {
        prefill: { address: "hello@brightclean.test" },
      }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [askFact("hours.weekday", { skippable: true })],
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
    ideas?: string[]
    sign_in_email?: string
  } = {}
) => ({
  args: {
    step,
    prefill: (extra.prefill ?? []) as [],
    skippable: extra.skippable ?? false,
    ...(extra.ideas ? { ideas: extra.ideas } : {}),
    ...(extra.sign_in_email ? { sign_in_email: extra.sign_in_email } : {}),
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
    "07700 900123 · sam@brightclean.example"
  ),
  ...answeredStep(
    "And your assistant?",
    askDetails("assistant", {
      result: { answer: "skipped" },
      skippable: true,
    }),
    "Skipped"
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
]

/** The questions still open, each docked in a thread of its own. */
const ASK_DETAILS_OPEN: ThreadMessageLike[] = [
  {
    content: [
      question("How can customers reach Brightclean?"),
      askDetails("contact", {
        sign_in_email: SIGN_IN_EMAIL.value.address,
      }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("Last thing: what should your assistant be called?"),
      askDetails("assistant", {
        skippable: true,
        ideas: ["Poppy", "Hannah", "Rosa"],
      }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("Ava it is. How should she look?"),
      askDetails("assistant", {
        prefill: [
          { key: "assistant.name", value: { name: "Ava" } },
          { key: "assistant.pronouns", value: { id: "she_her" } },
        ],
      }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("Here's your assistant as it comes. Change anything you like."),
      askDetails("assistant", {
        prefill: [
          { key: "assistant.pronouns", value: { id: "they_them" } },
          { key: "assistant.avatar", value: { id: "reme" } },
          { key: "assistant.tone", value: { id: "friendly" } },
        ],
      }),
    ],
    role: "assistant",
    status: WAITING,
  },
  {
    content: [
      question("And the email?"),
      askDetails("contact", {
        prefill: [{ key: "business.phone", value: { e164: "+447700900123" } }],
        sign_in_email: SIGN_IN_EMAIL.value.address,
      }),
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

/** The quick reply rows above the composer: each thread ends on the question its row answers. */
const QUICK_REPLIES: [string, ThreadMessageLike][] = [
  [
    "Recap",
    {
      content: [
        question(
          "Here's what I have for BioPeck Clean:\n\n- **Services:** regular house cleaning, end of tenancy cleans and oven cleaning\n- **Not taken on:** offices or commercial sites\n- **Area:** Leeds and 15 miles around it\n- **Quote form:** 8 questions\n- **Contact:** 0113 496 0123, hello@biopeck.example\n\nHave I got that right?"
        ),
        askOpen("recap"),
      ],
      role: "assistant",
      status: WAITING,
    },
  ],
  [
    "Website offer",
    {
      content: [
        question(
          "People who can't find you online often go to someone they can. A website puts BioPeck Clean in front of people looking for a cleaning company in Leeds, and every quote request comes straight to me with the details you need.\n\nShall I build a website?"
        ),
        askChoice("build_for_me", [
          { id: "yes", label: "Yes, build my website" },
          { id: "skip", label: "No, I already have one" },
        ]),
      ],
      role: "assistant",
      status: WAITING,
    },
  ],
  [
    "Skip this one",
    {
      content: [
        question(
          "Who's behind BioPeck Clean, and what sets it apart? Years trading, insurance or a guarantee all help."
        ),
        askOpen("business.proof", { skippable: true }),
      ],
      role: "assistant",
      status: WAITING,
    },
  ],
]

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
  initial: ["mint", "mist_teal", "garden", "stone_sage"],
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
    { shown: ["deep_sea", "forest_calm", "ocean_deep", "charcoal"] },
  ],
  ["Own colour, picked", { other: brandOf("mineral") }],
  [
    "Own colour, too light for white text",
    {
      other:
        PALETTES.find((each) => each.id === "fern")?.swatches[0] ??
        brandOf("fern"),
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
    "Skipped"
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
]

/** The questions still open, each docked in a thread of its own. */
const ASK_CHOICE_OPEN: ThreadMessageLike[] = [
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
  {
    content: [
      question(
        "Your website turns visitors into enquiries. Shall I build it for you?"
      ),
      askChoice("build_for_me", [
        { id: "yes", label: "Yes, build my website" },
        { id: "skip", label: "No, I already have one" },
      ]),
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
    "Skipped"
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
]

/** The questions still open, each docked in a thread of its own. */
const ASK_UPLOAD_OPEN: ThreadMessageLike[] = [
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
  type: QuoteField["type"],
  extra: { required?: boolean; hint?: string; options?: string[] } = {}
) => ({
  key,
  label,
  type,
  required: extra.required ?? true,
  hint: extra.hint ?? null,
  options: extra.options ?? null,
})

const PARKING = quoteField(
  "parking",
  "Is there parking outside the property for the driver to use",
  "select",
  {
    hint: "Permits are not needed",
    options: ["Off-street", "On-street", "None"],
  }
)

const LIMOUSINE_QUESTIONS = [
  quoteField("pickup", "Pick-up address", "text", { hint: "Street and town" }),
  quoteField("dropoff", "Drop-off address", "text"),
  quoteField("journey_date", "Date and time of the journey", "datetime"),
  quoteField("passengers", "Passengers", "number"),
  quoteField("vehicle", "Vehicle", "radio", {
    hint: "The minibus seats up to 16",
    options: ["Saloon", "Stretch limousine", "Minibus"],
  }),
  quoteField("occasion", "Occasion", "select", {
    required: false,
    options: ["Wedding", "Airport transfer", "Night out", "Business"],
  }),
  PARKING,
  quoteField(
    "notes",
    "Anything else we should know before we quote",
    "textarea",
    {
      required: false,
    }
  ),
]

/** One question of every type the contract allows. */
const EVERY_TYPE_QUESTIONS = [
  quoteField("summary", "What do you need doing", "text", {
    hint: "A line is enough",
  }),
  quoteField("details", "Tell us more", "textarea", { required: false }),
  quoteField("passengers", "Passengers", "number"),
  quoteField("journey_day", "Day of the journey", "date"),
  quoteField("journey_time", "Date and time of the journey", "datetime"),
  quoteField("occasion", "Occasion", "select", {
    required: false,
    options: ["Wedding", "Airport transfer", "Night out", "Birthday"],
  }),
  PARKING,
  quoteField("vehicle", "Vehicle", "radio", {
    hint: "The minibus seats up to 16",
    options: ["Saloon", "Stretch limousine", "Minibus"],
  }),
  quoteField("extras", "Extras", "checkbox", {
    required: false,
    options: ["Child seat", "Champagne", "Red carpet"],
  }),
  quoteField("pickup_photos", "Photos of the pick-up point", "photos", {
    required: false,
  }),
  quoteField("second_phone", "A second number", "tel", { required: false }),
  quoteField("billing_email", "Email for the invoice", "email", {
    required: false,
  }),
]

/** The preview's button, with what the modal's "Looks good" did beside it. */
function QuotePreviewSample() {
  const [confirmed, setConfirmed] = useState(false)
  return (
    <div className="flex items-center gap-3 p-4">
      <QuoteFormPreview
        fields={EVERY_TYPE_QUESTIONS}
        onConfirm={() => setConfirmed(true)}
      />
      {confirmed ? (
        <p className="text-muted-foreground text-sm" role="status">
          Confirmed
        </p>
      ) : null}
    </div>
  )
}

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
    "Looks good"
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
]

/** The owner's own messages by length: twelve lines, eight (as long as one stays whole) and one. */
const LONG_MESSAGES: ThreadMessageLike[] = [
  {
    content: "Tell me about the business.",
    role: "assistant",
    status: DONE,
  },
  reply(
    [
      "Here is everything, so you do not have to ask.",
      "",
      "Weekly and fortnightly home cleans",
      "End of tenancy cleans with a deposit guarantee",
      "Deep cleans before and after a move",
      "Oven and appliance cleans",
      "Office cleans, evenings only",
      "",
      "We cover Leeds, Headingley, Roundhay and Horsforth.",
      "Fully insured, and we bring our own supplies.",
      "Prices start at £14 an hour with a two hour minimum.",
    ].join("\n")
  ),
  { content: "Thanks, that is plenty.", role: "assistant", status: DONE },
  reply(Array.from({ length: 8 }, (_, i) => `Item ${i + 1}`).join("\n")),
  { content: "Got it.", role: "assistant", status: DONE },
  reply("Short and sweet."),
]

/** The questions still open, each docked in a thread of its own. */
const REVIEW_QUOTE_OPEN: ThreadMessageLike[] = [
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
          quoteField("photos", "Photos of the rooms", "photos", {
            required: false,
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
  // A way to see the card's failure state: a file named broken never goes up.
  if (files.some((file) => file.name.startsWith("broken"))) {
    throw new Error("The upload failed.")
  }
  return {
    assets: files.map((file, index) => ({
      ...PHOTO,
      id: `0b6c1e5d-8d2a-4f3b-9c4d-2e1a7b6c5d${String(index).padStart(2, "0")}`,
      name: file.name,
    })),
  }
}

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
  requestChange("started", "Add a page for end of tenancy cleans.", {
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
        code: "change.build_busy",
        message: "A build is finishing. Try again once it settles.",
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
  cosCall("get_change", "change_found", {
    args: { ref: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e" },
    result: {
      outcome: "found",
      ref: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e",
      label: "your hero text",
      asked: "Make the hero text professional",
      state: "ready for the owner to look over",
      done: "Reworded the hero heading and subheading.",
      as_asked: true,
      text_changes: [
        {
          before: "We clean homes",
          after: "Professional home cleaning in Bristol",
          pages: ["/"],
        },
      ],
      left_out: [],
      preview: { expires_at: LATER },
      live_now: false,
      published_at: null,
      recorded: true,
      edit_type: null,
      targets: [],
      checks: [],
      blocks: [],
      recent: [],
    },
  }),
  cosCall("get_change", "change_none", {
    args: { ref: "5b0f6c1e-8d2a-4f3b-9c4d-2e1a7b6c5d4e" },
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
  {
    outcome: "created",
    reminder_id: "5e2d7c1a-9b3f-4a6e-8c2d-1f0e9a8b7c6d",
    due_at: "2026-10-02T08:00:00.000Z",
  },
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
  id: "godaddy",
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
// named and its own link, with the bare-address alias in the provider's own
// field names, traced only by its nameservers, with nothing traceable, a
// subdomain's one record, one that may touch email, one with no records to
// show, and one the provider can add through Domain Connect.
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
    provider: {
      id: "namecheap",
      name: "Namecheap",
      settings_url: "https://ap.www.namecheap.com/domains/list/",
    },
    steps: [WWW, { type: "ALIAS", name: "@", value: "domains.remeai.co.uk" }],
  }),
  connecting("traceable", {
    outcome: "connecting",
    method: "records",
    email_affected: false,
    apex: "forward",
    nameserver_host: "katapult.io",
    steps: [WWW],
  }),
  connecting("unknown", {
    outcome: "connecting",
    method: "records",
    email_affected: false,
    apex: "forward",
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
  connecting("add_for_me", {
    outcome: "connecting",
    method: "domain_connect",
    email_affected: false,
    apex: "forward",
    provider: {
      id: "cloudflare",
      name: "Cloudflare",
      settings_url:
        "https://dash.cloudflare.com/?to=/:account/sparkleclean.co.uk/dns/records",
    },
    steps: [WWW],
    apply_url:
      "https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/remeai.co.uk/services/website/apply?domain=sparkleclean.co.uk&host=www&key=_dck1&sig=example",
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

const PRUNX = "prunx.bnwise.tech"
const PRUNX_RECORDS = {
  outcome: "connecting",
  method: "records",
  email_affected: false,
  provider: {
    id: "cloudflare",
    name: "Cloudflare",
    settings_url:
      "https://dash.cloudflare.com/?to=/:account/bnwise.tech/dns/records",
  },
  steps: [{ type: "CNAME", name: "prunx", value: "domains.remeai.co.uk" }],
}

/** A connect the owner's typed name ran, with no card. */
const typedConnect = (id: string) =>
  cosCall("connect_domain", `connect_${id}`, {
    args: { name: PRUNX },
    result: PRUNX_RECORDS,
  })

// The steps for a name the owner typed, at Cloudflare; then the same steps
// once the owner has asked for a new name instead, folded to one line.
const CONNECT_STEPS_NOW: ThreadMessageLike[] = [
  ask(`Yes, it's ${PRUNX}`),
  typedConnect("typed"),
]

const REMOVE_DOMAIN_STATES = decisionStates(
  "remove_domain",
  { name: DOMAIN },
  { name: 7 },
  { outcome: "removed" },
  refusal("domain.not_found", "That domain is not connected.")
)

// What domain_bought answers once the owner says they bought it: a look still
// running, the connect's records, the registry not showing the name yet, and a refusal.
const bought = (id: string, result?: unknown) =>
  cosCall(
    "domain_bought",
    `bought_${id}`,
    { args: { name: DOMAIN }, result },
    result === undefined ? IN_FLIGHT : DONE
  )
const DOMAIN_BOUGHT_STATES = [
  bought("looking"),
  bought("connecting", {
    outcome: "connecting",
    method: "records",
    email_affected: false,
    apex: "forward",
    provider: GODADDY,
    steps: [WWW],
  }),
  bought("not_yet", { outcome: "not_registered_yet", name: DOMAIN }),
  bought(
    "refused",
    refusal("domain.in_use", "That domain belongs to another business.")
  ),
]

const FREE_UK = { state: "free", price_gbp_year: 8 } as const
const FREE_COM = { state: "free", price_gbp_year: 12 } as const
const TAKEN = { state: "taken" } as const
const CF_UK = { state: "free", registrar_usd: 5.3 } as const
const CF_COM = { state: "free", registrar_usd: 10.46 } as const
const FREE = { state: "free" } as const

/** Six names for Pruning Co as the registrar checked them, with buying here off. */
const PRUNING_ROWS = {
  outcome: "found",
  rows: [
    {
      stem: "pruningco",
      why: "matches your business name",
      endings: { "co.uk": CF_UK, uk: CF_UK, com: CF_COM, co: FREE },
    },
    {
      stem: "pruningleeds",
      why: "your name plus Leeds",
      endings: { "co.uk": CF_UK, uk: CF_UK, com: CF_COM, co: TAKEN },
    },
    {
      stem: "pruningtrees",
      why: "your name plus trees",
      endings: { "co.uk": CF_UK, uk: TAKEN, com: CF_COM, co: FREE },
    },
    {
      stem: "leedstreesurgery",
      why: "Leeds plus what you do",
      endings: { "co.uk": CF_UK, uk: CF_UK, com: TAKEN, co: TAKEN },
    },
    {
      stem: "pruning-leeds",
      why: "your name and Leeds, with a dash",
      endings: { "co.uk": CF_UK, uk: CF_UK, com: CF_COM, co: FREE },
    },
    {
      stem: "pruningsurgery",
      why: "your name plus surgery",
      endings: { "co.uk": CF_UK, uk: CF_UK, com: CF_COM, co: FREE },
    },
  ],
  usd_gbp: 0.7457,
} as const

const CONNECT_STEPS_PAUSED: ThreadMessageLike[] = [
  ask(`Yes, it's ${PRUNX}`),
  typedConnect("paused"),
  ask("No, help me get one"),
  cosCall("find_domain", "find_after", {
    args: {},
    result: PRUNING_ROWS,
  }),
]

// What find_domain answers: a search still running, a refusal with none
// free, then six names with buying here off, in the message.
const FIND_DOMAIN_STATES: ThreadMessageLike[] = [
  ask("No, help me get one"),
  cosCall(
    "find_domain",
    "find_running",
    { args: { step: "Looking for names for Pruning Co" } },
    IN_FLIGHT
  ),
  cosCall("find_domain", "find_none", {
    args: { query: "sparkle" },
    result: refusal("domain.unavailable", "That name isn't free to register."),
  }),
  cosCall("find_domain", "find_found", { args: {}, result: PRUNING_ROWS }),
]

/** Skipped, then asked again: the first list gives way to the fresh one. */
const FIND_DOMAIN_AGAIN: ThreadMessageLike[] = [
  ask("No, help me get one"),
  cosCall("find_domain", "find_first", { args: {}, result: PRUNING_ROWS }),
  ask(SKIP_DOMAIN),
  ask("Can you show me some domains again?"),
  cosCall("find_domain", "find_again", { args: {}, result: PRUNING_ROWS }),
]

/** The same names with buying here on: Reme's price, and Buy for it once chosen. */
const FIND_DOMAIN_BUY_HERE: ThreadMessageLike[] = [
  ask("I don't have a website address. Can you sort one?"),
  cosCall("find_domain", "find_found_here", {
    args: {},
    result: {
      outcome: "found",
      buy_here: true,
      rows: [
        {
          stem: "sparkleclean",
          why: "Short, and it is your name.",
          endings: { "co.uk": FREE_UK, com: TAKEN, uk: FREE_UK },
        },
        {
          stem: "sparklecleanbristol",
          why: "Says where you work.",
          endings: { "co.uk": FREE_UK, com: FREE_COM, uk: FREE_UK },
        },
      ],
    },
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

// No Stripe in the catalog: Pay answers as an environment without buying
// does, and the details page asks for the address only.
const CATALOG_PURCHASE: DomainPurchase = {
  registrant: async (name) => ({
    name,
    price_gbp_year: name.endsWith(".com") ? 12 : 8,
    registrant: {
      name: REGISTRANT.name,
      business_name: REGISTRANT.business_name,
      email: REGISTRANT.email,
      phone: REGISTRANT.phone,
    },
    missing: ["street", "city", "postal_code", "country_code"],
  }),
  elsewhere: async () => undefined,
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

/** The reply to the assistant set-up, after Pick for me: the persona as set. */
const PERSONA: ThreadMessageLike[] = [
  ask("Pick for me"),
  {
    content: [
      {
        text: "I've gone with Reme, she/her, with a professional manner.",
        type: "text",
      },
      {
        type: "data",
        name: "persona",
        data: {
          name: "Reme",
          pronouns: "she_her",
          avatar: "she_1",
          tone: "professional",
        },
      },
    ],
    role: "assistant",
    status: DONE,
  },
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

/** A change asked for in the panel: the owner's words, then the resolved line. */
const CHANGE_ASKED: ThreadMessageLike[] = [
  ask("Make the hero say end of tenancy cleans."),
  {
    content: [
      {
        type: "data",
        name: "change_asked",
        data: { text: "Make the hero say end of tenancy cleans." },
      },
    ],
    role: "assistant",
    status: DONE,
  },
]

/** A quote request from the owner's website, as the deliveries outbox posts it. */
const ENQUIRY: ThreadMessageLike[] = [
  {
    content: [
      { type: "text", text: "You have a new quote request from your website." },
      {
        type: "data",
        name: "enquiry",
        data: {
          id: "00000000-0000-4000-8000-0000000000e1",
          name: "Priya Shah",
          email: "priya@example.com",
          phone: "07700 900123",
          answers: [
            { label: "Property address", value: "Flat 4, 12 Albion Road, N16" },
            { label: "Type of clean", value: "End of tenancy" },
            { label: "Bedrooms", value: "2" },
          ],
          photos: [],
        },
      },
    ],
    role: "assistant",
    status: DONE,
  },
]
const EnquiryCardUI = makeEnquiryCardUI((id) => `/photos/${id}`)

/** Three questions a build waits on, posted by the assistant as one stack. */
const BUILD_QUESTIONS: ThreadMessageLike[] = [
  {
    content: [
      {
        text: "Three quick things before I finish your website.",
        type: "text",
      },
      {
        type: "data",
        name: "build_questions",
        data: {
          kind: "build",
          assignment_id: "00000000-0000-4000-8000-0000000000b1",
          questions: [
            {
              id: "00000000-0000-4000-8000-0000000000c1",
              text: "What hours are you open on weekdays?",
              input: { kind: "fact", key: "hours.weekday" },
              skippable: false,
            },
            {
              id: "00000000-0000-4000-8000-0000000000c2",
              text: "How often do most customers book you?",
              input: {
                kind: "choice",
                options: ["Weekly", "Fortnightly", "Monthly"],
              },
              skippable: true,
            },
            {
              id: "00000000-0000-4000-8000-0000000000c3",
              text: "Is there anywhere customers should park?",
              input: { kind: "text", maxLength: 200, email: false },
              skippable: true,
            },
          ],
        },
      },
    ],
    role: "assistant",
    status: DONE,
  },
]

/** The web address stack: a quick choice, then the name after Yes. */
const ADDRESS_QUESTIONS: ThreadMessageLike[] = [
  {
    content: [
      {
        text: "While I build the site in the background, let's sort out your web address.",
        type: "text",
      },
      {
        type: "data",
        name: "build_questions",
        data: {
          kind: "address",
          questions: [
            {
              id: "00000000-0000-4000-8000-0000000000d1",
              text: ADDRESS_ASK.have,
              input: {
                kind: "choice",
                options: [ADDRESS_ASK.yes, ADDRESS_ASK.no, ADDRESS_ASK.later],
              },
              skippable: false,
            },
            {
              id: "00000000-0000-4000-8000-0000000000d2",
              text: ADDRESS_ASK.name,
              input: { kind: "text", maxLength: 253, email: false },
              skippable: true,
            },
          ],
        },
      },
    ],
    role: "assistant",
    status: DONE,
  },
]

/** Stores every answer after a moment, so the tick and the move on show. */
const answerSlowly = () =>
  new Promise<null>((done) => setTimeout(() => done(null), 400))

/** Messages the assistant posted on its own, each with the button it can carry. */
/** A decision the CoS ended its reply on, with the pills it offered. */
const DECISION: ThreadMessageLike[] = [
  ask("Hi, any news?"),
  {
    content: [
      {
        text: "Your website is ready to go live. Did you manage to buy brightwaycleaning.co.uk?",
        type: "text",
      },
      {
        args: {
          choices: [
            { label: "Bought it", send: "I've bought brightwaycleaning.co.uk" },
            {
              label: "Not yet",
              send: "I haven't bought brightwaycleaning.co.uk yet",
            },
          ],
        },
        result: { outcome: "offered" },
        toolCallId: "call_choices",
        toolName: "offer_choices",
        type: "tool-call",
      },
    ],
    role: "assistant",
    status: DONE,
  },
]

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
  {
    content: [
      {
        text: "Google needs one more permission. Connect again and leave both boxes ticked.",
        type: "text",
      },
      {
        type: "data",
        name: "button",
        data: {
          label: "Reconnect Google",
          action: { kind: "connect", service: "google" },
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
  ask("How do I point my domain at the site?"),
  {
    content: [
      {
        text: `Your registrar needs one record, and it takes about five minutes:

1. Open your DNS settings and sign in if asked.
2. Add a **CNAME** record named \`shop\` that points to \`sites.example.net\`.
3. Come back here, and I'll check it for you.

Nothing changes on your website until the record is live. Your registrar's [DNS guide](https://example.net/dns) has screenshots.`,
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

/**
 * A conversation this browser last showed up to "Publishing now", with two
 * updates the app posted since: the site going live, then a reminder.
 */
const NEW_SINCE: ThreadMessageLike[] = [
  on("29T14:01:00.000", { ...ask("Can you publish it?"), id: "publish" }),
  on("29T14:01:30.000", {
    content: [
      {
        text: "Publishing now. I'll tell you when it's live.",
        type: "text",
      },
    ],
    id: "publishing",
    role: "assistant",
    status: DONE,
  }),
  on("29T14:14:00.000", {
    content: [
      { text: "Your website is live at sparkle-clean.co.uk.", type: "text" },
      {
        type: "data",
        name: "button",
        data: {
          label: "View site",
          action: { kind: "open", url: "https://sparkle-clean.co.uk/" },
        },
      },
    ],
    id: "srv_live",
    role: "assistant",
    status: DONE,
  }),
  on("29T15:00:00.000", {
    content: [{ text: "Reminder: call Sam about Friday.", type: "text" }],
    id: "srv_reminder",
    role: "assistant",
    status: DONE,
  }),
]

/** One posted message of a kind, as the app stores it: words, then its kind. */
const posted = (
  at: string,
  id: string,
  text: string,
  kind?: ServerMessageKind
): ThreadMessageLike =>
  on(at, {
    content: [
      { text, type: "text" },
      ...(kind ? [{ type: "data" as const, name: "kind", data: kind }] : []),
    ],
    id,
    role: "assistant",
    status: DONE,
  })

/**
 * Every kind of message the app posts: a reply reads as any reply, and the
 * rest carry their label and mark, the newest in the primary colour.
 */
const KINDS: ThreadMessageLike[] = [
  on("29T13:04:00.000", { ...ask("Skip for now"), id: "skip" }),
  posted(
    "29T13:04:02.000",
    "srv_reply",
    "No problem. Your site can go live on its free address, and you can add your own any time from the Connect now button.",
    "reply"
  ),
  posted(
    "29T13:09:00.000",
    "srv_update",
    "Your website build hit a problem, so I'm starting it again. Nothing for you to do: I'll say here when the draft is ready."
  ),
  posted(
    "29T13:10:00.000",
    "srv_note",
    "Your website build stopped again: a service it relies on kept failing. Say try again, or tell me what to change.",
    "note"
  ),
  posted(
    "29T13:31:00.000",
    "srv_done",
    "Your draft is ready, with Home, Services, About and Contact pages. Have a look below.",
    "done"
  ),
  posted(
    "29T15:00:00.000",
    "srv_reminder",
    "Reminder: “call Sam about Friday”",
    "reminder"
  ),
]

/**
 * The "New" rule and the update labels. The mark moves as the thread shows
 * messages, as the app's does; Open again is the next visit, with none new.
 */
function NewSinceSample() {
  const [visit, setVisit] = useState(0)
  const [lastShown] = useState(() => {
    let mark: string | null = "publishing"
    return {
      get: () => mark,
      set: (_conversation: string, id: string) => {
        mark = id
      },
    }
  })
  return (
    <div className="flex flex-col gap-3">
      <Button
        className="self-start"
        onClick={() => setVisit((count) => count + 1)}
        size="sm"
        variant="outline"
      >
        Open again
      </Button>
      <OwnerThread
        height="h-[36rem]"
        key={visit}
        messages={NEW_SINCE}
        settings={{ lastShown }}
        stored="stored-new"
      >
        <ServerButtonUI />
      </OwnerThread>
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
    onAddToolResult: noop,
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
    <AssistantRuntimeProvider config={TOOLKIT} runtime={runtime}>
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
            "Your website is live. Your latest changes are ready to publish.",
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

/** A first version ready to review, with its pictures and a preview. */
const READY = {
  title: "Brightclean website",
  meta: "Not published · Today, 4:05 pm",
  pictures: {
    laptop: KITCHEN,
    "laptop-2": KITCHEN,
    phone: KITCHEN,
    icon: ICON,
  },
  preview: { url: "https://preview.example.invalid/" },
  onApprove: noop,
  onMakeChanges: noop,
}

/** The journey's row in the update stack, as the app draws it. */
const journeyRow = (title: string, label: string, google = false) => ({
  id: google ? "google" : "address",
  content: (
    <UpdateRow
      action={
        <Button size="sm" variant="outline">
          {label}
        </Button>
      }
      icon={<UpdateIcon icon={google ? GoogleLogoIcon : GlobeIcon} />}
      title={title}
    />
  ),
})

/**
 * A conversation's update stack above the composer, in one journey state:
 * the ready card docked as one of its items (`site`), the journey's rows
 * before it (`lead`) or after it (`tail`).
 */
function StackedReady({
  lead = [],
  tail = [],
  site = true,
}: {
  lead?: Update[]
  tail?: Update[]
  site?: boolean
}) {
  const [spot, setSpot] = useState<HTMLElement | null>(null)
  const card = {
    id: "site",
    content: <div className="flex min-w-0 flex-1" ref={setSpot} />,
  }
  return (
    <>
      {site ? <SiteReady {...READY} docked spot={spot} /> : null}
      <DockedUpdates updates={[...lead, ...(site ? [card] : []), ...tail]} />
    </>
  )
}

/** Each state of the stack in a conversation, from the journey (`journeyItem` in apps/web). */
const STACK_STATES: [string, ReactNode, ThreadMessageLike[]?][] = [
  [
    "never-answered",
    <StackedReady
      key="never-answered"
      tail={[journeyRow("Choose your domain", "Connect now")]}
    />,
  ],
  [
    "skipped",
    <StackedReady
      key="skipped"
      tail={[journeyRow("Add your domain", "Connect now")]}
    />,
  ],
  [
    "buying-elsewhere",
    <StackedReady
      key="buying-elsewhere"
      lead={[journeyRow("Finished buying sparkleclean.co.uk?", "Connect it")]}
    />,
  ],
  [
    "bought",
    <StackedReady
      key="bought"
      lead={[journeyRow("sparkleclean.co.uk is ready to connect", "Connect")]}
    />,
  ],
  [
    "google",
    <StackedReady
      key="google"
      tail={[journeyRow("Get found on Google", "Connect Search Console", true)]}
    />,
  ],
  ["google-done", <StackedReady key="google-done" />],
  [
    "question-open",
    <StackedReady
      key="question-open"
      tail={[journeyRow("Choose your domain", "Connect now")]}
    />,
    ASK_FACT_OPEN.slice(0, 1),
  ],
  [
    "pills-open",
    <StackedReady
      key="pills-open"
      lead={[journeyRow("Finished buying sparkleclean.co.uk?", "Connect it")]}
    />,
    DECISION,
  ],
]

/** The payment dialog behind its button, with test values. */
function PayDialogSample() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} variant="outline">
        Pay £8
      </Button>
      {open ? (
        <PayDialog
          clientSecret="catalog"
          name="sparkleclean.co.uk"
          onClose={() => setOpen(false)}
          onPaid={() => setOpen(false)}
          priceGbp={8}
          publishableKey="pk_test_catalog"
          registrant={{
            name: "Jo Bright",
            email: "jo@sparkleclean.co.uk",
            phone: "+447700900123",
            address: {
              street: "1 High Street",
              city: "Bristol",
              postal_code: "BS1 1AA",
              country_code: "GB",
            },
          }}
        />
      ) : null}
    </>
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
  {
    name: "MarkdownText",
    render: () => <FixtureThread height="h-[72rem]" messages={MARKDOWN} />,
  },
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
  // An open question, and the tray parts every ask is drawn with.
  ...(["AskOpen", "Docked", "TrayNote"] as const).map((name) => ({
    name,
    render: () => (
      <TrayStates
        height="h-[36rem]"
        open={ASK_OPEN_OPEN}
        settled={ASK_OPEN_STATES}
      />
    ),
  })),
  {
    name: "AskFact",
    render: () => (
      <TrayStates
        height="h-[50rem]"
        open={ASK_FACT_OPEN}
        settled={ASK_FACT_STATES}
      />
    ),
  },
  {
    name: "AskDetails",
    render: () => (
      <TrayStates
        height="h-[40rem]"
        open={ASK_DETAILS_OPEN}
        settled={ASK_DETAILS_STATES}
      />
    ),
  },
  {
    name: "AskChoice",
    render: () => (
      <TrayStates
        height="h-[56rem]"
        open={ASK_CHOICE_OPEN}
        settled={ASK_CHOICE_STATES}
      />
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
            <TrayFrame
              collapsed={false}
              onCollapsedChange={noop}
              question="Which colours feel right?"
              submit={{ label: "Submit" }}
            >
              <ChoiceForm input={COLOUR_INPUT} onAnswer={noop} start={start} />
            </TrayFrame>
          </section>
        ))}
      </div>
    ),
  },
  // The popover is the choice pill's options and hint.
  ...(
    [
      "ReviewQuoteForm",
      "Popover",
      "PopoverTrigger",
      "PopoverContent",
      "PopoverTitle",
      "PopoverDescription",
    ] as const
  ).map((name) => ({
    name,
    render: () => (
      <TrayStates
        height="h-[44rem]"
        open={REVIEW_QUOTE_OPEN}
        settled={REVIEW_QUOTE_STATES}
      />
    ),
  })),
  { name: "QuoteFormPreview", render: () => <QuotePreviewSample /> },
  // The upload card and the provider that gives it the app's upload.
  ...(["AskUpload"] as const).map((name) => ({
    name,
    render: () => (
      <ChatServicesProvider value={{ uploadPhotos: fakeUpload }}>
        <TrayStates
          height="h-[48rem]"
          open={ASK_UPLOAD_OPEN}
          settled={ASK_UPLOAD_STATES}
        />
      </ChatServicesProvider>
    ),
  })),
  // The design tray as a thread docks it, and the providers it reads.
  ...(["AskDesign", "TraySlotProvider"] as const).map((name) => ({
    name,
    render: () => (
      <ChatServicesProvider value={{ saveDesignAnswer: async () => undefined }}>
        <FixtureThread
          height="h-[44rem]"
          isDisabled={false}
          settings={{
            placeholder: "Ask Fern anything…",
            questionPlaceholder: "Tell Fern what to do instead…",
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
      </ChatServicesProvider>
    ),
  })),
  {
    // The owner's reply to a finished design tray, as chips.
    name: "DesignReply",
    render: () => (
      <ChatServicesProvider value={{ tray: TRAY_SERVICES }}>
        <FixtureThread
          height="h-[22rem]"
          messages={[
            {
              content: [
                question("Let's choose how your website looks."),
                {
                  args: ASK_DESIGN_INPUT,
                  result: DESIGN_ANSWERS,
                  toolCallId: "design_done",
                  toolName: "ask_design",
                  type: "tool-call" as const,
                },
              ],
              role: "assistant",
              status: DONE,
            },
            reply(designText(ASK_DESIGN_INPUT, DESIGN_ANSWERS)),
          ]}
        />
      </ChatServicesProvider>
    ),
  },
  {
    name: "SitePictures",
    render: () => (
      <SitePictures
        actions={{ onRemove: noop, onTryAnother: noop, onUseOwn: noop }}
        logo={KITCHEN}
        maker="Ava"
        onReplaceLogo={noop}
        pictures={[
          {
            alt: "A bright kitchen after a clean",
            section: "hero",
            slot_id: "hero",
            generated: true,
            src: KITCHEN,
          },
          {
            alt: "The team at work",
            section: "about",
            slot_id: "about",
            generated: false,
            src: null,
          },
        ]}
        status="Sent. A new version replaces this one."
      />
    ),
  },
  // At the end of an open thread, docked once the owner has written since,
  // then its other states on their own: approving, refused, preview not
  // ready and approved.
  {
    name: "SiteReady",
    render: () => (
      <div className="flex flex-col gap-6">
        <FixtureThread
          height="h-[34rem]"
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
          settings={{ after: <SiteReady {...READY} /> }}
        />
        <FixtureThread
          height="h-[34rem]"
          messages={[ask("Hi")]}
          settings={{ after: <StackedReady /> }}
        />
        <div className="flex max-w-xl flex-col gap-6">
          <SiteReady {...READY} pending />
          <SiteReady {...READY} held />
          <SiteReady
            {...READY}
            error="A newer version replaced that one. Check the latest before you decide."
          />
          <SiteReady {...READY} preview="error" />
          <SiteReady {...READY} pictures={null} preview="loading" />
          <SiteReady {...READY} approved />
          <SiteReady
            {...READY}
            connect={{ label: "Connect now", onClick: noop }}
          />
          <SiteReady
            {...READY}
            connect={{ label: "Connect Search Console", onClick: noop }}
          />
        </div>
      </div>
    ),
  },
  // The ready card's own parts: the site's icon and the way to its preview.
  ...(["SiteIcon", "PreviewLink"] as const).map((name) => ({
    name,
    render: () => (
      <div className="max-w-xl">
        <SiteReady {...READY} />
      </div>
    ),
  })),
  // A conversation's update stack above the composer, one thread per
  // journey state; with a question open, the question takes the slot.
  ...(["DockedUpdates", "UpdateIcon"] as const).map((name) => ({
    name,
    render: () => (
      <div className="flex flex-col gap-6">
        {STACK_STATES.map(([state, stack, messages]) => (
          <div data-state={state} key={state}>
            <FixtureThread
              height={messages ? "h-[34rem]" : "h-[22rem]"}
              // An open question docks as it does in the app.
              isDisabled={!messages}
              messages={messages ?? [ask("Hi")]}
              settings={{ after: stack }}
            />
          </div>
        ))}
      </div>
    ),
  })),
  // A new chat's updates: the site to publish, a question and a reminder,
  // one in front with the other two as edges under it, each a row of its own.
  ...(["UpdateDeck", "UpdateRow", "UpdateKindIcon"] as const).map((name) => ({
    name,
    render: () => (
      <FixtureThread
        height="h-[34rem]"
        messages={[]}
        settings={{
          briefing: "Your website is ready to go live.",
          updates: (
            <UpdateDeck
              updates={[
                {
                  id: "site",
                  content: (
                    <SiteReady
                      meta="Not published · Today, 4:05 pm"
                      onApprove={noop}
                      onMakeChanges={noop}
                      pictures={{
                        laptop: KITCHEN,
                        "laptop-2": KITCHEN,
                        phone: KITCHEN,
                        icon: ICON,
                      }}
                      preview="loading"
                      row
                      title="Brightclean website"
                    />
                  ),
                },
                {
                  id: "question",
                  content: (
                    <UpdateRow
                      action={
                        <Button size="sm" variant="outline">
                          Answer
                        </Button>
                      }
                      icon={<UpdateKindIcon kind="question" />}
                      meta="Sam asked"
                      title="Which areas do you cover?"
                    />
                  ),
                },
                {
                  id: "reminder",
                  content: (
                    <UpdateRow
                      icon={<UpdateKindIcon kind="reminder" />}
                      meta="Reminder"
                      title="Call the window supplier"
                    />
                  ),
                },
              ]}
            />
          ),
        }}
      />
    ),
  })),
  {
    name: "RequestChange",
    render: () => (
      <FixtureThread height="h-[130rem]" messages={REQUEST_CHANGE_STATES} />
    ),
  },
  // The card the three tools share, its outcome lines and its provider, on
  // a waiting card, a done one and a refused one.
  ...(["Decision", "Done", "Problem", "TrayApproval"] as const).map((name) => ({
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
  })),
  // A waiting card with the app's tap behind it, so Always allow shows.
  {
    name: "ChatServicesProvider",
    render: () => (
      <ChatServicesProvider value={{ alwaysAllow: () => undefined }}>
        <FixtureThread
          height="h-[14rem]"
          messages={[CREATE_REMINDER_STATES[2]].filter(
            (message) => message !== undefined
          )}
        />
      </ChatServicesProvider>
    ),
  },
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
  // The connect card and the records it ends on.
  // Each state in a thread of its own: a later domain card folds an earlier one.
  {
    name: "ConnectDomain",
    render: () => (
      <div className="flex flex-col gap-4">
        {CONNECT_DOMAIN_STATES.map((state, at) => (
          <FixtureThread
            height="h-[44rem]"
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            key={at}
            messages={[state]}
          />
        ))}
      </div>
    ),
  },
  {
    name: "ConnectSteps",
    render: () => (
      <div className="flex flex-col gap-4">
        <FixtureThread height="h-[44rem]" messages={CONNECT_STEPS_NOW} />
        <ChatServicesProvider value={{ domainPurchase: CATALOG_PURCHASE }}>
          <FixtureThread height="h-[56rem]" messages={CONNECT_STEPS_PAUSED} />
        </ChatServicesProvider>
      </div>
    ),
  },
  {
    name: "DomainBought",
    render: () => (
      <FixtureThread height="h-[80rem]" messages={DOMAIN_BOUGHT_STATES} />
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
      <ChatServicesProvider value={{ domainPurchase: CATALOG_PURCHASE }}>
        <div className="flex flex-col gap-4">
          <FixtureThread height="h-[64rem]" messages={FIND_DOMAIN_STATES} />
          <FixtureThread height="h-[48rem]" messages={FIND_DOMAIN_BUY_HERE} />
          <FixtureThread height="h-[56rem]" messages={FIND_DOMAIN_AGAIN} />
        </div>
      </ChatServicesProvider>
    ),
  },
  // The purchase card, its tray and the provider that gives it the app's checkout.
  ...(["BuyDomain", "BuyTray"] as const).map((name) => ({
    name,
    render: () => (
      <ChatServicesProvider value={{ domainPurchase: CATALOG_PURCHASE }}>
        <FixtureThread height="h-[260rem]" messages={BUY_DOMAIN_STATES} />
      </ChatServicesProvider>
    ),
  })),
  // Opened from its button: Stripe.js cannot start here, so the payment side
  // shows its "did not load" line beside the order summary.
  { name: "PayDialog", render: () => <PayDialogSample /> },
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
    name: "ConnectGoogleRow",
    render: () => (
      <div className="max-w-md">
        <ConnectGoogleRow />
      </div>
    ),
  },
  {
    name: "ServerButtonUI",
    render: () => (
      <FixtureThread height="h-[46rem]" messages={POSTED}>
        <ServerButtonUI />
      </FixtureThread>
    ),
  },
  // Quick replies, as the web address question asks them.
  ...(["BuildQuestionsAddress", "ReplyPill", "ReplyPills"] as const).map(
    (name) => ({
      name,
      render: () => (
        <ChatServicesProvider value={{ answerBuildQuestion: answerSlowly }}>
          <OwnerThread
            height="h-[32rem]"
            messages={ADDRESS_QUESTIONS}
            stored="00000000-0000-4000-8000-0000000000a2"
          >
            <BuildQuestionsUI />
          </OwnerThread>
        </ChatServicesProvider>
      ),
    })
  ),
  // The newest decision's quick replies, the recommendation first.
  {
    name: "DecisionPills",
    render: () => <OwnerThread height="h-[32rem]" messages={DECISION} />,
  },
  // The question stack and the provider that gives it the app's answer call.
  ...(["BuildQuestionsUI"] as const).map((name) => ({
    name,
    render: () => (
      <ChatServicesProvider value={{ answerBuildQuestion: answerSlowly }}>
        <OwnerThread
          height="h-[40rem]"
          messages={BUILD_QUESTIONS}
          stored="00000000-0000-4000-8000-0000000000a1"
        >
          <BuildQuestionsUI />
        </OwnerThread>
      </ChatServicesProvider>
    ),
  })),
  {
    name: "ChangeAskedUI",
    render: () => (
      <FixtureThread height="h-[26rem]" messages={CHANGE_ASKED}>
        <ChangeAskedUI />
      </FixtureThread>
    ),
  },
  {
    name: "EnquiryCardUI",
    render: () => (
      <FixtureThread height="h-[26rem]" messages={ENQUIRY}>
        <EnquiryCardUI />
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
  {
    // A saved remember call says what it saved in its own turn.
    name: "Remembered",
    render: () => <FixtureThread height="h-[20rem]" messages={REMEMBER_CALL} />,
  },
  {
    name: "PersonaCardUI",
    render: () => (
      <FixtureThread height="h-[28rem]" messages={PERSONA}>
        <PersonaCardUI />
      </FixtureThread>
    ),
  },
  { name: "AnswerInputs", render: () => <AnswerInputsSample /> },
  {
    name: "Onboarding",
    render: () => <OwnerThread height="h-[44rem]" messages={ONBOARDING} />,
  },
  {
    name: "QuickReplies",
    render: () => (
      <div className="flex flex-col gap-8">
        {QUICK_REPLIES.map(([title, message]) => (
          <section className="flex flex-col gap-2" key={title}>
            <h3 className="font-medium text-muted-foreground text-sm">
              {title}
            </h3>
            <OwnerThread height="h-[26rem]" messages={[message]} />
          </section>
        ))}
      </div>
    ),
  },
  {
    name: "Thread",
    render: () => <OwnerThread height="h-[56rem]" messages={CONVERSATION} />,
  },
  { name: "ChipRow", render: () => <ScrolledChips /> },
  {
    // The new chat's suggestions on a phone: one row, fading at its right edge.
    name: "ThreadEmptyPhone",
    render: () => (
      <div className="w-[390px]">
        <OwnerThread
          height="h-[32rem]"
          isDisabled={false}
          messages={[]}
          suggestions={LONG_SUGGESTIONS}
        />
      </div>
    ),
  },
  {
    name: "ThreadLongMessage",
    render: () => <OwnerThread height="h-[60rem]" messages={LONG_MESSAGES} />,
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
            "Your website is live. Your latest changes are ready to publish.",
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
  { name: "ThreadNewSince", render: () => <NewSinceSample /> },
  {
    name: "ThreadMessageKinds",
    render: () => <OwnerThread height="h-[40rem]" messages={KINDS} />,
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
