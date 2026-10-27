import {
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai"

type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>
type Result = Awaited<ReturnType<WrapStream>>
type Part = Result["stream"] extends ReadableStream<infer P> ? P : never
type Finish = Extract<Part, { type: "finish" }>

/**
 * A step that ends on text alone ends the turn, since the SDK goes round
 * again only after a tool call. So a reply that promises work ("I'll set
 * that up now") and stops would leave the owner waiting on nothing. This asks
 * the model once more inside the same step, so whatever it then calls runs
 * through the SDK as any tool call does. The nudge is part of this call's
 * prompt only: it is not in the log, and not in the `cos.call` hash, which
 * covers the log's messages. The step's logged message holds the promise and
 * what followed it.
 */

/** What the model is told after a promise with no tool call. */
export const NUDGE =
  "You said you would do something but made no tool call. Do it now with your tools, or say plainly what stops you. Do not promise it again."

/** Re-runs in one turn. */
export const MAX_RERUNS = 2

/** Two calls' usage as one step's: counts added, anything else as the later call has it. */
function added<T>(first: T, later: T): T {
  if (typeof first === "number" && typeof later === "number") {
    return (first + later) as T
  }
  const plain = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  if (plain(first) && plain(later)) {
    return Object.fromEntries(
      [...new Set([...Object.keys(first), ...Object.keys(later)])].map(
        (key) => [key, added(first[key], later[key])]
      )
    ) as T
  }
  return later ?? first
}

/**
 * `promised` reads the text a call ended on; true runs the model again, at
 * most `MAX_RERUNS` times for the middleware's life, which is one turn. Text
 * streams as it comes and only the finish is held back until the reading is
 * in. A reading that throws ends the step as it would have ended.
 */
export function promiseGate(
  promised: (said: string) => Promise<boolean>
): LanguageModelMiddleware {
  let reruns = 0
  return {
    wrapStream: async ({ doStream, params, model }) => {
      const first = await doStream()
      let said = ""
      let calls = 0
      let finish: Finish | undefined
      const seen = (part: Part) => {
        if (part.type === "text-delta") said += part.delta
        if (part.type === "tool-call") calls++
      }
      const stream = first.stream.pipeThrough(
        new TransformStream<Part, Part>({
          transform(part, controller) {
            if (part.type === "finish") finish = part
            else {
              seen(part)
              controller.enqueue(part)
            }
          },
          async flush(controller) {
            let prompt = params.prompt
            while (
              finish?.finishReason.unified === "stop" &&
              calls === 0 &&
              said.trim() &&
              reruns < MAX_RERUNS &&
              (await promised(said).catch(() => false))
            ) {
              reruns++
              prompt = [
                ...prompt,
                { role: "assistant", content: [{ type: "text", text: said }] },
                { role: "user", content: [{ type: "text", text: NUDGE }] },
              ]
              const before = finish
              finish = undefined
              said = ""
              const reader = (
                await model.doStream({ ...params, prompt })
              ).stream.getReader()
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                if (value.type === "finish") {
                  finish = {
                    ...value,
                    usage: added(before.usage, value.usage),
                    providerMetadata: added(
                      before.providerMetadata,
                      value.providerMetadata
                    ) as Finish["providerMetadata"],
                  }
                } else if (value.type !== "stream-start") {
                  seen(value)
                  // Its own ids, so its blocks never meet the first call's.
                  controller.enqueue(
                    "id" in value && typeof value.id === "string"
                      ? { ...value, id: `${value.id}:${reruns}` }
                      : value
                  )
                }
              }
            }
            if (finish) controller.enqueue(finish)
          },
        })
      )
      return { ...first, stream }
    },
  }
}

/** The CoS model, with a reply that promises work run again. */
export const gated = (
  model: LanguageModel,
  promised: (said: string) => Promise<boolean>
) =>
  typeof model === "string"
    ? model
    : wrapLanguageModel({
        model: model as never,
        middleware: promiseGate(promised),
      })
