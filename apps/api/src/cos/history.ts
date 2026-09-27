import {
  CosContext,
  CosMessage,
  CosStep,
  CosToolResult,
  type TaintLabel,
} from "@workspace/contracts"
import { eq, events, type OrgScopedDb } from "@workspace/db"
// Types only, so `ai` stays out of the bundle until the agent brings it.
import type { ModelMessage, UIMessage } from "ai"
import { sha256Hex, sortedKeys } from "../http.ts"

/**
 * The model's history, derived from a session's events and nothing else
 * (ADR-034, §10.6). The derivation reads no clock, no environment and no
 * table, so the same events give the same messages on every run, a
 * replay's included.
 */

/** One row of a session's log: its position, type and payload. */
export type SessionEvent = { seq: number; type: string; payload: unknown }

/** A row as the log holds it, with the taint labels it was written with. */
export type LoggedEvent = SessionEvent & { taint: TaintLabel[] }

/**
 * A session's events, in seq order. `sessionId` is a conversation id read
 * under the same `withOrg`.
 */
export async function readSession(
  db: OrgScopedDb,
  sessionId: string
): Promise<LoggedEvent[]> {
  const rows = await db
    .select({
      seq: events.seq,
      type: events.type,
      payload: events.payload,
      taint: events.taint,
    })
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(events.seq)
  return rows.map((row) => ({ ...row, seq: Number(row.seq) }))
}

/**
 * How much history a call carries. A turn here is an owner message and the
 * replies after it. `version` is logged in every `cos.context`, so a replay
 * knows which policy shaped a call's messages.
 */
export type ContextPolicy = {
  version: string
  /** The newest turns kept. */
  turns: number
  /** The newest turns that keep their tool calls; older turns keep only their text. */
  toolTurns: number
}

export const CONTEXT_POLICY: ContextPolicy = {
  version: "1",
  turns: 12,
  toolTurns: 2,
}

/** What a call is sent, in the two forms the log holds it. */
export type CosCallMessages = {
  /** The history as UI messages, for `convertToModelMessages`. */
  messages: UIMessage[]
  /** The response messages of the turn's earlier steps, as the SDK held them. */
  steps: ModelMessage[]
}

type Message = CosMessage["message"]
type Part = Message["parts"][number]

const isTool = (part: Part) =>
  part.type.startsWith("tool-") || part.type === "dynamic-tool"

/**
 * A step's messages, which are the model's response: assistant text and
 * calls, and the tools' results. Any other role is refused.
 */
export function stepMessages(step: CosStep): ModelMessage[] {
  for (const message of step.messages) {
    if (message.role !== "assistant" && message.role !== "tool") {
      throw new Error(
        `cos.history: a step holds a ${String(message.role)} message`
      )
    }
  }
  return step.messages as ModelMessage[]
}

/**
 * `message` with `result` as the output of the call it names, when that
 * call was approved and is waiting to run. That is the one state a result
 * reaches the log before the message that shows it: every other call's
 * outcome arrives inside a whole `cos.message`. A call in any other state,
 * a denied one included, is never changed, so a provider that reuses a call
 * id in a later turn cannot rewrite an earlier call.
 */
function resolved(message: Message, result: CosToolResult): Message {
  const waiting = (part: Part) =>
    part.toolCallId === result.tool_call_id &&
    part.type === `tool-${result.tool}` &&
    part.state === "approval-responded" &&
    (part.approval as { approved?: unknown } | undefined)?.approved === true
  if (!message.parts.some(waiting)) return message
  return {
    ...message,
    parts: message.parts.map((part) =>
      waiting(part)
        ? { ...part, state: "output-available", output: result.output }
        : part
    ),
  }
}

/**
 * The messages for the next call of the session's latest turn: the last
 * `cos.message` for each id in order of first appearance, each
 * `cos.tool_result` applied to its approved call as the log stood when the
 * result was written, the turn's `cos.context` text just before the owner's
 * latest message, and the `cos.step` messages the turn logged so far.
 * Throws when the log holds no turn, the turn was logged under another
 * policy, a message changes role, or an event of this turn is off its
 * contract.
 */
export function deriveCosMessages(
  rows: readonly SessionEvent[],
  policy: ContextPolicy
): CosCallMessages {
  const log = [...rows].sort((a, b) => a.seq - b.seq)
  const contexts = log.filter((e) => e.type === "cos.context")
  const last = contexts[contexts.length - 1]
  if (!last) throw new Error("cos.history: the session has no turn")
  const context = CosContext.parse(last.payload)
  if (context.context_policy_version !== policy.version) {
    throw new Error(
      `cos.history: the turn was logged under policy ${context.context_policy_version}, not ${policy.version}`
    )
  }

  if (!(policy.turns >= 1)) {
    throw new Error("cos.history: a policy keeps at least one turn")
  }

  // A Map keeps a key where it was first set, which is the order wanted.
  const byId = new Map<string, Message>()
  const steps: ModelMessage[] = []
  for (const event of log) {
    if (event.type === "cos.message") {
      const { message } = CosMessage.parse(event.payload)
      const before = byId.get(message.id)
      if (before && before.role !== message.role) {
        throw new Error(`cos.history: message ${message.id} changed role`)
      }
      byId.set(message.id, message)
    } else if (event.type === "cos.tool_result") {
      const result = CosToolResult.parse(event.payload)
      for (const [id, message] of byId) byId.set(id, resolved(message, result))
    } else if (
      event.type === "cos.step" &&
      (event.payload as { turn_id?: unknown } | null)?.turn_id ===
        context.turn_id
    ) {
      // Only this turn's steps are read, so an older turn's rows are never
      // parsed again.
      steps.push(...stepMessages(CosStep.parse(event.payload)))
    }
  }

  const messages = pruned([...byId.values()], policy) as UIMessage[]
  const note = {
    id: `context-${context.turn_id}`,
    role: "user",
    parts: [{ type: "text", text: context.text }],
  } as UIMessage
  const owner = messages.map((m) => m.role).lastIndexOf("user")
  messages.splice(owner < 0 ? messages.length : owner, 0, note)
  return { messages, steps }
}

/**
 * The newest `policy.turns` turns, with tool calls kept only in the newest
 * `policy.toolTurns`. A message left with nothing but step boundaries is
 * dropped. Messages before the first owner message count as a turn.
 */
function pruned(messages: Message[], policy: ContextPolicy): Message[] {
  const turns: Message[][] = []
  for (const message of messages) {
    const open = turns[turns.length - 1]
    if (message.role === "user" || !open) turns.push([message])
    else open.push(message)
  }
  const kept = turns.slice(-policy.turns)
  const full = kept.length - policy.toolTurns
  return kept.flatMap((turn, i) =>
    i >= full
      ? turn
      : turn.flatMap((message) => {
          const parts = message.parts.filter((p) => !isTool(p))
          return parts.some((p) => p.type !== "step-start")
            ? [{ ...message, parts }]
            : []
        })
  )
}

/**
 * The SHA-256 of a value's JSON with keys in code-point order at every
 * depth, as lowercase hex. jsonb keeps its own key order, so a value read
 * back from the log hashes the same as the one written.
 */
export function sha256(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value, sortedKeys))
}
