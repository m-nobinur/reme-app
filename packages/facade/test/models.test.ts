import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
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

  it("throw naming the declared ids when the generated entries are gone", () => {
    expect(() => openrouterModels([])).toThrow(
      /deepseek\/deepseek-v4.1-flash, x-ai\/grok-4.6, z-ai\/glm-5.3-flash/
    )
  })

  it("layer over the catalog rather than replacing it", () => {
    const models = openrouterModels()
    expect(models.length).toBeGreaterThan(OPENROUTER_IDS.length)
  })

  // apps/api prices its own model calls from the same table without Pi, so
  // the two files are package exports of their own.
  it("are published as JSON at their own paths, the same the facade reads", () => {
    // Resolved through the package's exports, as a reader in apps/api would.
    const exported = (file: string) =>
      JSON.parse(
        readFileSync(
          createRequire(import.meta.url).resolve(
            `@workspace/facade/models/${file}`
          ),
          "utf8"
        )
      )
    const ids: string[] = exported("openrouter.ids.json")
    const table: { id: string; cost: unknown }[] = exported(
      "openrouter.models.json"
    )
    expect(ids).toEqual(OPENROUTER_IDS)
    for (const entry of table) {
      expect(openrouterModels().find((m) => m.id === entry.id)?.cost).toEqual(
        entry.cost
      )
    }
  })
})
