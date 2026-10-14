import { type Context, createModels } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { FacadeError } from "../src/errors.ts"
import { HOST_ROUTING } from "../src/models/price.ts"
import { modelRouting, outputCaps } from "../src/spec.ts"
import {
  buildProviders,
  outboundUrl,
  selectTransport,
} from "../src/transport.ts"

const MODEL = "openrouter/deepseek/deepseek-v4.1-flash"

const gateway = {
  CF_ACCOUNT_ID: "acct",
  CF_AI_GATEWAY_ID: "gw",
  CF_AI_GATEWAY_TOKEN: "cf-token",
}

/**
 * The done-when, read as URLs: with the primary set to a transport whose
 * key is absent, startup fails naming the variable; unset with only the
 * OpenRouter key, the call dials openrouter.ai; with the CF values and the
 * primary at gateway:anthropic, the same call dials gateway.ai.cloudflare.com.
 * The URL is the model's `baseUrl`, which is what Pi dials.
 */
describe("transport selection", () => {
  it("fails at startup naming the missing variable when the primary is set", () => {
    try {
      selectTransport({ REME_MODEL_PRIMARY: "direct:anthropic" })
      throw new Error("did not throw")
    } catch (error) {
      expect(error).toBeInstanceOf(FacadeError)
      const refusal = error as FacadeError
      expect(refusal.code).toBe("transport.key_missing")
      expect(refusal.message).toContain("ANTHROPIC_API_KEY")
      expect(refusal.detail.missing).toEqual(["ANTHROPIC_API_KEY"])
    }
  })

  it("refuses a primary that is not a transport", () => {
    expect(() =>
      selectTransport({ REME_MODEL_PRIMARY: "carrier:pigeon" })
    ).toThrow(/REME_MODEL_PRIMARY is carrier:pigeon/)
  })

  it("dials openrouter.ai directly with only the OpenRouter key present", () => {
    const env = { OPENROUTER_API_KEY: "or-key" }
    const transport = selectTransport(env)
    expect(transport).toBe("direct:openrouter")
    const providers = buildProviders(env, transport)
    expect(outboundUrl(providers, MODEL)).toBe("https://openrouter.ai/api/v1")
  })

  it("dials the gateway when the CF values are present and the primary is gateway:anthropic", () => {
    const env = {
      ...gateway,
      OPENROUTER_API_KEY: "or-key",
      REME_MODEL_PRIMARY: "gateway:anthropic",
    }
    const transport = selectTransport(env)
    expect(transport).toBe("gateway:anthropic")
    const providers = buildProviders(env, transport)
    expect(outboundUrl(providers, "anthropic/claude-sonnet-4-6")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic"
    )
    // The fallback lives on OpenRouter and rides the same gateway.
    expect(outboundUrl(providers, MODEL)).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openrouter"
    )
  })

  it("takes the first transport with a key when the primary is unset, in the fixed order", () => {
    expect(selectTransport({ ...gateway, OPENROUTER_API_KEY: "k" })).toBe(
      "gateway:anthropic"
    )
    expect(
      selectTransport({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "k" })
    ).toBe("direct:anthropic")
    expect(() => selectTransport({})).toThrow(/no model transport has a key/)
  })

  it("resolves the three decided models on the openrouter provider", () => {
    const providers = buildProviders(
      { OPENROUTER_API_KEY: "k" },
      "direct:openrouter"
    )
    for (const id of [
      MODEL,
      "openrouter/z-ai/glm-5.3-flash",
      "openrouter/x-ai/grok-4.6",
    ]) {
      expect(outboundUrl(providers, id)).toBe("https://openrouter.ai/api/v1")
    }
    expect(() => outboundUrl(providers, "openrouter/nobody/nothing")).toThrow(
      /resolves to no registered model/
    )
  })

  it("hands the key to the provider as request auth, never through the environment", async () => {
    const [openrouter] = buildProviders(
      { OPENROUTER_API_KEY: "or-key" },
      "direct:openrouter"
    )
    const auth = await openrouter?.auth.apiKey?.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: new AbortController().signal,
    })
    expect(auth?.auth.apiKey).toBe("or-key")
    expect(auth?.source).toBe("worker secret")
  })
})

/**
 * A stream as OpenRouter sends it: the answer, then a usage chunk. With
 * `cost` the usage chunk carries what OpenRouter billed. The body arrives in
 * reads cut mid-line, so the tap has to join them.
 */
function openrouterStream(cost?: number) {
  const chunk = (body: object) =>
    `data: ${JSON.stringify({ id: "gen-1", model: "deepseek/deepseek-v4.1-flash", ...body })}\n\n`
  const text = [
    ": OPENROUTER PROCESSING\n\n",
    chunk({ choices: [{ index: 0, delta: { content: "ready" } }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({
      choices: [],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 100,
        ...(cost === undefined ? {} : { cost }),
      },
    }),
    "data: [DONE]\n\n",
  ].join("")
  const bytes = new TextEncoder().encode(text)
  const cuts = [0, 7, 90, 211, bytes.length - 40, bytes.length]
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 1; i < cuts.length; i++) {
        controller.enqueue(bytes.slice(cuts[i - 1], cuts[i]))
      }
      controller.close()
    },
  })
}

async function call(
  cost?: number,
  id = "deepseek/deepseek-v4.1-flash",
  context: Context = {
    messages: [{ role: "user", content: "Say ready", timestamp: 0 }],
  },
  extra: {
    caps?: Record<string, number>
    reasoning?: "low" | "medium" | "high"
  } = {}
) {
  const models = createModels()
  for (const provider of buildProviders(
    { OPENROUTER_API_KEY: "or-key" },
    "direct:openrouter",
    extra.caps
  )) {
    models.setProvider(provider)
  }
  const model = models.getModel("openrouter", id)
  if (!model) throw new Error("model did not resolve")
  const sent: Record<string, unknown>[] = []
  const headers: Headers[] = []
  // flue's loop calls the simple API, whose `reasoning` is the thinking level.
  const run = extra.reasoning ? models.completeSimple : models.complete
  const reply = await run.call(models, model, context, {
    // As flue's agent loop calls it: a session id, no cache retention.
    sessionId: "build-1",
    ...(extra.reasoning ? { reasoning: extra.reasoning } : {}),
    fetch: async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)))
      headers.push(new Headers(init?.headers))
      return new Response(openrouterStream(cost), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const listed = (1_000 * model.cost.input + 100 * model.cost.output) / 1e6
  return { reply, sent, headers, listed }
}

describe("the logged cost of an OpenRouter call", () => {
  it("is what OpenRouter billed, and the call asks for it", async () => {
    const { reply, sent, listed } = await call(0.0000321)
    expect(reply.stopReason).toBe("stop")
    expect(reply.content).toEqual([{ type: "text", text: "ready" }])
    expect(sent[0]?.usage).toEqual({ include: true })
    expect(reply.usage.cost.total).toBe(0.0000321)
    expect(reply.usage.cost.total).toBeLessThan(listed)
    const { input, output, cacheRead, cacheWrite } = reply.usage.cost
    expect(input + output + cacheRead + cacheWrite).toBeCloseTo(0.0000321, 15)
  })

  it("is the table's capped price when OpenRouter reports no cost", async () => {
    const { reply, listed } = await call()
    expect(reply.usage.cost.total).toBeCloseTo(listed, 15)
  })
})

describe("an OpenRouter call's host", () => {
  it("is asked for in the request: no ignored host, no data collection", async () => {
    const { sent } = await call()
    expect(sent[0]?.provider).toMatchObject({
      max_price: expect.any(Object),
      ignore: HOST_ROUTING.ignore,
      data_collection: "deny",
    })
  })
})

/**
 * The Developer's calls to Claude through OpenRouter's Chat Completions are
 * cached as pi-ai marks them for an `anthropic/` id: the system prompt, the
 * last tool and the last message each end a cached block, at the default
 * five-minute lifetime, which covers a build's back-to-back calls. Other
 * models get no marks: their hosts cache a repeated prefix on their own.
 */
describe("an OpenRouter call's prompt cache", () => {
  const tool = (name: string) => ({
    name,
    description: `${name} a file`,
    parameters: { type: "object", properties: {} } as never,
  })
  const context: Context = {
    systemPrompt: "You are the Developer.",
    tools: [tool("read"), tool("edit")],
    messages: [
      { role: "user", content: "Build the site", timestamp: 0 },
      {
        role: "user",
        content: [{ type: "text", text: "The facts" }],
        timestamp: 0,
      },
    ],
  }
  const ephemeral = { type: "ephemeral" }

  it("marks the system prompt, the last tool and the last message for Claude", async () => {
    const { sent, headers } = await call(
      undefined,
      "anthropic/claude-sonnet-5.5",
      context
    )
    const body = sent[0] as {
      messages: { role: string; content: unknown }[]
      tools: { cache_control?: unknown }[]
    }
    expect(body.messages[0]).toMatchObject({
      content: [{ type: "text", cache_control: ephemeral }],
    })
    expect(body.tools.map((t) => t.cache_control)).toEqual([
      undefined,
      ephemeral,
    ])
    expect(JSON.stringify(body.messages[1])).not.toContain("cache_control")
    expect(body.messages.at(-1)?.content).toEqual([
      { type: "text", text: "The facts", cache_control: ephemeral },
    ])
    // OpenRouter keeps a session on one host, so the cache written is read.
    expect(headers[0]?.get("x-session-id")).toBe("build-1")
  })

  it("marks nothing for a model whose host caches on its own", async () => {
    const { sent } = await call(undefined, undefined, context)
    expect(JSON.stringify(sent[0])).not.toContain("cache_control")
  })
})

describe("a role's effort and output cap on the wire", () => {
  const spec = modelRouting({}, "A")
  const caps = outputCaps(spec)
  const sonnet = "anthropic/claude-sonnet-5.5"
  const haiku = "anthropic/claude-haiku-5.5"

  it("sends the role's effort as reasoning.effort and no reasoning.max_tokens", async () => {
    const { sent } = await call(undefined, sonnet, undefined, {
      caps,
      reasoning: "medium",
    })
    expect(sent[0]?.reasoning).toEqual({ effort: "medium" })
  })

  it("applies the routing table's cap to a call that sets none", async () => {
    const big = await call(undefined, sonnet, undefined, { caps })
    expect(big.sent[0]?.max_completion_tokens).toBe(32_000)
    const small = await call(undefined, haiku, undefined, { caps })
    expect(small.sent[0]?.max_completion_tokens).toBe(8_000)
    const none = await call(undefined, sonnet)
    expect(none.sent[0]?.max_completion_tokens).toBeUndefined()
  })

  it("never sets provider.order on a cached model and skips hosts without structured outputs", async () => {
    const { sent } = await call(undefined, sonnet, undefined, { caps })
    const provider = sent[0]?.provider as {
      order?: unknown
      ignore: string[]
      data_collection: string
    }
    expect(provider.order).toBeUndefined()
    expect(provider.ignore).toEqual(
      expect.arrayContaining(["z-ai", "amazon-bedrock", "claude-on-aws"])
    )
    expect(provider.data_collection).toBe("deny")
  })
})
