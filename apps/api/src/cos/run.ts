import {
  CosContinue,
  type CosToolName as CosTool,
  CosToolName,
  type CosTurn,
  MAX_CONTINUATIONS,
  type MemoryChip,
  type MessageReading,
  ONBOARDING_STATUS,
  type OnboardingStatus,
} from "@workspace/contracts"
import { lowerNextDue, type OrgScopedDb, scheduledJobs } from "@workspace/db"
import { scrub } from "@workspace/facade/tee"
import {
  createAgentUIStream,
  createUIMessageStreamResponse,
  type LanguageModel,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import { withoutProviderData } from "../http.ts"
import { thoughtHeadings } from "../thinking.ts"
import {
  type AgentTurn,
  caughtUp,
  cosAgent,
  LIMITS,
  messageTaint,
  NotRun,
  type RunState,
  runTool,
  toolErrorText,
} from "./agent.ts"
import {
  CONTEXT_POLICY,
  deriveCosMessages,
  type SessionEvent,
} from "./history.ts"
import { contentWords } from "./memory.ts"
import { failureMessage } from "./retry.ts"
import { ToolFailed } from "./tools.ts"
import { abandonTurn, type Turn, TurnClosed, writeAsTurn } from "./turns.ts"
import { voiced } from "./voice.ts"

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
const ERROR_TEXT = "Something went wrong on our side. Try again."

/** A chunk that shows the model has answered: text, reasoning or tool input. */
const isContent = (chunk: UIMessageChunk) =>
  chunk.type.startsWith("text-") ||
  chunk.type.startsWith("reasoning-") ||
  chunk.type.startsWith("tool-input-")

/**
 * A new message's time, sent as its row is written, so the thread shows what
 * a reload reads from `created_at` rather than the browser's render clock.
 */
export const writtenAt = (): UIMessageChunk => ({
  type: "message-metadata",
  messageMetadata: { custom: { createdAt: new Date().toISOString() } },
})

/** How much of a text's own words a later one must hold to say it again. */
const RESTATED = 0.6

/**
 * `parts` without a text that a text after a tool says again, as "The only
 * thing left is the records", a check, then "The records still aren't
 * showing, adding those is the only step left": the owner reads it once
 * from the stored message. A text of under three words of its own stays.
 */
export function withoutRestated<P extends { type: string; text?: string }>(
  parts: readonly P[]
): P[] {
  return parts.filter((part, i) => {
    if (part.type !== "text" || !part.text) return true
    const own = new Set(contentWords(part.text))
    if (own.size < 3) return true
    const after = parts.slice(i + 1)
    const tool = after.findIndex((p) => p.type.startsWith("tool-"))
    if (tool < 0) return true
    return !after.slice(tool + 1).some((p) => {
      if (p.type !== "text" || !p.text) return false
      const later = new Set(contentWords(p.text))
      return [...own].filter((w) => later.has(w)).length / own.size >= RESTATED
    })
  })
}

/** A tool part the model left unfinished. It never enters the history. */
const unfinished = (part: UIMessage["parts"][number]) =>
  "toolCallId" in part &&
  (part.state === "input-streaming" || part.state === "input-available")

/**
 * A system job to carry on from `turn`, due now, its `attempt` counting
 * the continuations of the owner's turn.
 */
async function queueContinue(db: OrgScopedDb, turn: Turn, attempt: number) {
  await db.insert(scheduledJobs).values({
    orgId: turn.orgId,
    kind: "cos_continue",
    refId: turn.sessionId,
    payload: CosContinue.parse({ turn_id: turn.turnId, attempt }),
    nextRunAt: new Date(),
  })
}

/** What the closing transaction writes besides the log: the stored rows. */
export type Rows = (
  db: OrgScopedDb,
  message: { id: string; role: string; parts: unknown[]; partial?: true }
) => Promise<void>

type StreamTurn = {
  run: AgentTurn
  model: LanguageModel
  mode: "ask" | "act"
  modelId: string
  uiMessages: UIMessage[]
  /** The response's id when it is a new message. */
  newMessageId: () => string
  /** Chunks sent right after `start`: the owner's results as resolved. */
  lead: UIMessageChunk[]
  /** Memory changes not yet shown: the reply's first part, in the stream, the log and the row. */
  chip: MemoryChip | null
  /**
   * Which continuation this run is, for a turn carrying on from one cut off
   * at its limit. Its reply is a new message after the one it continues.
   */
  attempt?: number
  /** Jev's reading of a typed message, for the waiting line while the model thinks. */
  reading: Promise<MessageReading | null> | null
  rows: Rows
  waitUntil: (promise: Promise<unknown>) => void
}

/** A transient status chunk: the waiting line, never stored. */
const status = (on: OnboardingStatus["on"]): UIMessageChunk => ({
  type: ONBOARDING_STATUS,
  data: { on, facts: [] } satisfies OnboardingStatus,
  transient: true,
})

/** The turn fell back before any content: nothing was streamed. */
export type FellBack = { fallback: true; state: RunState }

type Ended = { message: UIMessage | null; aborted: boolean }

/** The `cos.turn` of a run that got as far as a model call. */
export function ranTurn<
  O extends "answered" | "error" | "integrity" | "stopped",
>(
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
  // Taken only if it lands before the first content: it never holds the turn.
  let reading = null as MessageReading | null
  void input.reading?.then((about) => {
    reading = about
  })
  let settleEnd: (end: Ended) => void = () => undefined
  const ended = new Promise<Ended>((resolve) => {
    settleEnd = resolve
  })
  const chunks = await createAgentUIStream({
    agent: cosAgent(run, input.model, input.mode),
    uiMessages: input.uiMessages,
    abortSignal: run.abort.signal,
    timeout: { totalMs: LIMITS.totalMs, firstChunkMs: LIMITS.firstChunkMs },
    experimental_transform: voiced(run.turn.turnId),
    // A history ending on an assistant message is continued in that message,
    // which a continuation must not do: the owner's chat follows a new one.
    originalMessages: (input.attempt ? [] : input.uiMessages) as never,
    generateMessageId: input.newMessageId,
    onError: (error) => {
      // The SDK reports each error chunk a second time, as an Error holding
      // the text returned here, which is not a second failure.
      if (error instanceof Error && error.message === ERROR_TEXT) {
        return ERROR_TEXT
      }
      // A provider's status and code say whether it was a rate limit or a
      // refusal, and its message what a name alone does not, cut and scrubbed.
      const { statusCode, code } = (error ?? {}) as {
        statusCode?: unknown
        code?: unknown
      }
      const message = failureMessage(error)
      console.error(
        JSON.stringify({
          code: "cos.stream_error",
          turn_id: run.turn.turnId,
          error: error instanceof Error ? error.name : "unknown",
          status: typeof statusCode === "number" ? statusCode : null,
          provider_code:
            typeof code === "string" || typeof code === "number" ? code : null,
          message: message && scrub(message),
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

  // Streamed as a data part, and kept with the message like any other part.
  const chip = input.chip
    ? ({ type: "data-memory", data: input.chip } as const)
    : null

  /**
   * The closing transaction: the response, its `cos.turn` and its rows. A
   * run cut off once content streamed keeps what streamed, marked
   * `stopped`, so its cards survive a reload. Cut off, or out of steps, it
   * is `partial` too, and a `cos_continue` job is queued in the same
   * transaction while the turn has continuations left.
   */
  const closeRun = async () => {
    const last = await ended
    const parts = (last.message?.parts ?? []).filter((p) => !unfinished(p))
    // A run that lost its token can write nothing more.
    if (
      !last.message ||
      (last.aborted &&
        (run.abort.signal.aborted ||
          !parts.some((p) => p.type !== "step-start")))
    ) {
      await run.kit
        .withOrg({ orgId: run.turn.orgId }, (db) => abandonTurn(db, run.turn))
        .catch((error: unknown) => {
          if (!(error instanceof TurnClosed)) throw error
        })
      return false
    }
    const outcome = last.aborted
      ? "stopped"
      : run.state.integrity
        ? "integrity"
        : errored
          ? "error"
          : "answered"
    const partial =
      outcome === "stopped" ||
      (outcome === "answered" && run.state.steps >= LIMITS.steps)
    const attempt = (input.attempt ?? 0) + 1
    const queue = partial && attempt <= MAX_CONTINUATIONS
    // Only what a stored message holds: the SDK's may carry `metadata`.
    const message = {
      id: last.message.id,
      role: last.message.role,
      parts: [...(chip ? [chip] : []), ...withoutRestated(parts)],
      ...(last.aborted && { stopped: true }),
      ...(partial && { partial: true }),
    }
    await closeTurn(
      run,
      ranTurn(run, input.modelId, outcome, firstChunkMs),
      message as UIMessage,
      queue
        ? async (db, stored) => {
            await input.rows(db, stored)
            await queueContinue(db, run.turn, attempt)
          }
        : (db, { partial: _, ...stored }) => input.rows(db, stored)
    )
    if (queue) {
      const { env } = run.tools
      await lowerNextDue(env.SCHEDULE, new Date(), env.JOBS)
    }
    return true
  }

  let queued = [...head]
  const [start, ...rest] = queued
  // The general line fills a model's silent thinking; once it writes or a
  // heading comes, that line is the real one.
  const thinking = head.at(-1)?.type.startsWith("reasoning-")
  const general =
    reading && thinking ? [status({ kind: "reading", about: reading })] : []
  queued =
    start?.type === "start"
      ? [start, ...(chip ? [chip] : []), ...input.lead, ...general, ...rest]
      : queued
  // A message the history does not hold yet gets its row at the close.
  const fresh =
    start?.type === "start" &&
    !input.uiMessages.some((m) => m.id === start.messageId)
  let finish: UIMessageChunk | null = null
  let errored = queued.some((c) => c.type === "error")
  // Reasoning counts as content above and stays in the log, but the owner
  // never sees it, as a chunk or as a provider's data on one: only each
  // thought's heading, as a transient status.
  const think = thoughtHeadings((text) =>
    queued.push(status({ kind: "thinking", text }))
  )
  const body = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        let chunk = queued.shift()
        if (!chunk) {
          const { done, value } = await read()
          if (done) break
          chunk = value
        }
        if (chunk.type === "finish") finish = chunk
        else if (chunk.type === "reasoning-delta") think(chunk.delta)
        else if (!chunk.type.startsWith("reasoning-")) {
          if (chunk.type === "error") errored = true
          controller.enqueue(withoutProviderData(chunk))
          return
        }
      }
      try {
        if ((await closeRun()) && finish) {
          if (fresh) controller.enqueue(writtenAt())
          controller.enqueue(finish)
        }
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
  messageId: string
  toolCallId: string
  tool: CosTool
  input: unknown
  approvalId: string
}

/** The session's messages in `rows`, unpruned. */
const logged = (rows: SessionEvent[]): UIMessage[] =>
  deriveCosMessages(rows, {
    ...CONTEXT_POLICY,
    turns: Number.POSITIVE_INFINITY,
    toolTurns: Number.POSITIVE_INFINITY,
    historyTokens: Number.POSITIVE_INFINITY,
  }).messages

/**
 * Every call the owner approved that the log holds no result for, in log
 * order: the ones this turn's results just approved, and any a dead turn
 * approved and never finished.
 */
function unsettled(run: AgentTurn): Call[] {
  return logged(run.log).flatMap((message) =>
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
                  messageId: message.id,
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
 * already happened, logs its `cos.tool_result` under this turn's token
 * (ADR-034, "an approved call with no result") and rewrites the stored row
 * of the message that holds it, so a reload shows the outcome. A call that
 * does not run or does not answer is closed as `output-error` with the text
 * the model reads for it, and the model tells the owner (ADR-042): a
 * `ToolFailed` of class `integrity`, an answer off the contract, did
 * nothing; any other `ToolFailed` left the outcome unknown, and `runTool`
 * logged it so it never runs again; a `NotRun` was refused before it ran. It
 * reads the log only after it ran a call, and leaves `run.log` caught up.
 */
export async function settle(run: AgentTurn, rows: Rows): Promise<void> {
  for (const call of unsettled(run)) {
    let failed: ToolFailed | NotRun | null = null
    try {
      await runTool(
        run,
        call.tool,
        call.input,
        call.toolCallId,
        call.approvalId
      )
    } catch (error) {
      if (!(error instanceof ToolFailed || error instanceof NotRun)) {
        throw error
      }
      failed = error
    }
    await run.kit.withOrg({ orgId: run.turn.orgId }, async (db) => {
      // Caught up: the result, or an earlier call's in the same message, is
      // in the log by now.
      const current = logged(await caughtUp(db, run)).find(
        (m) => m.id === call.messageId
      )
      if (!current)
        throw failed ?? new Error("cos.run: a settled call's message is gone")
      if (!failed) {
        // The result is logged; the stored row shows it too.
        await rows(db, current)
        return
      }
      const message = {
        ...current,
        parts: current.parts.map((part) =>
          "toolCallId" in part && part.toolCallId === call.toolCallId
            ? {
                ...part,
                state: "output-error",
                errorText: toolErrorText(failed),
              }
            : part
        ),
      } as UIMessage
      await writeAsTurn(db, run.turn, [
        {
          type: "cos.message",
          payload: { turn_id: run.turn.turnId, message: message as never },
          taint: messageTaint(message),
        },
      ])
      await rows(db, message)
      await caughtUp(db, run)
    })
  }
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
