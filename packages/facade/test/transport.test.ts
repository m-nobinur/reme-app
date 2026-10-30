import {
  type Context,
  createInitialSystemMessage,
  createModels,
  type Message,
} from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { registeredCap, withOutputCap } from "../src/caps.ts"
import { FacadeError } from "../src/errors.ts"
import { HOST_ROUTING } from "../src/models/price.ts"
import { modelRouting, outputCaps } from "../src/spec.ts"
import {
  buildProviders,
  compactionAt,
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

  it("gives a subagent its own role's cap, found by the instructions its system prompt starts with", async () => {
    // The leading system message flue's agent loop seeds from its prompt.
    const asked = (systemPrompt: string): Context => ({
      messages: [
        createInitialSystemMessage(systemPrompt, []) as Message,
        { role: "user", content: "Go", timestamp: 0 },
      ],
    })
    // As the agent registers them, and as flue composes the prompt: the
    // instructions first, then the catalog of agents and the date.
    const lead = withOutputCap("You lead the build of a site.", 32_000)
    const page = withOutputCap("You build one page.", 16_000)
    const copyWriter = withOutputCap("You write the site's copy.", 8_000)
    const extras = "\n\n## Available Agents\n\n- **page**\n\nDate: Wed, Oct 14"
    const cap = async (id: string, prompt: string) =>
      (await call(undefined, id, asked(prompt + extras), { caps })).sent[0]
        ?.max_completion_tokens

    // Both Sonnet: the table's per-model cap is 32k, so only the prompt says 16k.
    expect(caps[sonnet]).toBe(32_000)
    expect(await cap(sonnet, lead)).toBe(32_000)
    expect(await cap(sonnet, page)).toBe(16_000)
    expect(await cap(haiku, copyWriter)).toBe(8_000)
    // A prompt nobody registered keeps the model's cap, and an explicit one wins.
    expect(await cap(sonnet, "Some other agent.")).toBe(32_000)
  })

  it("takes the longest registered prompt a call's starts with, and forgets the oldest past sixteen", async () => {
    const messages = (prompt: string) =>
      [{ role: "system", content: prompt }] as Message[]
    withOutputCap("Shared start.", 1_000)
    withOutputCap("Shared start. And more of it.", 2_000)
    expect(registeredCap(messages("Shared start. And more of it. Plus"))).toBe(
      2_000
    )
    expect(registeredCap(messages("Shared start. Different."))).toBe(1_000)
    expect(registeredCap([{ role: "user", content: "x", timestamp: 0 }])).toBe(
      undefined
    )
    for (let i = 0; i < 16; i++) withOutputCap(`Filler ${i}.`, 5)
    expect(registeredCap(messages("Shared start."))).toBeUndefined()
    expect(registeredCap(messages("Filler 15."))).toBe(5)
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

describe("compaction at the spec's threshold", () => {
  const providers = buildProviders(
    { OPENROUTER_API_KEY: "or-key" },
    "direct:openrouter"
  )

  it("reserves the model's window less the threshold, so flue compacts there", () => {
    expect(compactionAt(providers, MODEL, 150_000)).toEqual({
      reserveTokens: 1_048_576 - 150_000,
    })
  })

  it("leaves flue's default for a model it cannot find or a window the threshold reaches", () => {
    expect(compactionAt(providers, "openrouter/none/such", 150_000)).toBe(
      undefined
    )
    expect(compactionAt(providers, MODEL, 2_000_000)).toBe(undefined)
  })
})
