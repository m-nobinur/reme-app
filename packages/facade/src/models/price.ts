/**
 * How `scripts/openrouter-models.mjs` turns OpenRouter's public model list
 * into a generated entry. Kept apart from the script's fetching and writing
 * so the rule can be tested without the network. Erasable TypeScript only:
 * the script imports this file straight into Node.
 */

type Rates = Record<string, string | number | undefined>
type Pricing = {
  [key: string]: string | number | undefined | Rates[]
  overrides?: Rates[]
}

/** A model as OpenRouter's `/api/v1/models` lists it: the fields read here. */
export type ListedModel = {
  id: string
  name: string
  pricing?: Pricing
  supported_parameters?: string[]
  architecture?: { input_modalities?: string[] }
  context_length: number
  top_provider?: { max_completion_tokens?: number | null }
}

/** One provider serving a model, from `/api/v1/models/{id}/endpoints`. */
export type Endpoint = {
  provider_name?: string
  /** 0 while the provider is up; negative while OpenRouter sees it degraded. */
  status?: number
  pricing?: Pricing
  context_length?: number | null
  max_completion_tokens?: number | null
}

/**
 * How far over the list price OpenRouter may route. The owner's decision of
 * 2026-09-27: availability over the cheapest single provider. OpenRouter's
 * list price is its cheapest provider's, so a cap at the list price admitted
 * one provider per model. 2.1 is the smallest factor, to one decimal, that
 * admitted three live providers for the Developer's primary model that day.
 */
export const ROUTING_CAP_FACTOR = 2.1

/** Dollars per token as OpenRouter prints them, to dollars per million. */
const perMillion = (value: unknown) =>
  Math.round(Number(value ?? 0) * 1e6 * 1e6) / 1e6

/** The highest rate a pricing block charges for `key` at any hour of any day. */
const peak = (pricing: Pricing | undefined, key: string) =>
  Math.max(
    perMillion(pricing?.[key]),
    ...(pricing?.overrides ?? []).map((o) => perMillion(o[key]))
  )

/** Dollars per million, rounded as OpenRouter's own figures are. */
const rounded = (value: number) => Math.round(value * 1e6) / 1e6

/** The smallest of the numbers given, or undefined when there are none. */
const least = (values: (number | null | undefined)[]) => {
  const known = values.filter((v): v is number => typeof v === "number")
  return known.length > 0 ? Math.min(...known) : undefined
}

/**
 * A generated entry in Pi's `Model` shape, and how many distinct live
 * providers its routing cap admits.
 *
 * OpenRouter routes under the cap, so the entry's cost is the cap: the most
 * any admitted provider can bill. The log, and the budget summed from it,
 * then never counts less than was billed (§29.2), and overstates by up to
 * the factor until a call's actual cost is logged. Cache reads are not
 * capped by routing, so theirs is the dearest admitted provider's. The
 * context and output limits are the smallest any admitted provider serves,
 * so a request fits whichever one OpenRouter picks.
 */
export function openrouterEntry(model: ListedModel, endpoints: Endpoint[]) {
  // OpenRouter's list price moves by the hour for some models, so the base
  // is the day's peak.
  const cap = {
    prompt: rounded(peak(model.pricing, "prompt") * ROUTING_CAP_FACTOR),
    completion: rounded(peak(model.pricing, "completion") * ROUTING_CAP_FACTOR),
  }
  const admitted = endpoints.filter(
    (e) =>
      peak(e.pricing, "prompt") <= cap.prompt &&
      peak(e.pricing, "completion") <= cap.completion
  )
  const cost = {
    input: cap.prompt,
    output: cap.completion,
    cacheRead: Math.max(
      0,
      ...admitted.map((e) => peak(e.pricing, "input_cache_read"))
    ),
    cacheWrite: 0,
  }
  const entry = {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    provider: "openrouter",
    reasoning: (model.supported_parameters ?? []).includes("reasoning"),
    input: (model.architecture?.input_modalities ?? ["text"]).filter(
      (mode) => mode === "text" || mode === "image"
    ),
    cost,
    contextWindow:
      least(admitted.map((e) => e.context_length)) ?? model.context_length,
    maxTokens:
      least(admitted.map((e) => e.max_completion_tokens)) ??
      model.top_provider?.max_completion_tokens ??
      0,
    compat: {
      thinkingFormat: "openrouter",
      openRouterRouting: { max_price: cap },
    },
  }
  const live = new Set(
    admitted.filter((e) => e.status === 0).map((e) => e.provider_name)
  )
  return { entry, live: live.size }
}
