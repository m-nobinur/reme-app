import { newUlid } from "@workspace/db"
import { describe, expect, it, vi } from "vitest"
import { afterTurnBatch, enqueueAfterTurn } from "../src/after-turn.ts"

const turn = {
  orgId: "org_1",
  staffId: "staff_1",
  sessionId: "ses_1",
  turnId: "turn_1",
}

describe("enqueueAfterTurn", () => {
  it("sends the four ids and nothing else, then the idle copy after twenty minutes", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    // A turn carries more than ids; only the ids may leave.
    await enqueueAfterTurn(
      { AFTER_TURN: { send } } as unknown as Env,
      {
        ...turn,
        text: "private",
      } as typeof turn
    )
    expect(send.mock.calls).toEqual([
      [turn],
      [{ ...turn, idle: true }, { delaySeconds: 1200 }],
    ])
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

const url = process.env.DATABASE_URL

describe.skipIf(!url)("afterTurnBatch, on a live connection", () => {
  it("acks a turn with nothing to do and retries one whose job threw", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const message = (body: typeof turn) => ({
      body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    })
    // An org with no such session: its turn never closed, so nothing runs.
    const idle = message({
      orgId: crypto.randomUUID(),
      staffId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: newUlid(),
    })
    // An org id the database refuses.
    const broken = message(turn)
    await afterTurnBatch(
      { messages: [idle, broken] } as unknown as MessageBatch<typeof turn>,
      { HYPERDRIVE: { connectionString: url } } as unknown as Env
    )
    expect(idle.ack).toHaveBeenCalledOnce()
    expect(broken.retry).toHaveBeenCalledOnce()
    expect(broken.ack).not.toHaveBeenCalled()
    expect(log.mock.calls[0]?.[0]).toContain('"outcome":"turn_open"')
    expect(error.mock.calls[0]?.[0]).toContain("after_turn.failed")
    log.mockRestore()
    error.mockRestore()
  })
})
