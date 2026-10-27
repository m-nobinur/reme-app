import { z } from "zod"
import { InformationRequest } from "./assignment.ts"
import { ChatRequest, RequestChangeOutput } from "./chat.ts"
import { JsonObject, Timestamp, Ulid, Uuid } from "./common.ts"
import { ConversationMessage, MessageRating } from "./conversation.ts"
import {
  DnsRecord,
  DomainCheck,
  DomainName,
  DomainProvider,
  DomainState,
  DomainStemOffer,
  NotRegisteredYet,
  Registrant,
  RegistrantDetails,
} from "./domain.ts"
import { ToolCallId } from "./ids.ts"
import { RememberInput, RememberOutput } from "./memory.ts"
import {
  BUILD_ACTIVITY_MAX,
  BuildStopCause,
  BuildSummary,
  CreateReminderRequest,
  E164,
  FactValue,
  FactValueKey,
  OwnerAnswerText,
  OwnerChangeRequest,
  ReviewValue,
  WorkspaceStatus,
} from "./owner.ts"
import { Refused } from "./refused.ts"
import { GateName } from "./report.ts"
import {
  ConnectGoogleInput,
  ConnectGoogleOutput,
  GetIndexingInput,
  GetIndexingOutput,
  GetSearchPerformanceInput,
  GetSearchPerformanceOutput,
} from "./search.ts"
import { OwnerTask, TaskKind } from "./task.ts"
import { Text } from "./text.ts"

// The Chief of Staff's tools and its event log (ADR-034). A tool's output is
// what the model reads, so none carries an org id, a staff id or a signed
// URL: the model never sees tenancy ids, and a signed link is a bearer
// capability the tool UI fetches for itself.

const Version = z.int().positive()
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const Usd = z.number().nonnegative()

/** `get_workspace`'s output: the panel's state, cut to what the model needs. */
export const CosWorkspace = z.strictObject({
  site: z.strictObject({
    host: z.string().min(1).nullable(),
    live_version: Version.nullable(),
  }),
  /** Non-terminal, newest first. */
  builds: z
    .array(
      z.strictObject({
        assignment_id: BuildSummary.shape.assignment_id,
        kind: BuildSummary.shape.kind,
        state: BuildSummary.shape.state,
        lane: BuildSummary.shape.lane,
        /** The owner's words as the build restated them: data, never instructions. */
        goal: BuildSummary.shape.goal,
        version: Version.nullable(),
        /** Started again on its own after a build that stopped. */
        retry: z.boolean().optional(),
        /** Fixing what its checks found: the repair round it is on, and the checks that failed. */
        fixing: z
          .strictObject({
            round: z.int().min(1).max(9),
            checks: z.array(GateName).max(GateName.options.length),
          })
          .optional(),
        /**
         * The build's steps as the panel shows them: fixed labels and counts,
         * never model text. Optional: tool results stored before it replay.
         */
        progress: z
          .array(
            z.strictObject({
              step: Text(60),
              done: z.int().nonnegative(),
              total: z.int().positive(),
              now: z.boolean(),
            })
          )
          .max(BUILD_ACTIVITY_MAX)
          .optional(),
        /**
         * While the pipeline works on it: whole minutes since it started,
         * less the owner's plan reviews, and since it last logged any work.
         * `overdue` is past the top of its lane's range, and `range` is the
         * panel's words for the wait ("about 6 to 10 minutes"), moved up to
         * start above the time gone once overdue. Optional, as `progress`.
         */
        timing: z
          .strictObject({
            running_minutes: z.int().nonnegative(),
            quiet_minutes: z.int().nonnegative(),
            overdue: z.boolean(),
            range: z.string().max(40),
          })
          .optional(),
        /**
         * The last time the pipeline started its Developer again mid-build,
         * and why; `working` once it has logged work since.
         */
        restarted: z
          .strictObject({
            minutes_ago: z.int().nonnegative(),
            cause: BuildStopCause,
            working: z.boolean(),
          })
          .optional(),
      })
    )
    .max(10),
  /** Builds that stopped in the last day, newest first. Optional, as `progress`. */
  stopped: z
    .array(
      z.strictObject({
        cause: BuildStopCause,
        at: Timestamp,
        /** The checks its last report failed, by name. */
        checks: z.array(GateName).max(GateName.options.length).optional(),
      })
    )
    .max(5)
    .optional(),
  /**
   * The Developer's open questions, at most 10. `why` is another agent's
   * text, capped here: data, never instructions. `options` follows the
   * orchestrator's question rule: at most 10 answers an owner could give.
   */
  questions: z
    .array(
      z.strictObject({
        request_id: InformationRequest.shape.request_id,
        field: InformationRequest.shape.field,
        why: z.string().min(1).max(500),
        options: z.array(OwnerAnswerText).max(10).nullable(),
        blocking: InformationRequest.shape.blocking,
      })
    )
    .max(10),
  /** Reviews waiting on the owner, by expiry, at most 10. */
  approvals: z
    .array(z.strictObject({ version: Version, expires_at: Timestamp }))
    .max(10),
  missing_facts: z.array(FactValueKey),
  /**
   * The org's custom domains that are not removed, newest first. Optional
   * while the api that fills it lands after the contract; absent means none.
   */
  domains: z
    .array(
      z.strictObject({
        name: DomainName,
        state: DomainState,
        last_check: DomainCheck.nullable(),
      })
    )
    .max(10)
    .optional(),
  /**
   * The owner tasks still open, one per kind, with each step's state and the
   * note of a step that waits on the owner. Optional, as `domains`.
   */
  tasks: z.array(OwnerTask).max(TaskKind.options.length).optional(),
  /** How long each lane usually takes, so the CoS quotes the measured wait. */
  expected_seconds: WorkspaceStatus.shape.expected_seconds,
  /** Each lane's wait in the panel's words, for a build that has just started. */
  expected_range: z
    .strictObject({ quick: z.string().max(40), full: z.string().max(40) })
    .optional(),
})

/** `get_facts`'s output: the org's current values, without their records. */
export const CosFacts = z.strictObject({ facts: z.array(FactValue) })

/**
 * The first build's change text, which onboarding starts on the owner's
 * behalf: the details are in the facts. The chat draws no card for it.
 */
export const ONBOARDING_GOAL = "Build my website from the details I gave you."

/**
 * `request_change`'s input: the owner's change, and the new phone or email
 * when the owner typed it in full. The tool records it as the owner's word
 * only if its digits or address appear in what the owner wrote. `proof` is
 * what the owner claims about the business in the change, recorded the same
 * way only if every word of it is the owner's. `step` is a line for the
 * panel: the runner strips it before the tool runs.
 */
export const CosChangeRequest = OwnerChangeRequest.extend({
  proof: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'What the owner states about the business in this change and wants the site to say, such as insurance, years trading or a guarantee, in their own words and as the site would write it: "Local and fully insured, with £5 million public liability". Money as £5 million, never "5 million pounds". Never the change itself ("Build the website again" is not a claim). Omit it when the change states nothing about the business.'
    ),
  contact: z
    .strictObject({
      phone: E164.optional().describe(
        "The new business phone number in E.164, exactly the digits the owner typed in full. Omit it when they gave none."
      ),
      email: z
        .email()
        .max(254)
        .optional()
        .describe(
          "The new business email address, exactly as the owner typed it. Omit it when they gave none."
        ),
    })
    .optional(),
  step: z
    .string()
    .max(60)
    .optional()
    .describe(
      'A few words, in the owner\'s language, of what this change does, such as "Adding the new photos to the home page". At most 60 characters. The panel shows it while the change is made; no ids, no versions.'
    ),
})

/** `get_preview`'s input: the build whose preview to check. */
export const GetPreviewInput = z.strictObject({ assignment_id: Uuid })

/**
 * `get_preview`'s output: the preview's version and expiry, or why there is
 * none, such as a build with no preview yet. No URLs: the tool UI fetches
 * the signed links.
 */
export const GetPreviewOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("ready"),
    assignment_id: Uuid,
    version: Version,
    expires_at: Timestamp,
  }),
  Refused,
])

/**
 * `answer_question`'s input. The api finds the build from the request and
 * checks the value against the question's field: a `FactValue` must be for
 * the field's key, and anything else goes through the question's
 * `TextAnswerSchema` and options.
 */
export const AnswerQuestionInput = z.strictObject({
  request_id: Uuid,
  value: z.union([FactValue, OwnerAnswerText]),
})

/** `answer_question`'s output once the owner said yes. A no is `output-denied`. */
export const AnswerQuestionOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("answered"), request_id: Uuid }),
  Refused,
])

/**
 * `create_reminder`'s output once the owner said yes: the due time as
 * stored, and no id, since the model has nothing to do with one. A no is
 * `output-denied`. Its input is `CreateReminderRequest`.
 */
export const CreateReminderOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("created"),
    due_at: Timestamp.nullable(),
  }),
  Refused,
])

/**
 * `record_review`'s input: a customer's review for the site, in the slot it
 * fills (`testimonials.review_<slot>`, replacing the one there), and the
 * owner's word that the customer agreed to be quoted, which must be true.
 */
export const RecordReviewInput = z.strictObject({
  slot: z.literal([1, 2]),
  ...ReviewValue.shape,
})

/** `record_review`'s output once the owner said yes. A no is `output-denied`. */
export const RecordReviewOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("recorded"), slot: z.literal([1, 2]) }),
  Refused,
])

/** `check_domain`'s input; it also wakes the domain's workflow to look now. */
export const CheckDomainInput = z.strictObject({ name: DomainName })

/** `check_domain`'s output: where the domain is, the latest check, and what to tell the owner to do next. */
export const CheckDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("checked"),
    state: DomainState,
    status: DomainCheck,
    next_step: Text(300),
  }),
  Refused,
])

/** `connect_domain`'s input: the owner's existing domain. */
export const ConnectDomainInput = z.strictObject({ name: DomainName })

/**
 * `connect_domain`'s output once the owner said yes. A no is `output-denied`.
 * `steps` are the records to add, `apex` says whether the bare domain is an
 * alias or forwards from `www` (absent for a subdomain, which is served on its
 * own name), and `provider` is the detected DNS provider.
 */
export const ConnectDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("connecting"),
    method: z.enum(["domain_connect", "records"]),
    email_affected: z.boolean(),
    steps: z.array(DnsRecord).max(10).optional(),
    apex: z.enum(["alias", "forward"]).optional(),
    provider: DomainProvider.optional(),
  }),
  Refused,
])

/** `remove_domain`'s input: a domain connected to the business. */
export const RemoveDomainInput = z.strictObject({ name: DomainName })

/**
 * `remove_domain`'s output once the owner said yes. A no is `output-denied`.
 * The site is back on its own address.
 */
export const RemoveDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("removed") }),
  Refused,
])

/** `find_domain`'s input: what to search around, or nothing to start from the business name. */
export const FindDomainInput = z.strictObject({
  query: Text(100)
    .optional()
    .describe(
      "Words the owner wants in the name. Omit it to start from the business name."
    ),
})

/**
 * `find_domain`'s output: one row per name stem, best first, each ending free
 * at the price table's price or taken. The model quotes no other price. No
 * stem with a free ending is `domain.unavailable`.
 */
export const FindDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("found"),
    rows: z.array(DomainStemOffer).min(1).max(5),
  }),
  Refused,
])

/**
 * `POST /domains/{name}/bought`, the owner saying they bought the name
 * elsewhere, from the tray or through the CoS: the registry is asked again,
 * and once it shows the name the connect starts and this is its output.
 */
export const BoughtElsewhereOutput = z.discriminatedUnion("outcome", [
  ...ConnectDomainOutput.options,
  NotRegisteredYet,
])

/**
 * `buy_domain`'s input: a name `find_domain` offered and its registrant.
 * It prepares the purchase and moves no money: the owner's payment in
 * Checkout is the consent.
 */
export const BuyDomainInput = z.strictObject({
  name: DomainName,
  ...RegistrantDetails.shape,
})

/**
 * What the model may send `buy_domain`: no county, since it sent the city,
 * "null" and a wrong county. The owner adds one on the card. Stored inputs
 * with a county still read as `BuyDomainInput`.
 */
export const BuyDomainAsk = BuyDomainInput.extend({
  registrant: Registrant.extend({
    address: Registrant.shape.address.omit({ state: true }),
  }),
})

/**
 * `buy_domain`'s output: the purchase waits on the owner's payment in the
 * card's embedded Checkout. Refused with `domain.unavailable`,
 * `domain.registrant_invalid`, `domain.price_changed` or
 * `domain.buy_unavailable`.
 */
export const BuyDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("awaiting_payment"),
    name: DomainName,
    price_gbp: z.int().positive(),
    checkout: z.literal("embedded"),
  }),
  Refused,
])

const Empty = z.strictObject({})

/**
 * The CoS's tools, by name. Every input is an object at its root, which
 * provider tool APIs require. The reads run in both modes; each act tool
 * waits for the owner's approval.
 */
export const COS_TOOLS = {
  get_workspace: { input: Empty, output: CosWorkspace },
  get_facts: { input: Empty, output: CosFacts },
  get_preview: { input: GetPreviewInput, output: GetPreviewOutput },
  request_change: { input: CosChangeRequest, output: RequestChangeOutput },
  answer_question: { input: AnswerQuestionInput, output: AnswerQuestionOutput },
  create_reminder: {
    input: CreateReminderRequest,
    output: CreateReminderOutput,
  },
  record_review: { input: RecordReviewInput, output: RecordReviewOutput },
  check_domain: { input: CheckDomainInput, output: CheckDomainOutput },
  connect_domain: { input: ConnectDomainInput, output: ConnectDomainOutput },
  remove_domain: { input: RemoveDomainInput, output: RemoveDomainOutput },
  find_domain: { input: FindDomainInput, output: FindDomainOutput },
  buy_domain: { input: BuyDomainInput, output: BuyDomainOutput },
  connect_google: { input: ConnectGoogleInput, output: ConnectGoogleOutput },
  get_search_performance: {
    input: GetSearchPerformanceInput,
    output: GetSearchPerformanceOutput,
  },
  get_indexing: { input: GetIndexingInput, output: GetIndexingOutput },
  remember: { input: RememberInput, output: RememberOutput },
} as const

export type CosToolName = keyof typeof COS_TOOLS
export const CosToolName = z.enum(
  Object.keys(COS_TOOLS) as [CosToolName, ...CosToolName[]]
)

const Usage = z.strictObject({
  input_tokens: z.int().nonnegative(),
  cached_input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
})

const Ran = {
  turn_id: Ulid,
  model: z.string().min(1),
  usage: Usage,
  cost_usd: Usd,
  tools: z.array(CosToolName),
  steps: z.int().min(0).max(6),
  /** Null when no model call was made. */
  first_chunk_ms: z.int().nonnegative().nullable(),
}

/** The `cos.turn` payload. Never model-visible. No taint label. */
export const CosTurn = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("answered"), ...Ran }),
  z.strictObject({
    outcome: z.literal("fallback"),
    reason: z.enum(["provider", "budgetary", "resource"]),
    ...Ran,
  }),
  /** An onboarding turn the script answered from Jev's decision, its planner stopped. */
  z.strictObject({ outcome: z.literal("gated"), ...Ran }),
  z.strictObject({ outcome: z.literal("error"), ...Ran }),
  z.strictObject({ outcome: z.literal("integrity"), ...Ran }),
  z.strictObject({
    outcome: z.literal("abandoned"),
    turn_id: Ulid,
    logged_usd: Usd,
    reserved_usd: Usd,
  }),
])

/** The `cos.prefix` payload: the instructions and tools as sent. Our code, so no taint label. */
export const CosPrefix = z.strictObject({
  version: z.string().min(1),
  sha256: Sha256,
  instructions: z.string().min(1),
  tools: z.array(
    z.strictObject({
      name: CosToolName,
      description: z.string().min(1),
      input_schema: JsonObject,
    })
  ),
})

/**
 * The `cos.context` payload, a turn's first. Labelled `untrusted_input` when
 * `text` holds owner text and `inferred` when it holds another agent's, such
 * as a question's `why`; both when it holds both.
 */
export const CosContext = z.strictObject({
  turn_id: Ulid,
  prefix_sha256: Sha256,
  context_policy_version: z.string().min(1),
  mode: ChatRequest.shape.mode,
  active_tools: z.array(CosToolName),
  text: z.string().min(1),
  reserved_usd: Usd,
})

const Content = ConversationMessage.shape.content.shape

/**
 * The `cos.message` payload: one whole `UIMessage`. Labelled
 * `untrusted_input` for owner text and `inferred` for text an agent wrote,
 * the CoS's own replies included; both when it holds both.
 */
export const CosMessage = z.strictObject({
  turn_id: Ulid,
  message: z.strictObject({
    id: ConversationMessage.shape.id,
    role: Content.role,
    parts: Content.parts,
  }),
})

const Called = { turn_id: Ulid, tool_call_id: ToolCallId }

/**
 * The `cos.tool_result` payload, one branch per tool so each output is typed.
 * Labelled like `cos.context`, by the text the output carries.
 */
export const CosToolResult = z.discriminatedUnion("tool", [
  z.strictObject({
    ...Called,
    tool: z.literal("get_workspace"),
    output: COS_TOOLS.get_workspace.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_facts"),
    output: COS_TOOLS.get_facts.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_preview"),
    output: COS_TOOLS.get_preview.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("request_change"),
    output: COS_TOOLS.request_change.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("answer_question"),
    output: COS_TOOLS.answer_question.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("create_reminder"),
    output: COS_TOOLS.create_reminder.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("record_review"),
    output: COS_TOOLS.record_review.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("check_domain"),
    output: COS_TOOLS.check_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("connect_domain"),
    output: COS_TOOLS.connect_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("remove_domain"),
    output: COS_TOOLS.remove_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("find_domain"),
    output: COS_TOOLS.find_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("buy_domain"),
    output: COS_TOOLS.buy_domain.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("connect_google"),
    output: COS_TOOLS.connect_google.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_search_performance"),
    output: COS_TOOLS.get_search_performance.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("get_indexing"),
    output: COS_TOOLS.get_indexing.output,
  }),
  z.strictObject({
    ...Called,
    tool: z.literal("remember"),
    output: COS_TOOLS.remember.output,
  }),
])

/** The `cos.step` payload: a step's response messages as the SDK holds them. Model-written, so `inferred`. */
export const CosStep = z.strictObject({
  turn_id: Ulid,
  step: z.int().nonnegative(),
  messages: z.array(JsonObject),
  usage: Usage,
  cost_usd: Usd,
})

/** The `cos.call` payload: the hash of the messages a model call was sent. No taint label. */
export const CosCall = z.strictObject({
  turn_id: Ulid,
  step: z.int().nonnegative(),
  sha256: Sha256,
})

/**
 * The `cos.feedback` payload: the owner's thumb on one assistant message.
 * Written with no session, so it never takes a turn's `seq` and the
 * history derivation never reads it. Never model-visible, and no taint
 * label, because it holds no free text.
 */
export const CosFeedback = z.strictObject({
  conversation_id: Uuid,
  message_id: ConversationMessage.shape.id,
  rating: MessageRating,
})

/**
 * The `cos.approval` payload: an approval card as it was shown. The answer
 * must match `input_sha256` (the hash of the tool input the card showed) and
 * arrive before `expires_at`, or it is refused. `approval_id` is the SDK's
 * and has the shape of a provider id. No free text, so no taint label.
 */
export const CosApproval = z.strictObject({
  turn_id: Ulid,
  approval_id: ToolCallId,
  tool_call_id: ToolCallId,
  input_sha256: Sha256,
  expires_at: Timestamp,
})

/**
 * The `cos.tool_started` payload: an act call passed its approval check and
 * is about to run. One with no result five minutes later, as a Worker killed
 * mid-call leaves it, counts as `cos.tool_unknown`. No free text.
 */
export const CosToolStarted = z.strictObject({
  tool_call_id: ToolCallId,
  approval_id: ToolCallId,
})

/**
 * The `cos.tool_unknown` payload: a tool call whose outcome is not known, so
 * it is never run again and the owner is asked. No free text.
 */
export const CosToolUnknown = z.strictObject({
  tool_call_id: ToolCallId,
  approval_id: ToolCallId,
})

/**
 * The `cos.compaction` payload (§10.6): `summary` stands in for the events in
 * `replaced_range`, which stay in the log. `dropped_refs` are the ids of
 * events the summary does not carry. The summary is model-written, so the
 * event is labelled `inferred`.
 */
export const CosCompaction = z.strictObject({
  summary: Text(8000),
  /** Positions in the session's stream, both included. */
  replaced_range: z.strictObject({
    from_seq: z.int().nonnegative(),
    to_seq: z.int().nonnegative(),
  }),
  dropped_refs: z.array(Ulid).max(500),
})

export type CosWorkspace = z.infer<typeof CosWorkspace>
export type CosFacts = z.infer<typeof CosFacts>
export type CosChangeRequest = z.infer<typeof CosChangeRequest>
export type GetPreviewInput = z.infer<typeof GetPreviewInput>
export type GetPreviewOutput = z.infer<typeof GetPreviewOutput>
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>
export type AnswerQuestionOutput = z.infer<typeof AnswerQuestionOutput>
export type CreateReminderOutput = z.infer<typeof CreateReminderOutput>
export type RecordReviewInput = z.infer<typeof RecordReviewInput>
export type RecordReviewOutput = z.infer<typeof RecordReviewOutput>
export type CheckDomainInput = z.infer<typeof CheckDomainInput>
export type CheckDomainOutput = z.infer<typeof CheckDomainOutput>
export type ConnectDomainInput = z.infer<typeof ConnectDomainInput>
export type ConnectDomainOutput = z.infer<typeof ConnectDomainOutput>
export type RemoveDomainInput = z.infer<typeof RemoveDomainInput>
export type RemoveDomainOutput = z.infer<typeof RemoveDomainOutput>
export type FindDomainInput = z.infer<typeof FindDomainInput>
export type FindDomainOutput = z.infer<typeof FindDomainOutput>
export type BoughtElsewhereOutput = z.infer<typeof BoughtElsewhereOutput>
export type BuyDomainInput = z.infer<typeof BuyDomainInput>
export type BuyDomainOutput = z.infer<typeof BuyDomainOutput>
export type CosTurn = z.infer<typeof CosTurn>
export type CosPrefix = z.infer<typeof CosPrefix>
export type CosContext = z.infer<typeof CosContext>
export type CosMessage = z.infer<typeof CosMessage>
export type CosToolResult = z.infer<typeof CosToolResult>
export type CosStep = z.infer<typeof CosStep>
export type CosCall = z.infer<typeof CosCall>
export type CosFeedback = z.infer<typeof CosFeedback>
export type CosApproval = z.infer<typeof CosApproval>
export type CosToolStarted = z.infer<typeof CosToolStarted>
export type CosToolUnknown = z.infer<typeof CosToolUnknown>
export type CosCompaction = z.infer<typeof CosCompaction>
