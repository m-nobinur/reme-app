import { calculateCost, type Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
  type Endpoint,
  HOST_ROUTING,
  type ListedModel,
  openrouterEntry,
  ROUTING_CAP_FACTOR,
  shortOfProviders,
} from "../src/models/price.ts"

// The generator's rule, without the network: a listed model and its
// providers, in OpenRouter's own units (dollars per token, as strings).
const perToken = (perMillion: number) => String(perMillion / 1e6)
const rates = (input: number, output: number, cacheRead: number) => ({
  prompt: perToken(input),
  completion: perToken(output),
  input_cache_read: perToken(cacheRead),
})
const provider = (
  name: string,
  pricing: Endpoint["pricing"],
  extra: Partial<Endpoint> = {}
): Endpoint => ({
  provider_name: name,
  status: 0,
  pricing,
  context_length: 400_000,
  max_completion_tokens: 200_000,
  ...extra,
})

describe("a generated OpenRouter entry", () => {
  // A list price of 0.1 in and 0.4 out, so the cap is 0.21 and 0.84.
  const listed: ListedModel = {
    id: "probe/model",
    name: "Probe model",
    pricing: rates(0.1, 0.4, 0.01),
    context_length: 400_000,
    top_provider: { max_completion_tokens: 200_000 },
  }
  const providers: Endpoint[] = [
    // The cheapest, which sets the list price.
    provider("Cheap", rates(0.1, 0.4, 0.001)),
    // Twice the list price: in only if the factor is at least 2.
    provider("Double", rates(0.2, 0.8, 0.05), {
      max_completion_tokens: 64_000,
    }),
    // The same provider on a second endpoint: one provider, not two.
    provider("Double", rates(0.12, 0.5, 0.01)),
    // Over the cap at its peak and under it off-peak, which is when
    // OpenRouter can route to it, so it counts; its cache read is dearest.
    provider(
      "Offpeak",
      {
        ...rates(0.3, 1.2, 0.02),
        overrides: [{ utc_start: 0, utc_end: 600, ...rates(0.15, 0.6, 0.06) }],
      },
      { context_length: 250_000 }
    ),
    // Under the cap but degraded: admitted, not counted as live.
    provider("Down", rates(0.1, 0.4, 0.01), { status: -2 }),
    // Over the cap at every hour, so routing never reaches it.
    provider("Dear", rates(0.3, 0.9, 0.2), { context_length: 100_000 }),
  ]

  it("routes under 2.1 times the list price", () => {
    expect(ROUTING_CAP_FACTOR).toBe(2.1)
    expect(
      openrouterEntry(listed, providers).entry.compat.openRouterRouting
        .max_price
    ).toEqual({ prompt: 0.21, completion: 0.84 })
  })

  it("costs every call at the most an admitted provider can bill", () => {
    expect(openrouterEntry(listed, providers).entry.cost).toEqual({
      input: 0.21,
      output: 0.84,
      cacheRead: 0.06,
      cacheWrite: 0,
    })
  })

  it("promises only the window and output every admitted provider serves", () => {
    const { entry } = openrouterEntry(listed, providers)
    expect(entry.contextWindow).toBe(250_000)
    expect(entry.maxTokens).toBe(64_000)
  })

  it("counts distinct live providers under the cap", () => {
    expect(openrouterEntry(listed, providers).live).toBe(3)
  })

  it("routes off the ignored hosts and never counts or prices them", () => {
    const { entry, live } = openrouterEntry(listed, [
      ...providers,
      provider("DeepSeek", rates(0.1, 0.4, 0.5), {
        tag: "deepseek",
        context_length: 1_000,
      }),
      provider("StreamLake", rates(0.1, 0.4, 0.5), { tag: "streamlake/fp8" }),
    ])
    expect(entry.compat.openRouterRouting).toEqual({
      max_price: { prompt: 0.21, completion: 0.84 },
      ignore: HOST_ROUTING.ignore,
      data_collection: "deny",
    })
    expect(live).toBe(3)
    expect(entry.cost.cacheRead).toBe(0.06)
    expect(entry.contextWindow).toBe(250_000)
  })

  it("takes the day's peak where the list price moves by the hour", () => {
    const hourly: ListedModel = {
      ...listed,
      pricing: {
        ...rates(0.1, 0.4, 0.01),
        overrides: [{ utc_start: 100, utc_end: 400, ...rates(0.2, 0.8, 0.02) }],
      },
    }
    expect(openrouterEntry(hourly, []).entry.cost).toMatchObject({
      input: 0.42,
      output: 1.68,
    })
  })

  // Grok's listing as OpenRouter gave it on 2026-09-27: a long-context tier
  // over 200,000 prompt tokens at twice the base, which is not an hour.
  it("bases the cap on the list price, not a long-context tier", () => {
    const tier = (input: number, output: number, cacheRead: number) => ({
      ...rates(input, output, cacheRead),
      overrides: [
        {
          min_prompt_tokens: 200_000,
          ...rates(input * 2, output * 2, cacheRead * 2),
        },
      ],
    })
    const grok: ListedModel = {
      id: "x-ai/grok-4.6",
      name: "xAI: Grok 4.6",
      pricing: tier(2, 6, 0.5),
      context_length: 500_000,
    }
    const { entry, live } = openrouterEntry(grok, [
      provider("xAI", tier(2, 6, 0.5), { context_length: 500_000 }),
      provider("Amazon Bedrock", tier(2.2, 6.6, 0.55), {
        context_length: 500_000,
      }),
      provider("xAI", tier(4, 12, 1), { context_length: 500_000 }),
    ])
    expect(entry.compat.openRouterRouting.max_price).toEqual({
      prompt: 4.2,
      completion: 12.6,
    })
    // Over the tier's threshold the log prices at 2.1 times the tier, which
    // pi-ai's `calculateCost` applies to the whole request. From 200,000
    // tokens, since the tier starts there and pi-ai tests "above".
    expect(entry.cost).toEqual({
      input: 4.2,
      output: 12.6,
      cacheRead: 2,
      cacheWrite: 0,
      tiers: [
        {
          inputTokensAbove: 199_999,
          input: 8.4,
          output: 25.2,
          cacheRead: 2.1,
          cacheWrite: 0,
        },
      ],
    })
    expect(live).toBe(2)
    // pi-ai reads the tier: 250,000 input tokens cost 8.4 per million.
    const usage = {
      input: 250_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 250_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    calculateCost(entry as unknown as Model<"openai-completions">, usage)
    expect(usage.cost.input).toBeCloseTo(2.1, 10)
  })
})

describe("the generator's floor on providers", () => {
  it("fails the primary model with fewer than three live providers", () => {
    expect(
      shortOfProviders([
        { id: "deepseek/deepseek-v4.1-flash", live: 2 },
        { id: "z-ai/glm-5.3-flash", live: 1 },
      ])
    ).toEqual(["deepseek/deepseek-v4.1-flash has 2 live providers, needs 3"])
    expect(
      shortOfProviders([{ id: "deepseek/deepseek-v4.1-flash", live: 3 }])
    ).toEqual([])
  })
})
