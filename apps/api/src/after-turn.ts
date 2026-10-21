import { tenancy } from "@workspace/db"
import { LIMITS, openrouterModel } from "./cos/agent.ts"
import { COMPACTION, compactAfterTurn } from "./cos/compaction.ts"
import { GRACE_MS, SessionBusy } from "./cos/turns.ts"

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
 * threw is retried, after a newer turn's longest life when it is open, then
 * goes to the dead-letter queue.
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
        // A turn that is open has closed or lapsed by then.
        message.retry(
          error instanceof SessionBusy
            ? { delaySeconds: (LIMITS.totalMs + GRACE_MS) / 1000 }
            : undefined
        )
      }
    }
  } finally {
    await kit.close()
  }
}
