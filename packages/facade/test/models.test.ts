import { describe, expect, it } from "vitest"
import { OPENROUTER_IDS, openrouterModels } from "../src/models/index.ts"

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
      expect(model?.contextWindow).toBeGreaterThan(100_000)
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
