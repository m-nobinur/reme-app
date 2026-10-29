import { afterEach, describe, expect, it, vi } from "vitest"
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
