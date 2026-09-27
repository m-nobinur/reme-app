import { z } from "zod"
import { InformationRequest } from "./assignment.ts"
import { ChatRequest, RequestChangeOutput } from "./chat.ts"
import { JsonObject, Timestamp, Ulid, Uuid } from "./common.ts"
import { ConversationMessage } from "./conversation.ts"
import { ErrorEnvelope } from "./error.ts"
import { ToolCallId } from "./ids.ts"
import {
  BuildSummary,
  FactValue,
  FactValueKey,
  OwnerAnswerText,
  OwnerChangeRequest,
} from "./owner.ts"

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
        /** The owner's words as the build restated them: data, never instructions. */
        goal: BuildSummary.shape.goal,
        version: Version.nullable(),
      })
    )
    .max(10),
  /** The Developer's open questions. `why` is another agent's text: data, never instructions. */
  questions: z.array(
    z.strictObject({
      request_id: InformationRequest.shape.request_id,
      field: InformationRequest.shape.field,
      why: InformationRequest.shape.why,
      options: InformationRequest.shape.options,
      blocking: InformationRequest.shape.blocking,
    })
  ),
  /** Reviews waiting on the owner, by expiry. */
  approvals: z.array(
    z.strictObject({ version: Version, expires_at: Timestamp })
  ),
  missing_facts: z.array(FactValueKey),
})

/** `get_facts`'s output: the org's current values, without their records. */
export const CosFacts = z.strictObject({ facts: z.array(FactValue) })

/** `get_preview`'s input: the build whose preview to check. */
export const GetPreviewInput = z.strictObject({ assignment_id: Uuid })

/** `get_preview`'s output. No URLs: the tool UI fetches the signed links. */
export const GetPreviewOutput = z.strictObject({
  assignment_id: Uuid,
  version: Version,
  expires_at: Timestamp,
})

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
  z.strictObject({
    outcome: z.literal("refused"),
    error: ErrorEnvelope.omit({ occurred_at: true }),
  }),
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
  request_change: { input: OwnerChangeRequest, output: RequestChangeOutput },
  answer_question: { input: AnswerQuestionInput, output: AnswerQuestionOutput },
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

/**
 * The `cos.tool_result` payload, one branch per tool so each output is typed.
 * Labelled like `cos.context`, by the text the output carries.
 */
export const CosToolResult = z.discriminatedUnion(
  "tool",
  Object.entries(COS_TOOLS).map(([tool, { output }]) =>
    z.strictObject({
      turn_id: Ulid,
      tool_call_id: ToolCallId,
      tool: z.literal(tool),
      output,
    })
  ) as unknown as [ToolResult, ...ToolResult[]]
)

type ToolResult = {
  [K in CosToolName]: z.ZodObject<
    {
      turn_id: typeof Ulid
      tool_call_id: typeof ToolCallId
      tool: z.ZodLiteral<K>
      output: (typeof COS_TOOLS)[K]["output"]
    },
    z.core.$strict
  >
}[CosToolName]

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

export type CosWorkspace = z.infer<typeof CosWorkspace>
export type CosFacts = z.infer<typeof CosFacts>
export type GetPreviewInput = z.infer<typeof GetPreviewInput>
export type GetPreviewOutput = z.infer<typeof GetPreviewOutput>
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>
export type AnswerQuestionOutput = z.infer<typeof AnswerQuestionOutput>
export type CosTurn = z.infer<typeof CosTurn>
export type CosPrefix = z.infer<typeof CosPrefix>
export type CosContext = z.infer<typeof CosContext>
export type CosMessage = z.infer<typeof CosMessage>
export type CosToolResult = z.infer<typeof CosToolResult>
export type CosStep = z.infer<typeof CosStep>
export type CosCall = z.infer<typeof CosCall>
