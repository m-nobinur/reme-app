import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, type ModelMessage } from "ai"
import { expect, it } from "vitest"
import {
  CACHED_INSTRUCTIONS,
  INSTRUCTIONS,
  instructionsFor,
  withHistoryMarker,
} from "../src/cos/agent.ts"

/** An OpenRouter model whose requests land in `sent`. */
function recorded() {
  const sent: { messages: { role: string; content: unknown }[] }[] = []
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
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(reply), {
        headers: { "content-type": "application/json" },
      })
    },
  }).chat("x/y")
  return { model, sent }
}

it("sends the instructions as one system message carrying the cache marker", async () => {
  const { model, sent } = recorded()

  await generateText({
    model,
    instructions: CACHED_INSTRUCTIONS,
    prompt: "hello",
  })

  const system = sent[0]?.messages.filter((m) => m.role === "system")
  expect(system).toHaveLength(1)
  expect(system?.[0]?.content).toEqual([
    { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
  ])
})

it("marks the last user message before the context note, inside its text part", async () => {
  const { model, sent } = recorded()
  const text = (t: string) => [{ type: "text" as const, text: t }]
  const messages: ModelMessage[] = [
    { role: "user", content: text("first") },
    { role: "assistant", content: text("reply one") },
    { role: "user", content: text("second") },
    { role: "assistant", content: text("reply two") },
    { role: "user", content: text("Mode: ask.") },
    { role: "user", content: text("third") },
  ]
  // A step is handed the last step's messages, marker included: marking
  // again moves it, never adds a second.
  const once = withHistoryMarker(messages, "Mode: ask.")
  const carried = withHistoryMarker(
    [
      { ...once[0], providerOptions: once[2]?.providerOptions } as ModelMessage,
      ...once.slice(1),
    ],
    "Mode: ask."
  )

  await generateText({
    model,
    instructions: CACHED_INSTRUCTIONS,
    messages: carried,
  })

  const marked = sent[0]?.messages.flatMap((m, i) =>
    JSON.stringify(m).includes("cache_control") ? [i] : []
  )
  expect(marked).toEqual([0, 3])
  expect(sent[0]?.messages[3]?.content).toEqual([
    { type: "text", text: "second", cache_control: { type: "ephemeral" } },
  ])
  expect(withHistoryMarker(messages, "not sent")).toEqual(messages)
})

it("sends the memory snapshot as a second system message with its own marker, three markers in all", async () => {
  const { model, sent } = recorded()
  const text = (t: string) => [{ type: "text" as const, text: t }]

  await generateText({
    model,
    instructions: instructionsFor("OWNER PROFILE"),
    messages: withHistoryMarker(
      [
        { role: "user", content: text("first") },
        { role: "assistant", content: text("reply one") },
        { role: "user", content: text("Mode: ask.") },
        { role: "user", content: text("second") },
      ],
      "Mode: ask."
    ),
  })

  const body = sent[0]?.messages ?? []
  const block = (t: string) => ({
    role: "system",
    content: [{ type: "text", text: t, cache_control: { type: "ephemeral" } }],
  })
  expect(body.slice(0, 2)).toEqual([
    block(INSTRUCTIONS),
    block("OWNER PROFILE"),
  ])
  // Anthropic allows four breakpoints; OpenRouter reads only the last for Gemini.
  expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(3)
})
