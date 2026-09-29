import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelAuth,
  Provider,
  ProviderStreams,
  StreamOptions,
} from "@earendil-works/pi-ai"
import {
  createAssistantMessageEventStream,
  createProvider,
} from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { setProvider } from "@flue/runtime"
import { FacadeError } from "./errors.ts"
import { openrouterModels } from "./models/index.ts"

/**
 * §29.1: the routing table in the spec picks the model, this picks how the
 * call travels. `REME_MODEL_PRIMARY` names a transport and fails loudly
 * when its key is missing; unset, the first of these with a key present
 * wins, in this order.
 */
export const TRANSPORTS = [
  "gateway:anthropic",
  "gateway:openrouter",
  "direct:anthropic",
  "direct:openrouter",
] as const

export type Transport = (typeof TRANSPORTS)[number]

/** The variables the facade reads. Everything else stays where it is. */
export type ModelEnv = {
  REME_MODEL_PRIMARY?: string
  OPENROUTER_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  CF_ACCOUNT_ID?: string
  CF_AI_GATEWAY_ID?: string
  CF_AI_GATEWAY_TOKEN?: string
}

const GATEWAY = [
  "CF_ACCOUNT_ID",
  "CF_AI_GATEWAY_ID",
  "CF_AI_GATEWAY_TOKEN",
] as const

/** What each transport needs before it can carry a call. */
export const REQUIRED: Record<Transport, readonly (keyof ModelEnv)[]> = {
  "gateway:anthropic": GATEWAY,
  "gateway:openrouter": [...GATEWAY, "OPENROUTER_API_KEY"],
  "direct:anthropic": ["ANTHROPIC_API_KEY"],
  "direct:openrouter": ["OPENROUTER_API_KEY"],
}

const present = (env: ModelEnv, name: keyof ModelEnv) =>
  typeof env[name] === "string" && env[name].trim() !== ""

const missing = (env: ModelEnv, transport: Transport) =>
  REQUIRED[transport].filter((name) => !present(env, name))

/**
 * The transport for this process. Primary wins and must be complete; with no
 * primary, the first complete one in `TRANSPORTS` order. Both refusals name
 * the variable, because "no model" without a name is a day lost.
 */
export function selectTransport(env: ModelEnv): Transport {
  const primary = env.REME_MODEL_PRIMARY?.trim()
  if (primary) {
    if (!(TRANSPORTS as readonly string[]).includes(primary)) {
      throw new FacadeError(
        "transport.unknown",
        "validation",
        `REME_MODEL_PRIMARY is ${primary}; it must be one of ${TRANSPORTS.join(", ")}`,
        { REME_MODEL_PRIMARY: primary }
      )
    }
    const transport = primary as Transport
    const absent = missing(env, transport)
    if (absent.length > 0) {
      throw new FacadeError(
        "transport.key_missing",
        "resource",
        `REME_MODEL_PRIMARY is ${transport} but ${absent.join(", ")} is not set`,
        { REME_MODEL_PRIMARY: transport, missing: absent }
      )
    }
    return transport
  }
  const first = TRANSPORTS.find((t) => missing(env, t).length === 0)
  if (!first) {
    throw new FacadeError(
      "transport.none",
      "resource",
      "no model transport has a key: set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or the CF_* values",
      {}
    )
  }
  return first
}

const gatewayBase = (env: ModelEnv, vendor: "anthropic" | "openrouter") =>
  `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/${vendor}`

const withBase = <TApi extends Api>(
  models: readonly Model<TApi>[],
  baseUrl: string
): Model<TApi>[] => models.map((model) => ({ ...model, baseUrl }))

/** A fixed-credential resolver: the key comes from the Worker's bindings, never from a file or a prompt. */
const fixed = (name: string, auth: () => ModelAuth) => ({
  apiKey: {
    name,
    resolve: async () => ({ auth: auth(), source: "worker secret" }),
  },
})

/**
 * Calls `record` with the `id` and `usage.cost` of each server-sent event in
 * `body` that carries a cost, and passes every byte through unchanged. A
 * line split across reads is joined first; `[DONE]` and anything that is
 * not JSON are skipped.
 */
export function tapCost(
  body: ReadableStream<Uint8Array>,
  record: (id: unknown, cost: number) => void
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let rest = ""
  const scan = (line: string) => {
    const data = line.startsWith("data:") ? line.slice(5).trim() : ""
    // Only the usage chunk carries a cost; a line without one is not parsed.
    if (!data.includes('"cost"')) return
    try {
      const chunk = JSON.parse(data) as {
        id?: unknown
        usage?: { cost?: unknown }
      }
      const cost = chunk.usage?.cost
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        record(chunk.id, cost)
      }
    } catch {
      // Not JSON: not a chunk, so not a cost.
    }
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        controller.enqueue(bytes)
        const lines = (rest + decoder.decode(bytes, { stream: true })).split(
          "\n"
        )
        rest = lines.pop() ?? ""
        for (const line of lines) scan(line)
      },
      flush() {
        scan(rest + decoder.decode())
      },
    })
  )
}

/**
 * pi-ai prices every OpenRouter call from the table, at the routing cap, and
 * drops the `usage.cost` OpenRouter bills on the stream's last chunk. This
 * wraps the API so each call asks for that cost, reads it off the response
 * body, and writes it into the finished message's `usage.cost` before the
 * message leaves the stream, so flue's `turn`, the event log and the budget
 * all see what was billed. The per-part figures are scaled to the same
 * total, since OpenRouter reports only the total; a sum over parts then
 * still matches. A call with no reported cost keeps the table's figure,
 * which errs high. Behind the AI Gateway the body passes through unchanged,
 * so the same tap reads it.
 */
export function billed(api: ProviderStreams): ProviderStreams {
  const wrap =
    <O extends StreamOptions>(
      call: (
        model: Model<Api>,
        context: Context,
        options?: O
      ) => AssistantMessageEventStream
    ) =>
    (model: Model<Api>, context: Context, options?: O) => {
      let bill: { id: unknown; cost: number } | undefined
      const inner = call(model, context, {
        ...(options as O),
        onPayload: async (params, at) => {
          const next = (await options?.onPayload?.(params, at)) ?? params
          return { ...(next as object), usage: { include: true } }
        },
        fetch: async (input, init) => {
          const response = await (options?.fetch
            ? options.fetch(input, init)
            : fetch(input, init))
          const sse = response.headers
            .get("content-type")
            ?.includes("text/event-stream")
          if (!response.ok || !response.body || !sse) return response
          return new Response(
            tapCost(response.body, (id, cost) => {
              bill = { id, cost }
            }),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }
          )
        },
      })
      const outer = createAssistantMessageEventStream()
      void (async () => {
        for await (const event of inner) {
          const paid = bill
          if (
            event.type === "done" &&
            paid &&
            paid.id === event.message.responseId
          ) {
            const cost = event.message.usage.cost
            const scale = cost.total > 0 ? paid.cost / cost.total : 0
            cost.input *= scale
            cost.output *= scale
            cost.cacheRead *= scale
            cost.cacheWrite *= scale
            cost.total = paid.cost
          }
          outer.push(event)
        }
        outer.end(await inner.result())
      })()
      return outer
    }
  return { stream: wrap(api.stream), streamSimple: wrap(api.streamSimple) }
}

/**
 * The providers to register for a transport. OpenRouter is registered
 * whenever its key is present, because the fallback model lives there;
 * Anthropic whenever a path to it exists. Returned as well as registered, so
 * a test can read the URL a call would dial without dialling it.
 */
export function buildProviders(
  env: ModelEnv,
  transport: Transport
): Provider[] {
  const providers: Provider[] = []
  const viaGateway = transport.startsWith("gateway:")
  const gatewayHeaders = () => ({
    "cf-aig-authorization": `Bearer ${env.CF_AI_GATEWAY_TOKEN}`,
  })

  if (present(env, "OPENROUTER_API_KEY")) {
    const direct = "https://openrouter.ai/api/v1"
    const gateway =
      viaGateway && missing(env, "gateway:openrouter").length === 0
    const baseUrl = gateway ? gatewayBase(env, "openrouter") : direct
    providers.push(
      createProvider({
        id: "openrouter",
        name: "OpenRouter",
        baseUrl,
        auth: fixed("OpenRouter API key", () => ({
          apiKey: env.OPENROUTER_API_KEY,
          ...(gateway ? { headers: gatewayHeaders() } : {}),
        })),
        models: withBase(openrouterModels(), baseUrl),
        api: billed(openAICompletionsApi()),
      })
    )
  }

  if (transport === "gateway:anthropic") {
    // BYOK: the Anthropic key is stored on the gateway, the gateway token
    // authenticates the caller. Not exercised until the gateway exists; the
    // shape follows Cloudflare's provider docs and the test reads the URL.
    const baseUrl = gatewayBase(env, "anthropic")
    providers.push(
      createProvider({
        id: "anthropic",
        name: "Anthropic via AI Gateway",
        baseUrl,
        auth: fixed("AI Gateway token", () => ({
          apiKey: env.CF_AI_GATEWAY_TOKEN,
          headers: gatewayHeaders(),
        })),
        models: withBase(anthropicProvider().getModels(), baseUrl),
        api: anthropicMessagesApi(),
      })
    )
  } else if (present(env, "ANTHROPIC_API_KEY")) {
    const base = anthropicProvider()
    providers.push(
      createProvider({
        id: "anthropic",
        name: "Anthropic",
        baseUrl: base.baseUrl,
        auth: fixed("Anthropic API key", () => ({
          apiKey: env.ANTHROPIC_API_KEY,
        })),
        models: base.getModels(),
        api: anthropicMessagesApi(),
      })
    )
  }
  return providers
}

/**
 * Select the transport and register its providers with flue, once, at
 * module scope. Throws before any model call when the configuration cannot
 * carry one.
 */
export function registerProviders(env: ModelEnv): {
  transport: Transport
  providers: Provider[]
} {
  const transport = selectTransport(env)
  const providers = buildProviders(env, transport)
  for (const provider of providers) setProvider(provider)
  return { transport, providers }
}

/** The host a `provider/model` specifier would dial under these providers. */
export function outboundUrl(
  providers: readonly Provider[],
  specifier: string
): string {
  const at = specifier.indexOf("/")
  const providerId = specifier.slice(0, at)
  const modelId = specifier.slice(at + 1)
  const provider = providers.find((p) => p.id === providerId)
  const model = provider?.getModels().find((m) => m.id === modelId)
  if (!model) {
    throw new FacadeError(
      "model.unresolved",
      "validation",
      `${specifier} resolves to no registered model; registered providers: ${providers.map((p) => p.id).join(", ") || "none"}`,
      { specifier }
    )
  }
  return model.baseUrl
}
