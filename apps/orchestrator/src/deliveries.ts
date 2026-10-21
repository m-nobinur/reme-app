import { createHash } from "node:crypto"
import {
  replyAddress,
  replyToken,
  type ServerMessage,
} from "@workspace/contracts"
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
import { type PushDelivery, pushFor, sendPush } from "./push.ts"

/**
 * The outbox (ADR-043). `deliver` writes the row and queues one message; the
 * batch handler below sends it. The key names the cause (`reminder:<id>`),
 * never the time sent, so a second `deliver` for the same cause is a no-op.
 * The Queue is at-least-once, so the consumer first moves the row from
 * `pending` to `sending` with a lease, and only the one that wins sends. A
 * crash past the lease can repeat one email, which the in-app path avoids by
 * posting under a stable message id. An email whose send fails with no
 * provider code may have left, so it settles as `unknown` and is never
 * sent again. A delivered in-app message also queues a push (push.ts).
 */

export const OWNER_FROM = { name: "Reme", email: "hello@remeai.co.uk" }
/** The `deliveries` Queue's name in each environment, as the wrangler config spells it. */
export const DELIVERIES_QUEUES = [
  "reme-deliveries",
  "reme-deliveries-production",
]
/** Matched to `max_retries` in wrangler.jsonc: the last attempt settles the row as failed. */
export const MAX_RETRIES = 5
/** A send takes seconds; the lease only bounds how long a dead consumer holds a row. */
const LEASE = "5 minutes"
/** How long a row may sit unsettled before the hourly sweep queues it again. */
const STUCK_AFTER = "10 minutes"
/** Per org per sweep, so one backlog cannot swamp the batch. */
const REDRIVE_LIMIT = 50

export type DeliveryMessage = { orgId: string; key: string } & (
  | {
      channel: "in_app"
      message: Omit<ServerMessage, "id">
      /** A reminder's own conversation; the org's newest when absent. */
      conversationId?: string
    }
  | {
      channel: "email"
      subject: string
      text: string
      /** The conversation a reply goes to; with none, the email takes no reply. */
      conversationId?: string
    }
  | PushDelivery
)

type SendEnv = { DELIVERIES: Queue<DeliveryMessage> }
type BatchEnv = SendEnv & {
  HYPERDRIVE: Hyperdrive
  /** Signs the push request; unset, a push fails as `push_unset`. */
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT: string
  OWNER_MAIL: SendEmail
  APP_ORIGIN: string
  /** Signs the Reply-To token; unset, an email goes without one. */
  REPLY_TOKEN_KEY?: string
  /** This environment's base reply address; see `replyAddress` in the contracts. */
  REPLY_MAILBOX: string
}

/**
 * Writes the outbox row, holding the message so the sweep can queue it again
 * (it carries no address; the owner's is read at send time). False when the
 * key already has a row. The caller queues the message after its commit.
 */
export async function insertDelivery(
  db: OrgScopedDb,
  delivery: DeliveryMessage
): Promise<boolean> {
  const { orgId, key, channel } = delivery
  const inserted = await db
    .insert(deliveries)
    .values({ orgId, key, channel, payload: delivery })
    .onConflictDoNothing()
    .returning({ key: deliveries.key })
  return inserted.length > 0
}

export async function deliver(
  kit: Tenancy,
  env: SendEnv,
  delivery: DeliveryMessage
): Promise<"queued" | "exists"> {
  const { orgId, key } = delivery
  const inserted = await kit.withOrg({ orgId }, (db) =>
    insertDelivery(db, delivery)
  )
  if (!inserted) return "exists"
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

/**
 * `deliver` for a caller already inside a transaction, such as a job
 * handler: the row is written with `db`, so it commits with the caller's
 * work or not at all. Returns the Queue send for the caller to run once that
 * transaction has committed (a job handler's `after`), or null when the key
 * already exists. Sent any earlier, the consumer could look for a row that
 * is not visible yet and drop the message.
 */
export async function deliverIn(
  db: OrgScopedDb,
  env: SendEnv,
  delivery: DeliveryMessage
): Promise<(() => Promise<void>) | null> {
  return (await insertDelivery(db, delivery))
    ? async () => void (await env.DELIVERIES.send(delivery))
    : null
}

type Outcome =
  | { state: "sent" | "suppressed" }
  | { state: "failed" | "unknown"; error: string }
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
        console.log(
          JSON.stringify({
            type: "deliveries.retry",
            channel: message.body.channel,
            reason: outcome.error,
            attempts: message.attempts,
          })
        )
        await release(kit, message.body)
        message.retry({ delaySeconds })
      }
    } catch (error) {
      // The Queue redelivers, and after `max_retries` the dead-letter queue
      // holds the message. In-app posts under a stable id, so its row is freed
      // for the retry; an email stays claimed until the lease lapses, since
      // the send may have left.
      logFailure({ where: "deliveries.batch" }, error)
      if (message.body.channel === "in_app")
        await release(kit, message.body).catch(() => undefined)
      message.retry({ delaySeconds })
    }
  }
}

/** Null when another consumer holds the row, or it is settled or never kept. */
async function attempt(
  kit: Tenancy,
  env: BatchEnv,
  body: DeliveryMessage
): Promise<Outcome | null> {
  const { orgId, key } = body
  const claimed = await kit.withOrg({ orgId }, (db) =>
    db
      .update(deliveries)
      .set({
        state: "sending",
        attempts: sql`${deliveries.attempts} + 1`,
        leaseUntil: sql`now() + ${LEASE}::interval`,
      })
      .where(
        sql`${deliveries.key} = ${key} and (${deliveries.state} = 'pending' or (${deliveries.state} = 'sending' and ${deliveries.leaseUntil} < now()))`
      )
      .returning({ key: deliveries.key })
  )
  if (claimed.length === 0) return null
  if (body.channel === "email") return sendEmail(kit, env, body)
  if (body.channel === "push") return sendPush(kit, env, orgId, body)
  const posted = await postAssistantMessage(kit, {
    orgId,
    key,
    message: body.message,
    conversationId: body.conversationId,
  })
  if (posted === "posted" || posted === "exists") {
    // Also on "exists": a crash after the post must not lose the push, and a
    // key already queued makes this a no-op.
    const push = await pushFor(kit, body)
    if (push)
      await deliver(kit, env, { orgId, key: push.key, ...push.delivery })
    return { state: "sent" }
  }
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
        leaseUntil: null,
        payload: null,
      })
      .where(eq(deliveries.key, key))
  )
}

/** Hands a row back to `pending` so the retry can claim it. */
async function release(kit: Tenancy, { orgId, key }: DeliveryMessage) {
  await kit.withOrg({ orgId }, (db) =>
    db
      .update(deliveries)
      .set({ state: "pending", leaseUntil: null })
      .where(
        sql`${deliveries.key} = ${key} and ${deliveries.state} = 'sending'`
      )
  )
}

/**
 * The hourly sweep's part: queues again the rows the Queue lost, those still
 * `pending` or `sending` past their lease after ten minutes. The claim step
 * makes a message that was not lost harmless.
 */
export async function redriveDeliveries(
  kit: Tenancy,
  env: SendEnv,
  orgId: string
): Promise<number> {
  const stuck = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ payload: deliveries.payload })
      .from(deliveries)
      .where(
        sql`${deliveries.payload} is not null and ${deliveries.createdAt} < now() - ${STUCK_AFTER}::interval and (${deliveries.state} = 'pending' or (${deliveries.state} = 'sending' and ${deliveries.leaseUntil} < now()))`
      )
      .orderBy(deliveries.createdAt)
      .limit(REDRIVE_LIMIT)
  )
  if (stuck.length > 0)
    await env.DELIVERIES.sendBatch(
      stuck.map(({ payload }) => ({ body: payload as DeliveryMessage }))
    )
  return stuck.length
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
  {
    orgId,
    subject,
    text,
    conversationId,
  }: DeliveryMessage & {
    channel: "email"
  }
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
  const token =
    conversationId && env.REPLY_TOKEN_KEY
      ? await replyToken(env.REPLY_TOKEN_KEY, orgId, conversationId)
      : null
  try {
    await env.OWNER_MAIL.send({
      from: OWNER_FROM,
      to,
      ...(token && { replyTo: replyAddress(env.REPLY_MAILBOX, token) }),
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
    // No code is a timeout or a dropped connection after the request may
    // have left, so a resend could be a second email.
    if (typeof raw !== "string") return { state: "unknown", error: code }
    return TRANSIENT.has(code)
      ? { state: "retry", error: code }
      : { state: "failed", error: code }
  }
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
