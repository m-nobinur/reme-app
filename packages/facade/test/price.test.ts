import { describe, expect, it } from "vitest"
import {
  type Endpoint,
  type ListedModel,
  openrouterEntry,
  ROUTING_CAP_FACTOR,
} from "../src/models/price.ts"

// The generator's rule, without the network: a listed model and its
// providers, in OpenRouter's own units (dollars per token, as strings).
const perToken = (perMillion: number) => String(perMillion / 1e6)
const rates = (input: number, output: number, cacheRead: number) => ({
  prompt: perToken(input),
  completion: perToken(output),
  input_cache_read: perToken(cacheRead),
})
const listed: ListedModel = {
  id: "probe/model",
  name: "Probe model",
  pricing: rates(0.1, 0.4, 0.01),
  context_length: 400_000,
  top_provider: { max_completion_tokens: 200_000 },
}
const cap = {
  input: Math.round(0.1 * ROUTING_CAP_FACTOR * 1e6) / 1e6,
  output: Math.round(0.4 * ROUTING_CAP_FACTOR * 1e6) / 1e6,
}
const provider = (
  name: string,
  pricing: ReturnType<typeof rates>,
  extra: Partial<Endpoint> = {}
): Endpoint => ({
  provider_name: name,
  status: 0,
  pricing,
  context_length: 400_000,
  max_completion_tokens: 200_000,
  ...extra,
})
const providers: Endpoint[] = [
  // The cheapest, which sets the list price.
  provider("Cheap", rates(0.1, 0.4, 0.001)),
  // Dearer and under the cap, with a dear cache read and a smaller window.
  provider("Middle", rates(cap.input, cap.output, 0.05), {
    context_length: 300_000,
    max_completion_tokens: 64_000,
  }),
  // The same provider on a second endpoint: one provider, not two.
  provider("Middle", rates(0.12, 0.5, 0.01)),
  // Under the cap but degraded: admitted, not counted as live.
  provider("Down", rates(0.1, 0.4, 0.01), { status: -2 }),
  // Over the cap on output, so routing never reaches it.
  provider("Dear", rates(0.15, cap.output + 0.01, 0.2), {
    context_length: 100_000,
  }),
]

describe("a generated OpenRouter entry", () => {
  it("costs every call at the most an admitted provider can bill", () => {
    const { entry } = openrouterEntry(listed, providers)
    expect(entry.compat.openRouterRouting.max_price).toEqual({
      prompt: cap.input,
      completion: cap.output,
    })
    expect(entry.cost).toEqual({
      input: cap.input,
      output: cap.output,
      cacheRead: 0.05,
      cacheWrite: 0,
    })
  })

  it("promises only the window and output every admitted provider serves", () => {
    const { entry } = openrouterEntry(listed, providers)
    expect(entry.contextWindow).toBe(300_000)
    expect(entry.maxTokens).toBe(64_000)
  })

  it("counts distinct live providers under the cap", () => {
    expect(openrouterEntry(listed, providers).live).toBe(2)
  })

  it("caps at the factor times the day's peak where the price moves by the hour", () => {
    const hourly: ListedModel = {
      ...listed,
      pricing: { ...rates(0.1, 0.4, 0.01), overrides: [rates(0.2, 0.8, 0.02)] },
    }
    expect(openrouterEntry(hourly, []).entry.cost).toMatchObject({
      input: Math.round(0.2 * ROUTING_CAP_FACTOR * 1e6) / 1e6,
      output: Math.round(0.8 * ROUTING_CAP_FACTOR * 1e6) / 1e6,
    })
  })
})
