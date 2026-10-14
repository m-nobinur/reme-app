import { describe, expect, it } from "vitest"
import { OPENROUTER_IDS, openrouterModels } from "../src/models/index.ts"
import { HOST_ROUTING } from "../src/models/price.ts"

/**
 * The generated file is what makes a model Pi's catalog lacks resolve, and
 * the fail-fast is what makes a stale or missing file a named error rather
 * than an unknown-model throw at the first call.
 */
describe("the generated OpenRouter models", () => {
  it("cover every id in the list, with today's prices", () => {
    const models = openrouterModels()
    for (const id of OPENROUTER_IDS) {
      const model = models.find((m) => m.id === id)
      expect(model, id).toBeDefined()
      expect(model?.provider).toBe("openrouter")
      expect(model?.api).toBe("openai-completions")
      expect(model?.cost.input).toBeGreaterThan(0)
      expect(model?.contextWindow).toBeGreaterThan(50_000)
    }
  })

  it("route only to providers at or under the rate the log charges", () => {
    for (const id of OPENROUTER_IDS) {
      const model = openrouterModels().find((m) => m.id === id)
      // A model the catalog has no price for would ceil at zero, which no
      // provider is under, so the model would simply stop answering. The
      // generator returns 0 for a missing pricing block, so this is the
      // assertion that a regenerated catalog has to get past.
      expect(model?.cost.input, id).toBeGreaterThan(0)
      expect(model?.cost.output, id).toBeGreaterThan(0)
      expect(model?.compat, id).toMatchObject({
        openRouterRouting: {
          max_price: {
            prompt: model?.cost.input,
            completion: model?.cost.output,
          },
        },
      })
    }
  })

  it("keep every model, the catalog's too, off China-based hosts and hosts that keep prompts", () => {
    for (const model of openrouterModels()) {
      const routing = model.compat?.openRouterRouting
      expect(routing?.ignore, model.id).toEqual(
        expect.arrayContaining(HOST_ROUTING.ignore)
      )
      expect(routing?.data_collection, model.id).toBe("deny")
    }
    for (const slug of ["deepseek", "alibaba", "streamlake", "z-ai"]) {
      expect(HOST_ROUTING.ignore).toContain(slug)
    }
  })

  it("skip the Claude hosts without structured outputs, on the roles that need them", () => {
    for (const id of [
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-haiku-5.5",
    ]) {
      const model = openrouterModels().find((m) => m.id === id)
      expect(model?.compat?.openRouterRouting?.ignore, id).toEqual(
        expect.arrayContaining(["amazon-bedrock", "claude-on-aws"])
      )
    }
  })

  it("throw naming the declared ids when the generated entries are gone", () => {
    expect(() => openrouterModels([])).toThrow(
      /deepseek\/deepseek-v4.1-flash, x-ai\/grok-4.6, z-ai\/glm-5.3-flash/
    )
  })

  it("layer over the catalog rather than replacing it", () => {
    const models = openrouterModels()
    expect(models.length).toBeGreaterThan(OPENROUTER_IDS.length)
  })
})
