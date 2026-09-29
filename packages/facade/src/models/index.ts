import type { Model } from "@earendil-works/pi-ai"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { FacadeError } from "../errors.ts"
import ids from "./openrouter.ids.json" with { type: "json" }
import generated from "./openrouter.models.json" with { type: "json" }
import { HOST_ROUTING } from "./price.ts"

export type OpenRouterModel = Model<"openai-completions">

/** The ids the facade promises to resolve, one list, edited by hand. */
export const OPENROUTER_IDS: readonly string[] = ids

/**
 * Pi's OpenRouter catalog with the generated entries layered over it: a
 * generated entry replaces a catalog entry of the same id, so cost per
 * assignment uses today's prices rather than the catalog's. Every id in the
 * list must have a generated entry, and the throw names the ones that do
 * not, which is the fail-fast `scripts/openrouter-models.mjs` exists for.
 */
export function openrouterModels(
  entries: readonly OpenRouterModel[] = generated as OpenRouterModel[],
  required: readonly string[] = OPENROUTER_IDS
): OpenRouterModel[] {
  const byId = new Map<string, OpenRouterModel>()
  for (const model of openrouterProvider().getModels()) {
    const routing = { ...model.compat?.openRouterRouting, ...HOST_ROUTING }
    byId.set(model.id, {
      ...model,
      compat: { ...model.compat, openRouterRouting: routing },
    })
  }
  for (const model of entries) byId.set(model.id, model)
  const missing = required.filter(
    (id) => !entries.some((model) => model.id === id)
  )
  if (missing.length > 0) {
    throw new FacadeError(
      "models.not_generated",
      "resource",
      `openrouter.models.json has no entry for ${missing.join(", ")}; run pnpm --filter @workspace/facade models`,
      { missing }
    )
  }
  return [...byId.values()]
}
