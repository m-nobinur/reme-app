import {
  conversationMessages,
  conversations,
  events,
  type OrgScopedDb,
  sql,
  tenancy,
} from "@workspace/db"
import {
  isWhatsAppUpdate,
  sendUpdate,
  type WhatsAppUpdate,
} from "./channels/whatsapp/templates.ts"
import {
  type ChannelJob,
  channelTurn,
  isChannelJob,
} from "./channels/whatsapp/turn.ts"
import { cosModel } from "./chat.ts"
import { type ContinueJob, continueTurn, isContinueJob } from "./continue.ts"
import { LIMITS } from "./cos/agent.ts"
import {
  compactAfterTurn,
  type Later,
  scheduleCompaction,
  THRESHOLDS,
  thresholdsFor,
} from "./cos/compaction.ts"
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
  /** The warm summary's copy (`scheduleCompaction`), for compaction only: when it was armed, in epoch ms. */
  compact?: number
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
 * What the owner typed in an onboarding conversation that the CoS never
 * logged: onboarding's answers, oldest first, for reflection's first pass.
 * Typed in the chat only: an emailed reply (`eml_`) is left out, as
 * `ownerWords` leaves it out.
 */
export async function onboardingWords(
  db: OrgScopedDb,
  id: string
): Promise<string[]> {
  const rows = await db.execute<{ text: string | null }>(sql`
    select p->>'text' as text
    from ${conversationMessages} m
    join ${conversations} c on c.id = m.conversation_id and c.kind = 'onboarding',
      jsonb_array_elements(m.content->'parts') p
    where m.conversation_id = ${id} and m.content->>'role' = 'user'
      and m.id not like 'eml\_%'
      and p->>'type' = 'text'
      and not exists (select 1 from ${events} e where e.session_id = ${id}
        and e.type = 'cos.message' and e.payload->'message'->>'id' = m.id)
    order by m.seq`)
  return rows.flatMap((r) => (r.text ? [r.text] : []))
}

/**
 * The work after each closed turn: arming the warm summary, then
 * reflection; the warm summary when its copy comes back; and a
 * continuation or a proactive turn the orchestrator handed over
 * (`continue.ts`, `wake.ts`). A message whose job threw is retried, after a
 * newer turn's longest life when it is open, then goes to the dead-letter
 * queue.
 */
export async function afterTurnBatch(
  batch: MessageBatch<
    AfterTurn | LogoJob | ContinueJob | WakeJob | ChannelJob | WhatsAppUpdate
  >,
  env: Env
): Promise<void> {
  const kit = tenancy(env.HYPERDRIVE.connectionString)
  // Logo rounds ride this queue for a consumer's fifteen minutes (`logo.ts`),
  // drawn beside the turns' work rather than ahead of it.
  const logos = batch.messages
    .filter((m): m is Message<LogoJob> => isLogoJob(m.body))
    .map((m) => drawLogoMessage(env, kit, m))
  // The review and the summary run on the owner turn's model and route, so they read its cached prefix.
  const cos = cosModel(env)
  const reviewer =
    cos.model && cos.price
      ? { model: cos.model, modelId: cos.modelId, price: cos.price }
      : null
  // The warm summary's delays ride this queue, the platform's own delay.
  const later: Later = async (job, delaySeconds) => {
    await env.AFTER_TURN.send(job, { delaySeconds })
  }
  const thresholds = env.COMPACTION_WARM_TOKENS
    ? thresholdsFor(Number(env.COMPACTION_WARM_TOKENS))
    : THRESHOLDS
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
        } else if (isChannelJob(body)) {
          const turned = await channelTurn(env, kit, body)
          console.log(
            JSON.stringify({
              type: "whatsapp.turn",
              link_id: body.linkId,
              turned,
            })
          )
        } else if (isWhatsAppUpdate(body)) {
          const sent = await sendUpdate(env, kit, body)
          console.log(
            JSON.stringify({ type: "whatsapp.update", key: body.key, sent })
          )
        } else if (isWakeJob(body)) {
          const woke = await wakeTurn(env, kit, body)
          console.log(
            JSON.stringify({ type: "cos.woke", job_id: body.jobId, woke })
          )
        } else if (body.compact !== undefined) {
          await compactAfterTurn(kit, reviewer, body, later, thresholds)
        } else {
          if (!body.idle) {
            await scheduleCompaction(kit, body, later, thresholds)
          }
          await reflectAfterTurn(kit, reviewer, body, onboardingWords)
        }
        message.ack()
      } catch (error) {
        console.error(
          JSON.stringify({
            code: "after_turn.failed",
            ...(isContinueJob(body) || isWakeJob(body)
              ? { job_id: body.jobId }
              : isChannelJob(body)
                ? { link_id: body.linkId }
                : isWhatsAppUpdate(body)
                  ? { key: body.key }
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
