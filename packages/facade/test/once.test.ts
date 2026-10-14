import { afterEach, describe, expect, it, vi } from "vitest"
import { completeOnce } from "../src/once.ts"

const sse = (text: string) => {
  const chunks = [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    {
      choices: [],
      usage: { prompt_tokens: 1_000, completion_tokens: 50, cost: 0.0002 },
    },
  ].map((c) => `data: ${JSON.stringify({ id: "gen-1", ...c })}\n\n`)
  return `${chunks.join("")}data: [DONE]\n\n`
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * The quick edit lane's one call, on the wire: the routing table's model,
 * the role's effort, a one-hour cache mark on the stable system prompt, the
 * session that pins a host, the structured-output schema, and the billed cost.
 */
describe("completeOnce", () => {
  it("sends one cached, low-effort, structured call and returns its text", async () => {
    const sent: Record<string, unknown>[] = []
    const headers: Headers[] = []
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      headers.push(new Headers(init?.headers))
      return new Response(sse('{"summary":"x","edits":[]}'), {
        headers: { "content-type": "text/event-stream" },
      })
    })
    const reply = await completeOnce(
      { OPENROUTER_API_KEY: "or-key" },
      {
        model: "openrouter/anthropic/claude-haiku-5.5",
        effort: "low",
        maxTokens: 4_000,
        system: "The rules.",
        user: "The change.",
        sessionId: "assignment-1",
        schema: { name: "quick_edits", schema: { type: "object" } },
      }
    )
    expect(reply.text).toBe('{"summary":"x","edits":[]}')
    expect(reply.usage.cost.total).toBe(0.0002)
    const body = sent[0] as {
      model: string
      reasoning: unknown
      max_completion_tokens: number
      response_format: { json_schema: { name: string; strict: boolean } }
      messages: { role: string; content: unknown }[]
    }
    expect(body.model).toBe("anthropic/claude-haiku-5.5")
    expect(body.reasoning).toEqual({ effort: "low" })
    expect(body.max_completion_tokens).toBe(4_000)
    expect(body.response_format.json_schema).toMatchObject({
      name: "quick_edits",
      strict: true,
    })
    expect(body.messages[0]).toMatchObject({
      content: [
        {
          type: "text",
          text: "The rules.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    })
    expect(headers[0]?.get("x-session-id")).toBe("assignment-1")
  })

  it("throws a typed refusal for a model the table does not route", async () => {
    await expect(
      completeOnce(
        { OPENROUTER_API_KEY: "or-key" },
        {
          model: "openrouter/nobody/none",
          effort: "low",
          maxTokens: 10,
          system: "s",
          user: "u",
          sessionId: "a",
        }
      )
    ).rejects.toMatchObject({ code: "model.unresolved" })
  })
})
