import { describe, expect, it } from "vitest"
import { FacadeError } from "../src/errors.ts"
import {
  buildProviders,
  outboundUrl,
  selectTransport,
} from "../src/transport.ts"

const MODEL = "openrouter/deepseek/deepseek-v4.1-flash"

const gateway = {
  CF_ACCOUNT_ID: "acct",
  CF_AI_GATEWAY_ID: "gw",
  CF_AI_GATEWAY_TOKEN: "cf-token",
}

/**
 * The done-when, read as URLs: with the primary set to a transport whose
 * key is absent, startup fails naming the variable; unset with only the
 * OpenRouter key, the call dials openrouter.ai; with the CF values and the
 * primary at gateway:anthropic, the same call dials gateway.ai.cloudflare.com.
 * The URL is the model's `baseUrl`, which is what Pi dials.
 */
describe("transport selection", () => {
  it("fails at startup naming the missing variable when the primary is set", () => {
    try {
      selectTransport({ REME_MODEL_PRIMARY: "direct:anthropic" })
      throw new Error("did not throw")
    } catch (error) {
      expect(error).toBeInstanceOf(FacadeError)
      const refusal = error as FacadeError
      expect(refusal.code).toBe("transport.key_missing")
      expect(refusal.message).toContain("ANTHROPIC_API_KEY")
      expect(refusal.detail.missing).toEqual(["ANTHROPIC_API_KEY"])
    }
  })

  it("refuses a primary that is not a transport", () => {
    expect(() =>
      selectTransport({ REME_MODEL_PRIMARY: "carrier:pigeon" })
    ).toThrow(/REME_MODEL_PRIMARY is carrier:pigeon/)
  })

  it("dials openrouter.ai directly with only the OpenRouter key present", () => {
    const env = { OPENROUTER_API_KEY: "or-key" }
    const transport = selectTransport(env)
    expect(transport).toBe("direct:openrouter")
    const providers = buildProviders(env, transport)
    expect(outboundUrl(providers, MODEL)).toBe("https://openrouter.ai/api/v1")
  })

  it("dials the gateway when the CF values are present and the primary is gateway:anthropic", () => {
    const env = {
      ...gateway,
      OPENROUTER_API_KEY: "or-key",
      REME_MODEL_PRIMARY: "gateway:anthropic",
    }
    const transport = selectTransport(env)
    expect(transport).toBe("gateway:anthropic")
    const providers = buildProviders(env, transport)
    expect(outboundUrl(providers, "anthropic/claude-sonnet-4-6")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic"
    )
    // The fallback lives on OpenRouter and rides the same gateway.
    expect(outboundUrl(providers, MODEL)).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openrouter"
    )
  })

  it("takes the first transport with a key when the primary is unset, in the fixed order", () => {
    expect(selectTransport({ ...gateway, OPENROUTER_API_KEY: "k" })).toBe(
      "gateway:anthropic"
    )
    expect(
      selectTransport({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "k" })
    ).toBe("direct:anthropic")
    expect(() => selectTransport({})).toThrow(/no model transport has a key/)
  })

  it("resolves the three decided models on the openrouter provider", () => {
    const providers = buildProviders(
      { OPENROUTER_API_KEY: "k" },
      "direct:openrouter"
    )
    for (const id of [
      MODEL,
      "openrouter/z-ai/glm-5.3-flash",
      "openrouter/x-ai/grok-4.6",
    ]) {
      expect(outboundUrl(providers, id)).toBe("https://openrouter.ai/api/v1")
    }
    expect(() => outboundUrl(providers, "openrouter/nobody/nothing")).toThrow(
      /resolves to no registered model/
    )
  })

  it("hands the key to the provider as request auth, never through the environment", async () => {
    const [openrouter] = buildProviders(
      { OPENROUTER_API_KEY: "or-key" },
      "direct:openrouter"
    )
    const auth = await openrouter?.auth.apiKey?.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
    })
    expect(auth?.auth.apiKey).toBe("or-key")
    expect(auth?.source).toBe("worker secret")
  })
})
