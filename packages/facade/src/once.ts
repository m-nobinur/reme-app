import { createModels, type Usage } from "@earendil-works/pi-ai"
import { FacadeError } from "./errors.ts"
import type { Effort } from "./spec.ts"
import { buildProviders, type ModelEnv, selectTransport } from "./transport.ts"

/**
 * One model call outside a flue session (the quick edit lane), on the
 * providers flue uses, so the transport, the billed-cost tap and the
 * routing table's model ids are the same. `system` is the stable prefix and
 * is cached for an hour, because an owner's edits come minutes apart.
 * `schema` asks OpenRouter for structured output; a provider that ignores it
 * still gets the prompt's own instruction, so the caller parses either way.
 */
export async function completeOnce(
  env: ModelEnv,
  call: {
    /** A routing-table id such as `openrouter/anthropic/claude-haiku-5.5`. */
    model: string
    effort: Effort
    maxTokens: number
    system: string
    user: string
    /** Pictures the model reads with `user`, base64 (the design critic's screenshots). */
    images?: { data: string; mimeType: string }[]
    /** Pins one provider for the cache, per assignment. */
    sessionId: string
    schema?: { name: string; schema: Record<string, unknown> }
  }
): Promise<{ text: string; usage: Usage; model: string }> {
  const models = createModels()
  for (const provider of buildProviders(env, selectTransport(env))) {
    models.setProvider(provider)
  }
  const at = call.model.indexOf("/")
  const model = models.getModel(
    call.model.slice(0, at),
    call.model.slice(at + 1)
  )
  if (!model) {
    throw new FacadeError(
      "model.unresolved",
      "validation",
      `${call.model} resolves to no registered model`,
      { specifier: call.model }
    )
  }
  const message = await models.completeSimple(
    model,
    {
      systemPrompt: call.system,
      messages: [
        {
          role: "user",
          content: call.images?.length
            ? [
                ...call.images.map((i) => ({ type: "image" as const, ...i })),
                { type: "text" as const, text: call.user },
              ]
            : call.user,
          timestamp: Date.now(),
        },
      ],
    },
    {
      reasoning: call.effort,
      maxTokens: call.maxTokens,
      cacheRetention: "long",
      sessionId: call.sessionId,
      ...(call.schema
        ? {
            samplingParams: {
              response_format: {
                type: "json_schema",
                json_schema: { ...call.schema, strict: true },
              },
            },
          }
        : {}),
    }
  )
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new FacadeError(
      "model.failed",
      "transient",
      message.errorMessage ?? `the ${call.model} call ended in an error`,
      { model: call.model }
    )
  }
  const text = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
  return { text, usage: message.usage, model: call.model }
}
