import { describe, expect, it } from "vitest"
import { hashCode, openToken, sealToken } from "../src/channels/token.ts"

const env = {
  CHANNEL_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
}
const ORG = crypto.randomUUID()
const PLAIN = "fake-business-token"

describe("the WhatsApp token at rest", () => {
  it("round-trips under the org id, in the shape the column checks", async () => {
    const one = await sealToken(env, ORG, PLAIN)
    const two = await sealToken(env, ORG, PLAIN)
    expect(one).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(one).not.toBe(two)
    expect(one).not.toContain(PLAIN)
    expect(await openToken(env, ORG, one)).toBe(PLAIN)
  })

  it("refuses a tampered ciphertext and one moved to another org", async () => {
    const sealed = await sealToken(env, ORG, PLAIN)
    const [v, iv, ct = ""] = sealed.split(".")
    const flipped = `${ct[0] === "A" ? "B" : "A"}${ct.slice(1)}`
    await expect(openToken(env, ORG, `${v}.${iv}.${flipped}`)).rejects.toThrow(
      "channel.bad_token"
    )
    await expect(openToken(env, crypto.randomUUID(), sealed)).rejects.toThrow(
      "channel.bad_token"
    )
  })

  it("refuses a missing key and one that is not 32 bytes", async () => {
    await expect(sealToken({}, ORG, PLAIN)).rejects.toThrow("channel.bad_key")
    await expect(
      sealToken({ CHANNEL_TOKEN_KEY: btoa("short") }, ORG, PLAIN)
    ).rejects.toThrow("channel.bad_key")
  })
})

describe("a link code's hash", () => {
  it("is the 43-character base64url SHA-256 the table checks", async () => {
    const hash = await hashCode("Connect Reme abc")
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await hashCode("Connect Reme abc")).toBe(hash)
    expect(await hashCode("Connect Reme abd")).not.toBe(hash)
  })
})
