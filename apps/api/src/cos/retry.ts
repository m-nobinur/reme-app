import {
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai"

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>
type Params = Parameters<WrapStream>[0]["params"]
type Result = Awaited<ReturnType<WrapStream>>
type Part = Result["stream"] extends ReadableStream<infer P> ? P : never

/**
 * A CoS step that fails inside its stream before it has produced anything is
 * tried again, so a host's passing rate limit does not reach the owner as
 * "Something went wrong".
 *
 * OpenRouter answers 200 and then sends the failure as an `{error: {code}}`
 * chunk, which the SDK's own retries never see: they cover a request that
 * fails before its stream opens. And once a turn's first step has run on a
 * host, the encrypted reasoning it returned can only be read by that host,
 * so every later step is pinned there. On 2026-10-01 a step pinned to Azure
 * was refused that way mid-turn (an in-stream 429). So the second attempt
 * goes to the same host, after a pause, and the third drops the encrypted
 * reasoning so OpenRouter may route the step to any host. The step loses the
 * model's earlier reasoning, never the conversation or the tool results.
 */

/** Pauses before the second and third attempts. */
const RETRY_PAUSES_MS = [300, 800] as const

/** What the owner or the next step can use: once one has passed, never retry. */
const CONTENT = new Set<Part["type"]>([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-call",
  "tool-result",
  "file",
  "source",
])

/** A provider status worth another attempt: a timeout, a rate limit, a server error. */
export function retryableStatus(error: unknown): number | null {
  const { code, statusCode } = (error ?? {}) as {
    code?: unknown
    statusCode?: unknown
  }
  const status = Number(statusCode ?? code)
  return status === 408 || status === 429 || (status >= 500 && status < 600)
    ? status
    : null
}

/** The prompt with OpenRouter's encrypted reasoning taken out of every assistant turn. */
export function withoutReasoning(prompt: Params["prompt"]): Params["prompt"] {
  const bare = <T extends { providerOptions?: unknown }>(item: T): T => {
    const options = item.providerOptions as
      | { openrouter?: Record<string, unknown> }
      | undefined
    if (!options?.openrouter?.reasoning_details) return item
    const { reasoning_details: _, ...openrouter } = options.openrouter
    return { ...item, providerOptions: { ...options, openrouter } }
  }
  return prompt.map((message) =>
    message.role === "assistant"
      ? bare({
          ...message,
          content: message.content
            .filter((part) => part.type !== "reasoning")
            .map(bare),
        })
      : message
  ) as Params["prompt"]
}

const pause = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })

/**
 * Reads `stream` until its first content part. Returns the parts read so far
 * and the rest of the stream, or, when `retry` allows, the status of a
 * retryable failure that came before any content.
 */
async function opening(stream: ReadableStream<Part>, retry: boolean) {
  const reader = stream.getReader()
  const head: Part[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { head, reader, failed: null }
    const status = value.type === "error" ? retryableStatus(value.error) : null
    if (retry && status !== null) {
      await reader.cancel().catch(() => undefined)
      return { head, reader, failed: status }
    }
    head.push(value)
    if (CONTENT.has(value.type) || value.type === "error") {
      return { head, reader, failed: null }
    }
  }
}

export const retryMiddleware: LanguageModelMiddleware = {
  wrapStream: async ({ doStream, params, model }) => {
    const attempts: (() => PromiseLike<Result>)[] = [
      doStream,
      () => model.doStream(params),
      () =>
        model.doStream({ ...params, prompt: withoutReasoning(params.prompt) }),
    ]
    let i = 0
    for (;;) {
      const result = await (attempts[i] as () => PromiseLike<Result>)()
      const retry = i < attempts.length - 1
      const { head, reader, failed } = await opening(result.stream, retry)
      if (failed !== null) {
        i++
        console.log(
          JSON.stringify({ code: "cos.retry", attempt: i + 1, status: failed })
        )
        await pause(RETRY_PAUSES_MS[i - 1] as number, params.abortSignal)
        continue
      }
      const stream = new ReadableStream<Part>({
        start(controller) {
          for (const part of head) controller.enqueue(part)
        },
        async pull(controller) {
          const next = await reader.read()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        },
        cancel: (reason) => reader.cancel(reason),
      })
      return { ...result, stream }
    }
  },
}

/** The CoS model, with a failed step's opening tried again. */
export const retrying = (model: LanguageModel | null) =>
  model && typeof model !== "string"
    ? wrapLanguageModel({ model: model as never, middleware: retryMiddleware })
    : model
