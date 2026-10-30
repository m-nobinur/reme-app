import { tenancy } from "@workspace/db"
import { type ContinueJob, continueTurn, isContinueJob } from "./continue.ts"
import { LIMITS, openrouterModel } from "./cos/agent.ts"
import { COMPACTION, compactAfterTurn } from "./cos/compaction.ts"
import { REFLECTION, reflectAfterTurn } from "./cos/reflection.ts"
import { GRACE_MS, SessionBusy } from "./cos/turns.ts"
import { drawLogoMessage, isLogoJob, type LogoJob } from "./logo.ts"
import { isWakeJob, type WakeJob, wakeTurn } from "./wake.ts"

/** What a closed turn tells the queue: ids only, never text. */
export type AfterTurn = {
  orgId: string
  /** The org's Chief of Staff staff row, which writes the job's events. */
  staffId: string
  sessionId: string
  turnId: string
  /** The copy sent to arrive after the conversation has been quiet, for reflection only. */
  idle?: boolean
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
  const body = {
    orgId: turn.orgId,
    staffId: turn.staffId,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
  }
  try {
    await env.AFTER_TURN.send(body)
    // Reflection also looks once the owner has been quiet for a while.
    await env.AFTER_TURN.send(
      { ...body, idle: true },
      { delaySeconds: REFLECTION.idleSeconds }
    )
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
 * The work after each closed turn: compaction, then reflection; and a
 * continuation or a proactive turn the orchestrator handed over
 * (`continue.ts`, `wake.ts`). A message whose job threw is retried, after a
 * newer turn's longest life when it is open, then goes to the dead-letter
 * queue.
 */
export async function afterTurnBatch(
  batch: MessageBatch<AfterTurn | LogoJob | ContinueJob | WakeJob>,
  env: Env
): Promise<void> {
  // Logo rounds ride this queue for a consumer's fifteen minutes (`logo.ts`),
  // drawn beside the turns' work rather than ahead of it.
  const logos = batch.messages
    .filter((m): m is Message<LogoJob> => isLogoJob(m.body))
    .map((m) => drawLogoMessage(env, m))
  const kit = tenancy(env.HYPERDRIVE.connectionString)
  const model = env.OPENROUTER_API_KEY
    ? openrouterModel(env.OPENROUTER_API_KEY, COMPACTION.model)
    : null
  try {
    for (const message of batch.messages) {
      const { body } = message
      if (isLogoJob(body)) continue
      try {
        if (isContinueJob(body)) {
          const continued = await continueTurn(env, kit, body)
          console.log(
            JSON.stringify({
              type: "cos.continued",
              job_id: body.jobId,
              continued,
            })
          )
        } else if (isWakeJob(body)) {
          const woke = await wakeTurn(env, kit, body)
          console.log(
            JSON.stringify({ type: "cos.woke", job_id: body.jobId, woke })
          )
        } else {
          if (!body.idle) await compactAfterTurn(kit, model, body)
          await reflectAfterTurn(kit, model, body)
        }
        message.ack()
      } catch (error) {
        console.error(
          JSON.stringify({
            code: "after_turn.failed",
            ...(isContinueJob(body) || isWakeJob(body)
              ? { job_id: body.jobId }
              : { turn_id: body.turnId }),
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
    await Promise.all(logos)
  } finally {
    await kit.close()
  }
}
