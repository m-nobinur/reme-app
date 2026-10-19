import { describe, expect, it } from "vitest"
import { readReplyToken, replyToken } from "../src/reply-token.ts"

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
