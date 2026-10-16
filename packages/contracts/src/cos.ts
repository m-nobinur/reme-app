import { z } from "zod"
import { InformationRequest } from "./assignment.ts"
import { ChatRequest, RequestChangeOutput } from "./chat.ts"
import { JsonObject, Timestamp, Ulid, Uuid } from "./common.ts"
import { ConversationMessage, MessageRating } from "./conversation.ts"
import {
  DnsRecord,
  DomainCheck,
  DomainName,
  DomainOffer,
  DomainProvider,
  DomainState,
  Registrant,
  RegistrantDetails,
} from "./domain.ts"
import { ToolCallId } from "./ids.ts"
import {
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
      })
    )
    .max(10),
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
  /** How long each lane usually takes, so the CoS quotes the measured wait. */
  expected_seconds: WorkspaceStatus.shape.expected_seconds,
})

/** `get_facts`'s output: the org's current values, without their records. */
export const CosFacts = z.strictObject({ facts: z.array(FactValue) })

/**
 * `request_change`'s input: the owner's change, and the new phone or email
 * when the owner typed it in full. The tool records it as the owner's word
 * only if its digits or address appear in what the owner wrote.
 */
export const CosChangeRequest = OwnerChangeRequest.extend({
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
 * `find_domain`'s output: names free to register now, at the price table's
 * price. The model quotes no other price. None free is `domain.unavailable`.
 */
export const FindDomainOutput = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("found"),
    best: DomainOffer,
    options: z.array(DomainOffer).max(4),
  }),
  Refused,
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
