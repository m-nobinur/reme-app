import { describe, expect, it, vi } from "vitest"
import { afterTurnBatch, enqueueAfterTurn } from "../src/after-turn.ts"

const turn = { orgId: "org_1", sessionId: "ses_1", turnId: "turn_1" }

describe("enqueueAfterTurn", () => {
  it("sends the three ids and nothing else", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    // A turn carries more than ids; only the ids may leave.
    await enqueueAfterTurn(
      { AFTER_TURN: { send } } as unknown as Env,
      {
        ...turn,
        text: "private",
      } as typeof turn
    )
    expect(send).toHaveBeenCalledExactlyOnceWith(turn)
  })

  it("logs a failed send and does not throw", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const send = vi.fn().mockRejectedValue(new Error("queue down"))
    await expect(
      enqueueAfterTurn({ AFTER_TURN: { send } } as unknown as Env, turn)
    ).resolves.toBeUndefined()
    expect(log.mock.calls[0]?.[0]).toContain("after_turn.enqueue_failed")
    log.mockRestore()
  })
})

describe("afterTurnBatch", () => {
  it("acks each message", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const messages = [1, 2].map((attempts) => ({
      body: { ...turn, turnId: `turn_${attempts}` },
      attempts,
      ack: vi.fn(),
      retry: vi.fn(),
    }))
    await afterTurnBatch({ messages } as unknown as MessageBatch<typeof turn>)
    for (const m of messages) {
      expect(m.ack).toHaveBeenCalledOnce()
      expect(m.retry).not.toHaveBeenCalled()
    }
    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })
})
