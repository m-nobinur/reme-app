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
 * reasoning so OpenRouter may route the step to any host, on the fallback
 * model when there is one. The step loses the model's earlier reasoning,
 * never the conversation or the tool results.
 *
 * Reasoning is never shown to the owner, so a failure after reasoning alone
 * is still a failure before anything streamed: the failed attempt's open
 * reasoning is closed and the next one goes on. On 2026-10-28 a 502 after
 * reasoning reached the owner as "Something went wrong".
 */

/** Pauses before the second and third attempts. */
const RETRY_PAUSES_MS = [300, 800] as const

/** What the owner or the next step can use: once one has passed, never retry. */
const CONTENT = new Set<Part["type"]>([
  "text-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-call",
  "tool-result",
  "file",
  "source",
])

type Failure = {
  code?: unknown
  statusCode?: unknown
  status?: unknown
  message?: unknown
  error?: Failure
}

/**
 * A provider status worth another attempt: a timeout, a rate limit, a server
 * error. Read at the top or under `error`, as OpenRouter nests it in a chunk.
 */
export function retryableStatus(error: unknown): number | null {
  const outer = (error ?? {}) as Failure
  const status = Number(
    outer.statusCode ??
      outer.status ??
      outer.code ??
      outer.error?.statusCode ??
      outer.error?.status ??
      outer.error?.code
  )
  return status === 408 || status === 429 || (status >= 500 && status < 600)
    ? status
    : null
}

/**
 * A failure's own words, cut, for the log: what a status alone does not say.
 * An email address or a phone-length run of digits a provider echoed is
 * masked, since personal details never go in a log.
 */
export function failureMessage(error: unknown): string | null {
  const outer = (error ?? {}) as Failure
  const message = outer.message ?? outer.error?.message
  return typeof message === "string"
    ? message
        .replace(/[^\s@]+@[^\s@]+/g, "[email]")
        .replace(/\+?\d[\d\s-]{6,}\d/g, "[number]")
        .slice(0, 300)
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

/** A model a step can be sent to. */
type Model = { doStream: (params: Params) => PromiseLike<Result> }

/**
 * The middleware, with `fallback` taking the last attempt when given. Parts
 * pass through as they come; while nothing the owner or the next step can
 * use has passed, a retryable failure starts the next attempt in place.
 */
export const retryMiddlewareWith = (
  fallback: Model | null = null
): LanguageModelMiddleware => ({
  wrapStream: async ({ doStream, params, model }) => {
    const bare = { ...params, prompt: withoutReasoning(params.prompt) }
    const attempts: (() => PromiseLike<Result>)[] = [
      doStream,
      () => model.doStream(params),
      () => (fallback ?? model).doStream(bare),
    ]
    let i = 0
    const first = await doStream()
    let reader = first.stream.getReader()
    let used = false
    const open = new Set<string>()
    const stream = new ReadableStream<Part>({
      async pull(controller) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return controller.close()
          const failed = value.type === "error" ? value.error : undefined
          const status =
            value.type === "error" && !used && i < attempts.length - 1
              ? retryableStatus(failed)
              : null
          if (status === null) {
            if (value.type === "reasoning-start") open.add(value.id)
            if (value.type === "reasoning-end") open.delete(value.id)
            if (CONTENT.has(value.type)) used = true
            return controller.enqueue(value)
          }
          await reader.cancel().catch(() => undefined)
          for (const id of open) {
            controller.enqueue({ type: "reasoning-end", id } as Part)
          }
          open.clear()
          i++
          console.log(
            JSON.stringify({
              code: "cos.retry",
              attempt: i + 1,
              status,
              message: failureMessage(failed),
              ...(i === attempts.length - 1 && fallback && { fallback: true }),
            })
          )
          await pause(RETRY_PAUSES_MS[i - 1] as number, params.abortSignal)
          try {
            reader = (
              await (attempts[i] as () => PromiseLike<Result>)()
            ).stream.getReader()
          } catch (error) {
            controller.enqueue({ type: "error", error } as Part)
            return controller.close()
          }
        }
      },
      cancel: (reason) => reader.cancel(reason),
    })
    return { ...first, stream }
  },
})

export const retryMiddleware = retryMiddlewareWith()

/**
 * The CoS model, with a failed step's opening tried again, the last time on
 * `fallback` when there is one.
 */
export const retrying = (
  model: LanguageModel | null,
  fallback: LanguageModel | null = null
) =>
  model && typeof model !== "string"
    ? wrapLanguageModel({
        model: model as never,
        middleware: retryMiddlewareWith(
          fallback && typeof fallback !== "string"
            ? (fallback as unknown as Model)
            : null
        ),
      })
    : model
