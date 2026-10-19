import { tenancy } from "@workspace/db"
import { openrouterModel } from "./cos/agent.ts"
import { COMPACTION, compactAfterTurn } from "./cos/compaction.ts"

/** What a closed turn tells the queue: ids only, never text. */
export type AfterTurn = {
  orgId: string
  /** The org's Chief of Staff staff row, which writes the job's events. */
  staffId: string
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
      staffId: turn.staffId,
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

/**
 * The work after each closed turn: compaction for now. A message whose job
 * threw is retried, then goes to the dead-letter queue.
 */
export async function afterTurnBatch(
  batch: MessageBatch<AfterTurn>,
  env: Env
): Promise<void> {
  const kit = tenancy(env.HYPERDRIVE.connectionString)
  const model = env.OPENROUTER_API_KEY
    ? openrouterModel(env.OPENROUTER_API_KEY, COMPACTION.model)
    : null
  try {
    for (const message of batch.messages) {
      try {
        await compactAfterTurn(kit, model, message.body)
        message.ack()
      } catch (error) {
        console.error(
          JSON.stringify({
            code: "after_turn.failed",
            turn_id: message.body.turnId,
            attempts: message.attempts,
            error: error instanceof Error ? error.name : "unknown",
          })
        )
        message.retry()
      }
    }
  } finally {
    await kit.close()
  }
}
