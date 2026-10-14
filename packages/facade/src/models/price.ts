/**
 * How `scripts/openrouter-models.mjs` turns OpenRouter's public model list
 * into a generated entry. Kept apart from the script's fetching and writing
 * so the rule can be tested without the network. Erasable TypeScript only:
 * the script imports this file straight into Node.
 */

type Rates = { [key: string]: unknown }
type Pricing = Rates & {
  /**
   * Hourly prices (`utc_start`, `utc_end`, `utc_days`) and long-context tiers
   * (`min_prompt_tokens`), each replacing the base rates while it applies.
   */
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
  /** The provider's slug, then `/` and a variant when it runs more than one. */
  tag?: string
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

/**
 * What every OpenRouter request asks of its host, as `provider` preferences:
 * skip hosts based in China, and use only hosts that neither train on nor
 * keep prompts. Slugs from `/api/v1/providers` on 2026-09-30, which lists
 * deepseek, tencent, baidu, nex-agi, xiaomi and streamlake in CN; the rest
 * are listed in SG or with no headquarters, and their parents are in China.
 */
export const HOST_ROUTING = {
  ignore: [
    "alibaba",
    "baidu",
    "deepseek",
    "minimax",
    "moonshotai",
    "nex-agi",
    "seed",
    "siliconflow",
    "stepfun",
    "streamlake",
    "tencent",
    "xiaomi",
    "z-ai",
  ],
  data_collection: "deny" as const,
}

/**
 * Hosts a model's calls skip because they lack `structured_outputs` for it
 * (OpenRouter's endpoint list, 2026-10-14): the Claude hosts that are not
 * Anthropic, Vertex or Azure. Goes in `ignore`, never `order`, which would
 * turn off the sticky routing the prompt cache depends on.
 */
export const NO_STRUCTURED_OUTPUTS: Record<string, readonly string[]> = {
  "anthropic/claude-sonnet-5.5": ["amazon-bedrock", "claude-on-aws"],
  "anthropic/claude-haiku-5.5": ["amazon-bedrock", "claude-on-aws"],
}

/**
 * The fewest live providers a model's cap must admit, or the generator stops.
 * The primary model's third provider cleared the cap by 1.5% on 2026-09-27,
 * so a small price move can take it back to one.
 */
const MIN_LIVE_PROVIDERS: Record<string, number> = {
  "deepseek/deepseek-v4.1-flash": 3,
  "anthropic/claude-sonnet-5.5": 3,
  "anthropic/claude-haiku-5.5": 3,
}

/** Dollars per million, rounded as OpenRouter's own figures are. */
const rounded = (value: number) => Math.round(value * 1e6) / 1e6

/** Dollars per token as OpenRouter prints them, to dollars per million. */
const perMillion = (value: unknown) => rounded(Number(value ?? 0) * 1e6)

/** The base rates and the hourly ones; a long-context tier is not an hour. */
const hours = (pricing: Pricing | undefined): Rates[] => [
  pricing ?? {},
  ...(pricing?.overrides ?? []).filter(
    (o) => o.min_prompt_tokens === undefined
  ),
]

/** Every block of rates, long-context tiers included. */
const blocks = (pricing: Pricing | undefined): Rates[] => [
  pricing ?? {},
  ...(pricing?.overrides ?? []),
]

const rate = (key: string) => (r: Rates) => perMillion(r[key])

/**
 * pi-ai's cost tiers for a model's long-context overrides, each at the factor
 * times the tier's rates, so a long request OpenRouter reports no cost for is
 * priced at the most it can be billed as well. pi-ai applies a tier to
 * requests whose input is above `inputTokensAbove`; an override applies from
 * `min_prompt_tokens`, so the threshold is one under it.
 */
const longContextTiers = (pricing: Pricing | undefined) => {
  const overrides = (pricing?.overrides ?? []).filter(
    (o) => typeof o.min_prompt_tokens === "number"
  )
  const thresholds = [
    ...new Set(overrides.map((o) => o.min_prompt_tokens as number)),
  ].sort((a, b) => a - b)
  return thresholds.map((from) => {
    const at = overrides.filter((o) => o.min_prompt_tokens === from)
    const capped = (key: string) =>
      rounded(Math.max(...at.map(rate(key))) * ROUTING_CAP_FACTOR)
    return {
      inputTokensAbove: from - 1,
      input: capped("prompt"),
      output: capped("completion"),
      cacheRead: capped("input_cache_read"),
      cacheWrite: capped("input_cache_write"),
    }
  })
}

/**
 * A generated entry in Pi's `Model` shape, and how many distinct live
 * providers its routing cap admits.
 *
 * The cap is the factor times the list price, the day's hourly peak without
 * long-context tiers. OpenRouter compares a provider against it when a
 * request is made, so a provider under it at any hour can serve a call, and
 * the entry's cost is the cap: the most such a call can bill. A call is
 * logged at what OpenRouter billed (`billed` in `transport.ts`); the cap
 * prices only a call OpenRouter reports no cost for, and the CoS's
 * reservations, so both err high rather than low (§29.2).
 * Cache reads and writes are not capped by routing, so theirs are the
 * dearest any admitted provider charges; pi-ai takes written tokens out of
 * the input and prices them at `cacheWrite`, so a zero there would price an
 * Anthropic call's prompt under what it bills. The context and output limits are the smallest
 * any admitted provider serves, so a request fits whichever one is picked.
 */
export function openrouterEntry(model: ListedModel, endpoints: Endpoint[]) {
  const listed = hours(model.pricing)
  const cap = {
    prompt: rounded(
      Math.max(...listed.map(rate("prompt"))) * ROUTING_CAP_FACTOR
    ),
    completion: rounded(
      Math.max(...listed.map(rate("completion"))) * ROUTING_CAP_FACTOR
    ),
  }
  const ignore = [
    ...HOST_ROUTING.ignore,
    ...(NO_STRUCTURED_OUTPUTS[model.id] ?? []),
  ]
  const admitted = endpoints.filter(
    (e) =>
      !ignore.includes(e.tag?.split("/")[0] ?? "") &&
      hours(e.pricing).some(
        (r) =>
          rate("prompt")(r) <= cap.prompt &&
          rate("completion")(r) <= cap.completion
      )
  )
  const tiers = longContextTiers(model.pricing)
  const least = (values: (number | null | undefined)[]) => {
    const known = values.filter((v): v is number => typeof v === "number")
    return known.length > 0 ? Math.min(...known) : undefined
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
    cost: {
      input: cap.prompt,
      output: cap.completion,
      cacheRead: Math.max(
        0,
        ...admitted.flatMap((e) =>
          blocks(e.pricing).map(rate("input_cache_read"))
        )
      ),
      cacheWrite: Math.max(
        0,
        ...admitted.flatMap((e) =>
          blocks(e.pricing).map(rate("input_cache_write"))
        )
      ),
      ...(tiers.length > 0 ? { tiers } : {}),
    },
    contextWindow:
      least(admitted.map((e) => e.context_length)) ?? model.context_length,
    maxTokens:
      least(admitted.map((e) => e.max_completion_tokens)) ??
      model.top_provider?.max_completion_tokens ??
      0,
    compat: {
      thinkingFormat: "openrouter",
      openRouterRouting: {
        max_price: cap,
        ...HOST_ROUTING,
        ignore,
      },
    },
  }
  const live = new Set(
    admitted.filter((e) => e.status === 0).map((e) => e.provider_name)
  )
  return { entry, live: live.size }
}

/** One line per model whose cap admits fewer live providers than it needs. */
export function shortOfProviders(results: { id: string; live: number }[]) {
  return results.flatMap(({ id, live }) => {
    const needs = MIN_LIVE_PROVIDERS[id]
    return needs !== undefined && live < needs
      ? [`${id} has ${live} live providers, needs ${needs}`]
      : []
  })
}
