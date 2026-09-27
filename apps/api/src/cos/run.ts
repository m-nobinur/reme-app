import {
  type CosToolName as CosTool,
  CosToolName,
  type CosTurn,
} from "@workspace/contracts"
import type { OrgScopedDb } from "@workspace/db"
import {
  createAgentUIStream,
  createUIMessageStreamResponse,
  type LanguageModel,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import {
  type AgentTurn,
  cosAgent,
  LIMITS,
  messageTaint,
  type RunState,
  runTool,
  toolErrorText,
} from "./agent.ts"
import { CONTEXT_POLICY, deriveCosMessages, readSession } from "./history.ts"
import { ToolFailed } from "./tools.ts"
import { abandonTurn, TurnClosed, writeAsTurn } from "./turns.ts"

/**
 * One turn's model run, streamed (ADR-034, "the budget lock and the
 * stream"). `createAgentUIStream` gives the chunks; this reads them until
 * the first content chunk, so an error before any content becomes the
 * fallback rather than a stream, and afterwards passes them through with
 * `finish` held until the turn's closing transaction has committed. The
 * response is built by `createUIMessageStreamResponse`, whose
 * `consumeSseStream` branch is read to its end under `waitUntil`, so a
 * closed tab does not stop the run.
 */

/** The sanitised text of any error chunk the owner sees. */
export const ERROR_TEXT = "Something went wrong on our side. Try again."

/** A chunk that shows the model has answered: text, reasoning or tool input. */
const isContent = (chunk: UIMessageChunk) =>
  chunk.type.startsWith("text-") ||
  chunk.type.startsWith("reasoning-") ||
  chunk.type.startsWith("tool-input-")

/** A tool part the model left unfinished. It never enters the history. */
const unfinished = (part: UIMessage["parts"][number]) =>
  "toolCallId" in part &&
  (part.state === "input-streaming" || part.state === "input-available")

/** What the closing transaction writes besides the log: the stored rows. */
export type Rows = (
  db: OrgScopedDb,
  message: { id: string; role: string; parts: unknown[] }
) => Promise<void>

export type StreamTurn = {
  run: AgentTurn
  model: LanguageModel
  mode: "ask" | "act"
  modelId: string
  uiMessages: UIMessage[]
  /** The response's id when it is a new message. */
  newMessageId: () => string
  /** Chunks sent right after `start`: the owner's results as resolved. */
  lead: UIMessageChunk[]
  rows: Rows
  waitUntil: (promise: Promise<unknown>) => void
}

/** The turn fell back before any content: nothing was streamed. */
export type FellBack = { fallback: true; state: RunState }

type Ended = { message: UIMessage | null; aborted: boolean }

/** The `cos.turn` of a run that got as far as a model call. */
export function ranTurn<O extends "answered" | "error" | "integrity">(
  run: AgentTurn,
  modelId: string,
  outcome: O,
  firstChunkMs: number | null
): Extract<CosTurn, { outcome: O }> {
  return {
    outcome,
    turn_id: run.turn.turnId,
    model: modelId,
    usage: run.state.usage,
    cost_usd: run.state.costUsd,
    tools: [...new Set(run.state.tools)],
    steps: Math.min(run.state.steps, LIMITS.steps),
    first_chunk_ms: firstChunkMs,
  } as Extract<CosTurn, { outcome: O }>
}

/**
 * Starts the run and waits for its first content chunk. Returns the
 * streaming response, or `FellBack` when the run errored or stopped before
 * any content; the run has then finished and nothing was logged for it
 * beyond its steps.
 */
export async function streamTurn(
  input: StreamTurn
): Promise<Response | FellBack> {
  const { run } = input
  const started = Date.now()
  let settleEnd: (end: Ended) => void = () => undefined
  const ended = new Promise<Ended>((resolve) => {
    settleEnd = resolve
  })
  const chunks = await createAgentUIStream({
    agent: cosAgent(run, input.model, input.mode),
    uiMessages: input.uiMessages,
    abortSignal: run.abort.signal,
    timeout: { totalMs: LIMITS.totalMs, firstChunkMs: LIMITS.firstChunkMs },
    originalMessages: input.uiMessages as never,
    generateMessageId: input.newMessageId,
    onError: (error) => {
      console.error(
        JSON.stringify({
          code: "cos.stream_error",
          turn_id: run.turn.turnId,
          error: error instanceof Error ? error.name : "unknown",
        })
      )
      return ERROR_TEXT
    },
    onEnd: ({ responseMessage, isAborted }) =>
      settleEnd({ message: responseMessage as UIMessage, aborted: isAborted }),
  })
  const reader = (chunks as ReadableStream<UIMessageChunk>).getReader()
  const read = async () => {
    try {
      return await reader.read()
    } catch {
      // A broken pipeline never reaches `onEnd`.
      settleEnd({ message: null, aborted: true })
      return { done: true as const, value: undefined }
    }
  }

  const head: UIMessageChunk[] = []
  let content = false
  for (;;) {
    const { done, value } = await read()
    if (done) break
    if (value.type === "error" || value.type === "abort") {
      head.push(value)
      break
    }
    head.push(value)
    if (isContent(value)) {
      content = true
      break
    }
  }
  if (!content) {
    while (!(await read()).done) {
      // Drained, so the run has ended before the fallback writes.
    }
    await ended
    return { fallback: true, state: run.state }
  }
  const firstChunkMs = Date.now() - started

  /** The closing transaction: the response, its `cos.turn` and its rows. */
  const closeRun = async () => {
    const last = await ended
    if (last.aborted || !last.message) {
      await run.kit
        .withOrg({ orgId: run.turn.orgId }, (db) => abandonTurn(db, run.turn))
        .catch((error: unknown) => {
          if (!(error instanceof TurnClosed)) throw error
        })
      return false
    }
    const outcome = run.state.integrity
      ? "integrity"
      : errored
        ? "error"
        : "answered"
    // Only what a stored message holds: the SDK's may carry `metadata`.
    const message = {
      id: last.message.id,
      role: last.message.role,
      parts: last.message.parts.filter((p) => !unfinished(p)),
    }
    await closeTurn(
      run,
      ranTurn(run, input.modelId, outcome, firstChunkMs),
      message as UIMessage,
      input.rows
    )
    return true
  }

  let queued = [...head]
  const [start, ...rest] = queued
  queued = start?.type === "start" ? [start, ...input.lead, ...rest] : queued
  let finish: UIMessageChunk | null = null
  let errored = queued.some((c) => c.type === "error")
  const body = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const next = queued.shift()
      if (next) {
        controller.enqueue(next)
        return
      }
      const { done, value } = await read()
      if (!done) {
        if (value.type === "finish") finish = value
        else {
          if (value.type === "error") errored = true
          controller.enqueue(value)
        }
        return
      }
      try {
        if ((await closeRun()) && finish) controller.enqueue(finish)
      } catch (error) {
        console.error(
          JSON.stringify({
            code: "cos.close_failed",
            turn_id: run.turn.turnId,
            error: error instanceof Error ? error.name : "unknown",
          })
        )
        controller.enqueue({ type: "error", errorText: ERROR_TEXT })
      }
      controller.close()
    },
  })
  return createUIMessageStreamResponse({
    stream: body,
    consumeSseStream: ({ stream }) => {
      input.waitUntil(
        (async () => {
          const branch = stream.getReader()
          while (!(await branch.read()).done) {
            // Read to the end, so the run and its close go on without a reader.
          }
        })()
      )
    },
  })
}

type Call = {
  message: UIMessage
  toolCallId: string
  tool: CosTool
  input: unknown
  approvalId: string
}

/**
 * Every call the owner approved that the log holds no result for, in log
 * order, read unpruned: the ones this turn's results just approved, and
 * any a dead turn approved and never finished.
 */
export async function unsettled(run: AgentTurn): Promise<Call[]> {
  const rows = await run.kit.withOrg({ orgId: run.turn.orgId }, (db) =>
    readSession(db, run.turn.sessionId)
  )
  const { messages } = deriveCosMessages(rows, {
    ...CONTEXT_POLICY,
    turns: Number.POSITIVE_INFINITY,
    toolTurns: Number.POSITIVE_INFINITY,
  })
  return messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part) => {
          const p = part as {
            type: string
            state?: string
            toolCallId?: string
            input?: unknown
            approval?: { id: string; approved?: boolean }
          }
          const tool = CosToolName.safeParse(p.type.slice("tool-".length))
          return p.state === "approval-responded" &&
            p.approval?.approved === true &&
            tool.success &&
            p.toolCallId
            ? [
                {
                  message,
                  toolCallId: p.toolCallId,
                  tool: tool.data,
                  input: p.input,
                  approvalId: p.approval.id,
                },
              ]
            : []
        })
  )
}

/**
 * Runs each unsettled call under its approval id, which replays a run that
 * already happened, and logs its `cos.tool_result` under this turn's token
 * (ADR-034, "an approved call with no result"). A `ToolFailed` of class
 * `integrity` is an answer off the contract, which committed nothing and
 * would fail the same way again, so the call is closed as `output-error`
 * with the text the model reads for it. Any other `ToolFailed` leaves the
 * outcome unknown: it is returned, with the call left open for a later turn
 * to run again.
 */
export async function settle(
  run: AgentTurn,
  rows: Rows
): Promise<ToolFailed | null> {
  for (const call of await unsettled(run)) {
    try {
      await runTool(
        run,
        call.tool,
        call.input as never,
        call.toolCallId,
        call.approvalId
      )
    } catch (error) {
      if (!(error instanceof ToolFailed)) throw error
      if (error.error.class !== "integrity") return error
      const message = {
        ...call.message,
        parts: call.message.parts.map((part) =>
          "toolCallId" in part && part.toolCallId === call.toolCallId
            ? {
                ...part,
                state: "output-error",
                errorText: toolErrorText(error),
              }
            : part
        ),
      } as UIMessage
      await run.kit.withOrg({ orgId: run.turn.orgId }, async (db) => {
        await writeAsTurn(db, run.turn, [
          {
            type: "cos.message",
            payload: { turn_id: run.turn.turnId, message: message as never },
            taint: messageTaint(message),
          },
        ])
        await rows(db, message)
      })
    }
  }
  return null
}

/**
 * Closes a turn that ends without streaming: a fallback, an error before
 * the model, or an integrity refusal at the first call. `message`, when
 * given, is logged as the turn's response first.
 */
export async function closeTurn(
  run: AgentTurn,
  payload: CosTurn,
  message: UIMessage | null,
  rows: Rows
): Promise<void> {
  await run.kit.withOrg({ orgId: run.turn.orgId }, async (db) => {
    await writeAsTurn(db, run.turn, [
      ...(message
        ? [
            {
              type: "cos.message" as const,
              payload: { turn_id: run.turn.turnId, message: message as never },
              taint: messageTaint(message),
            },
          ]
        : []),
      { type: "cos.turn" as const, payload },
    ])
    if (message) await rows(db, message)
  })
}
