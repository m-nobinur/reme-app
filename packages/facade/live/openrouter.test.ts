import { createModels } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { buildProviders, selectTransport } from "../src/transport.ts"

/**
 * One real call through the transport the environment selects, skipped
 * without a key. Pi's own registry with the facade's provider registered in
 * it, the smallest completion the model will give, and the host it dialled
 * read back from the model. Costs a fraction of a cent.
 */
const env = {
  REME_MODEL_PRIMARY: process.env.REME_MODEL_PRIMARY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
}
const live = describe.skipIf(!env.OPENROUTER_API_KEY)

live("a model call over the selected transport", { timeout: 60_000 }, () => {
  it("resolves openrouter/deepseek/deepseek-v4.1-flash and answers", async () => {
    const transport = selectTransport(env)
    const models = createModels()
    for (const provider of buildProviders(env, transport)) {
      models.setProvider(provider)
    }
    const model = models.getModel("openrouter", "deepseek/deepseek-v4.1-flash")
    expect(model?.baseUrl).toBe("https://openrouter.ai/api/v1")
    if (!model) throw new Error("model did not resolve")
    const reply = await models.complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with the single word: ready",
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: 16 }
    )
    const text = reply.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("")
    console.log(
      JSON.stringify({
        transport,
        model: reply.model,
        usage: reply.usage,
        text,
      })
    )
    expect(reply.stopReason).not.toBe("error")
    expect(text.toLowerCase()).toContain("ready")
  })
})
