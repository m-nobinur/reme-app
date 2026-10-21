import { describe, expect, it } from "vitest"
import {
  readReplyToken,
  replyAddress,
  replyToken,
  tokenFromAddress,
} from "../src/reply-token.ts"

describe("reply address", () => {
  const prod = "reply@reply.remeai.co.uk"
  const staging = "reply@reply-stg.remeai.co.uk"
  const token = `${"aB-_".repeat(14)}`

  it("carries the token in the local part and reads it back with its case", () => {
    const address = replyAddress(prod, token)
    expect(address).toBe(`reply+${token}@reply.remeai.co.uk`)
    expect(address.split("@")[0]?.length).toBeLessThanOrEqual(64)
    expect(tokenFromAddress(prod, address)).toBe(token)
  })

  it("is read only by the mailbox of its own environment", () => {
    expect(tokenFromAddress(staging, replyAddress(prod, token))).toBeNull()
    expect(tokenFromAddress(prod, replyAddress(staging, token))).toBeNull()
  })

  it("refuses an address that is not a reply to this mailbox", () => {
    expect(tokenFromAddress(prod, "owner@reply.remeai.co.uk")).toBeNull()
    expect(tokenFromAddress(prod, `reply+${token}@remeai.co.uk`)).toBeNull()
    expect(tokenFromAddress(prod, "not-an-address")).toBeNull()
  })

  it("refuses a base name too long to leave room for the token", () => {
    expect(() => replyAddress("replies@remeai.co.uk", token)).not.toThrow()
    expect(() => replyAddress("replyto1@remeai.co.uk", token)).toThrow()
  })
})

const KEY = "k".repeat(32)
const org = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b"
const conversation = "0190ffff-0000-7000-8000-123456789abc"

describe("reply token", () => {
  it("round-trips the pair and fits a 64 character local part", async () => {
    const token = await replyToken(KEY, org, conversation)
    expect(token).toMatch(/^[A-Za-z0-9_-]{56}$/)
    expect(`reply+${token}`.length).toBeLessThanOrEqual(64)
    expect(await readReplyToken(KEY, token)).toEqual({
      orgId: org,
      conversationId: conversation,
    })
  })

  it("refuses a token under another key, with a changed id or MAC, or of another shape", async () => {
    const token = await replyToken(KEY, org, conversation)
    expect(await readReplyToken("j".repeat(32), token)).toBeNull()
    const flip = (at: number) =>
      token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1)
    expect(await readReplyToken(KEY, flip(0))).toBeNull()
    expect(await readReplyToken(KEY, flip(55))).toBeNull()
    expect(await readReplyToken(KEY, token.slice(1))).toBeNull()
    expect(await readReplyToken(KEY, `${token}A`)).toBeNull()
    expect(await readReplyToken(KEY, "")).toBeNull()
  })

  it("does not move a token to another conversation", async () => {
    const a = await replyToken(KEY, org, conversation)
    const b = await replyToken(KEY, org, "0190ffff-0000-7000-8000-123456789abd")
    expect(a).not.toBe(b)
  })
})
