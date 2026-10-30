import { afterEach, describe, expect, it, vi } from "vitest"
import { cosModel } from "../src/chat.ts"
import {
  DEFAULT_MODEL,
  OUTAGE_MODEL,
  openrouterModel,
  priceOf,
} from "../src/cos/agent.ts"

afterEach(() => vi.unstubAllGlobals())

describe("the outage fallback", () => {
  it("names a tool-capable model the price table knows, under the default's cap", () => {
    const fallback = priceOf(OUTAGE_MODEL)
    const primary = priceOf(DEFAULT_MODEL)
    expect(fallback).not.toBeNull()
    expect(fallback?.input).toBeLessThanOrEqual(primary?.input ?? 0)
    expect(fallback?.output).toBeLessThanOrEqual(primary?.output ?? 0)
  })

  it("sends the models list and the hosts either model excludes", async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return new Response("{}", { status: 500 })
    })
    const model = openrouterModel("key", DEFAULT_MODEL, {
      models: [DEFAULT_MODEL, OUTAGE_MODEL],
    })
    await (model as never as { doGenerate: (o: unknown) => Promise<unknown> })
      .doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      })
      .catch(() => undefined)
    expect(body.models).toEqual([DEFAULT_MODEL, OUTAGE_MODEL])
    expect((body.provider as { ignore: string[] }).ignore).toContain(
      "amazon-bedrock"
    )
  })
})

describe("the card-click route", () => {
  const sentBy = async (vars: Partial<Env>) => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return new Response("{}", { status: 500 })
    })
    const cos = cosModel(
      { OPENROUTER_API_KEY: "key", ...vars } as Env,
      "card_click"
    )
    await (
      cos.model as never as { doGenerate: (o: unknown) => Promise<unknown> }
    )
      .doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      })
      .catch(() => undefined)
    return { route: cos.route, modelId: cos.modelId, body }
  }

  it("sends a card click to the same model at low effort once switched on", async () => {
    const sent = await sentBy({ COS_ROUTES: "card_click" })
    expect(sent.route).toBe("card_click")
    expect(sent.modelId).toBe(DEFAULT_MODEL)
    expect(sent.body.model).toBe(DEFAULT_MODEL)
    expect(sent.body.models).toEqual([DEFAULT_MODEL, OUTAGE_MODEL])
    expect(sent.body.reasoning).toEqual({ effort: "low" })
  })

  it("leaves a card click on the owner turn's default effort while switched off", async () => {
    const sent = await sentBy({})
    expect(sent.route).toBe("owner_turn")
    expect(sent.body.model).toBe(DEFAULT_MODEL)
    expect(sent.body.reasoning).toBeUndefined()
  })
})
