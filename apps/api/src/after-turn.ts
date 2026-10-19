/** What a closed turn tells the queue: ids only, never text. */
export type AfterTurn = {
  orgId: string
  sessionId: string
  turnId: string
}

/**
 * Queues the work that follows a closed turn. It never throws and never
 * waits on anything but the send, so the owner's turn cannot fail or slow
 * because the queue did.
 */
export async function enqueueAfterTurn(
  env: Env,
  turn: AfterTurn
): Promise<void> {
  try {
    await env.AFTER_TURN.send({
      orgId: turn.orgId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        code: "after_turn.enqueue_failed",
        turn_id: turn.turnId,
        error: error instanceof Error ? error.name : "unknown",
      })
    )
  }
}

/** A no-op job for now: one line per message and an ack, with no database. */
export async function afterTurnBatch(
  batch: MessageBatch<AfterTurn>
): Promise<void> {
  for (const message of batch.messages) {
    console.log(
      JSON.stringify({
        code: "after_turn.job",
        turn_id: message.body.turnId,
        attempts: message.attempts,
      })
    )
    message.ack()
  }
}
