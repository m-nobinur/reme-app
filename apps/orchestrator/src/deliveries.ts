import { createHash } from "node:crypto"
import type { ServerMessage } from "@workspace/contracts"
import {
  deliveries,
  eq,
  failureCode,
  logFailure,
  memberships,
  type OrgScopedDb,
  postAssistantMessage,
  sql,
  type Tenancy,
  tenancy,
  users,
} from "@workspace/db"

/**
 * The outbox (ADR-043). `deliver` writes the row and queues one message; the
 * batch handler below sends it. The key names the cause (`reminder:<id>`),
 * never the time sent, so a second `deliver` for the same cause is a no-op.
 * The Queue is at-least-once, so the consumer sends only a row still
 * `pending`; a crash between a send and its row update can repeat one email,
 * which the in-app path avoids by posting under a stable message id.
 */

export const OWNER_FROM = { name: "Reme", email: "hello@remeai.co.uk" }
/** The `deliveries` Queue's name in each environment, as the wrangler config spells it. */
export const DELIVERIES_QUEUES = [
  "reme-deliveries",
  "reme-deliveries-production",
]
/** Matched to `max_retries` in wrangler.jsonc: the last attempt settles the row as failed. */
export const MAX_RETRIES = 5

export type DeliveryMessage = { orgId: string; key: string } & (
  | {
      channel: "in_app"
      message: Omit<ServerMessage, "id">
      /** A reminder's own conversation; the org's newest when absent. */
      conversationId?: string
    }
  | { channel: "email"; subject: string; text: string }
)

type SendEnv = { DELIVERIES: Queue<DeliveryMessage> }
type BatchEnv = {
  HYPERDRIVE: Hyperdrive
  OWNER_MAIL: SendEmail
  APP_ORIGIN: string
}

const insertRow = (db: OrgScopedDb, { orgId, key, channel }: DeliveryMessage) =>
  db
    .insert(deliveries)
    .values({ orgId, key, channel })
    .onConflictDoNothing()
    .returning({ key: deliveries.key })

export async function deliver(
  kit: Tenancy,
  env: SendEnv,
  delivery: DeliveryMessage
): Promise<"queued" | "exists"> {
  const { orgId, key } = delivery
  const inserted = await kit.withOrg({ orgId }, (db) => insertRow(db, delivery))
  if (inserted.length === 0) return "exists"
  try {
    await env.DELIVERIES.send(delivery)
  } catch (error) {
    // Unqueued, the row would hold the key against every retry of this call.
    await kit.withOrg({ orgId }, (db) =>
      db.delete(deliveries).where(sql`${deliveries.key} = ${key}`)
    )
    throw error
  }
  return "queued"
}

/** How long a message waits in the Queue, for the transaction that wrote its row to commit. */
const COMMIT_GRACE_SECONDS = 5

/**
 * `deliver` for a caller already inside a transaction, such as a job
 * handler: the row is written with `db`, so it commits with the caller's
 * work or not at all. The message goes to the Queue now, a few seconds
 * delayed so the commit lands first. A rolled-back caller leaves a message
 * for a row that does not exist, which `attempt` treats as nothing to do.
 * If the send throws, so does this, and the caller's rollback drops the row.
 */
export async function deliverIn(
  db: OrgScopedDb,
  env: SendEnv,
  delivery: DeliveryMessage
): Promise<"queued" | "exists"> {
  const inserted = await insertRow(db, delivery)
  if (inserted.length === 0) return "exists"
  await env.DELIVERIES.send(delivery, { delaySeconds: COMMIT_GRACE_SECONDS })
  return "queued"
}

type Outcome =
  | { state: "sent" | "suppressed" }
  | { state: "failed"; error: string }
  | { state: "retry"; error: string }

export async function deliveriesBatch(
  batch: MessageBatch<DeliveryMessage>,
  env: BatchEnv,
  kit: Tenancy = tenancy(env.HYPERDRIVE.connectionString)
): Promise<void> {
  for (const message of batch.messages) {
    const delaySeconds = Math.min(30 * 4 ** (message.attempts - 1), 3600)
    try {
      const outcome = await attempt(kit, env, message.body)
      if (!outcome) {
        message.ack()
      } else if (outcome.state !== "retry") {
        await settle(kit, message.body, outcome)
        message.ack()
      } else if (message.attempts > MAX_RETRIES) {
        await settle(kit, message.body, {
          state: "failed",
          error: outcome.error,
        })
        message.ack()
      } else {
        message.retry({ delaySeconds })
      }
    } catch (error) {
      // Left pending: the Queue redelivers, and after `max_retries` the
      // dead-letter queue holds the message.
      logFailure({ where: "deliveries.batch" }, error)
      message.retry({ delaySeconds })
    }
  }
}

/** Null when the row is not pending: already settled, or never kept. */
async function attempt(
  kit: Tenancy,
  env: BatchEnv,
  body: DeliveryMessage
): Promise<Outcome | null> {
  const { orgId, key } = body
  const claimed = await kit.withOrg({ orgId }, (db) =>
    db
      .update(deliveries)
      .set({ attempts: sql`${deliveries.attempts} + 1` })
      .where(
        sql`${deliveries.key} = ${key} and ${deliveries.state} = 'pending'`
      )
      .returning({ key: deliveries.key })
  )
  if (claimed.length === 0) return null
  if (body.channel === "email") return sendEmail(kit, env, body)
  const posted = await postAssistantMessage(kit, {
    orgId,
    key,
    message: body.message,
    conversationId: body.conversationId,
  })
  if (posted === "posted" || posted === "exists") return { state: "sent" }
  if (posted === "none") return { state: "failed", error: "no_conversation" }
  return { state: "retry", error: posted }
}

async function settle(
  kit: Tenancy,
  { orgId, key }: DeliveryMessage,
  outcome: Exclude<Outcome, { state: "retry" }>
) {
  const error = "error" in outcome ? outcome.error : null
  await kit.withOrg({ orgId }, (db) =>
    db
      .update(deliveries)
      .set({
        state: outcome.state,
        error,
        sentAt: outcome.state === "sent" ? sql`now()` : null,
      })
      .where(eq(deliveries.key, key))
  )
}

/**
 * Cloudflare's own list of what a retry can fix. `E_DELIVERY_FAILED` is
 * undocumented either way, so it gets the bounded retries too; every other
 * code is a request or setup the next attempt would repeat.
 */
const TRANSIENT = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_DELIVERY_FAILED",
])

/**
 * The owner's address is switched off by a row in `deliveries` itself, keyed
 * by a hash of the address, so there is no new table or column to migrate and
 * the row is org-scoped by the same RLS as every other delivery. An owner who
 * changes address gets a different hash, so the new address starts on.
 */
const suppressionKey = (address: string) =>
  `email-suppressed:${createHash("sha256").update(address.toLowerCase()).digest("hex")}`

async function sendEmail(
  kit: Tenancy,
  env: BatchEnv,
  { orgId, subject, text }: DeliveryMessage & { channel: "email" }
): Promise<Outcome> {
  const [owner] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        sql`${memberships.role} = 'owner' and ${memberships.status} = 'active'`
      )
      .orderBy(memberships.createdAt)
      .limit(1)
  )
  if (!owner) return { state: "failed", error: "no_owner" }
  const to = owner.email
  const off = suppressionKey(to)
  const [suppressed] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ key: deliveries.key })
      .from(deliveries)
      .where(
        sql`${deliveries.key} = ${off} and ${deliveries.state} = 'suppressed'`
      )
  )
  if (suppressed) return { state: "suppressed" }
  const link = `${env.APP_ORIGIN}/app`
  try {
    await env.OWNER_MAIL.send({
      from: OWNER_FROM,
      to,
      subject,
      text: `${text}\n\nOpen Reme: ${link}`,
      html: `${text
        .split("\n\n")
        .map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`)
        .join("")}<p><a href="${link}">Open Reme</a></p>`,
    })
    return { state: "sent" }
  } catch (error) {
    // The code only: a send error can name the recipient.
    const raw = (error as { code?: unknown } | null)?.code
    const code = typeof raw === "string" ? raw : failureCode(error)
    if (code === "E_RECIPIENT_SUPPRESSED") {
      await kit.withOrg({ orgId }, (db) =>
        db
          .insert(deliveries)
          .values({
            orgId,
            key: off,
            channel: "email",
            state: "suppressed",
            error: code,
          })
          .onConflictDoNothing()
      )
      return { state: "suppressed" }
    }
    // No code is a network or runtime error, which the next attempt may clear.
    return TRANSIENT.has(code) || typeof raw !== "string"
      ? { state: "retry", error: code }
      : { state: "failed", error: code }
  }
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
