import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText } from "ai"
import { expect, it } from "vitest"
import { CACHED_INSTRUCTIONS, INSTRUCTIONS } from "../src/cos/agent.ts"

it("sends the instructions as one system message carrying the cache marker", async () => {
  let body: { messages: { role: string; content: unknown }[] } | undefined
  const reply = {
    id: "gen-1",
    object: "chat.completion",
    created: 0,
    model: "x/y",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  const model = createOpenRouter({
    apiKey: "test",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(reply), {
        headers: { "content-type": "application/json" },
      })
    },
  }).chat("x/y")

  await generateText({
    model,
    instructions: CACHED_INSTRUCTIONS,
    prompt: "hello",
  })

  const system = body?.messages.filter((m) => m.role === "system")
  expect(system).toHaveLength(1)
  expect(system?.[0]?.content).toEqual([
    { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
  ])
})
