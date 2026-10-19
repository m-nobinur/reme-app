import { buildPushHTTPRequest } from "@pushforge/builder"
import { PUSH_ENDPOINT, type ServerMessage } from "@workspace/contracts"
import {
  conversations,
  eq,
  pushSubscriptions,
  sql,
  type Tenancy,
} from "@workspace/db"

/**
 * Web push for the owner (ADR-043). The outbox sends nothing here by itself:
 * a push is queued only for a message the in-app channel just delivered, under
 * `<in-app key>:push`, so it can never say more than the chat already does.
 * An owner's own turn does not go through the outbox, so it is never pushed.
 */

export type PushDelivery = {
  channel: "push"
  /** The first part of the in-app key: `reminder`, `heartbeat`, `approval`. */
  kind: string
  title: string
  body: string
  /** Seconds the push service keeps it for a device that is off. */
  ttl: number
  /** The conversation to open; the org's newest when absent, as in-app. */
  conversationId?: string
}

type Outcome =
  | { state: "sent" | "suppressed" }
  | { state: "failed" | "retry"; error: string }

const BODY_MAX = 240
const HOUR = 3600
/** A reminder is worth a day; anything else is stale after six hours. */
const TTL = { reminder: 24 * HOUR, other: 6 * HOUR }
/** What a push service gets before the request counts as lost. */
const SEND_TIMEOUT_MS = 10_000

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/**
 * The push to queue for a message the in-app channel delivered, or null: the
 * owner has no subscription, or the message is a `[quiet]` pass, which says
 * nothing happened.
 */
export async function pushFor(
  kit: Tenancy,
  {
    orgId,
    key,
    message,
    conversationId,
  }: {
    orgId: string
    key: string
    message: Omit<ServerMessage, "id">
    conversationId?: string
  }
): Promise<{ key: string; delivery: PushDelivery } | null> {
  if (message.text[0]?.startsWith("[quiet]")) return null
  const [subscribed] = await kit.withOrg({ orgId }, (db) =>
    db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).limit(1)
  )
  if (!subscribed) return null
  const kind = key.split(":")[0] as string
  return {
    key: `${key}:push`,
    delivery: {
      channel: "push",
      kind,
      title: kind === "reminder" ? "Reminder" : "Reme",
      body: clip(message.text.join(" "), BODY_MAX),
      ttl: kind === "reminder" ? TTL.reminder : TTL.other,
      conversationId,
    },
  }
}

/**
 * What the service worker shows. `tag` is one per kind and conversation with
 * `renotify`, so a repeat replaces the earlier one on the device instead of
 * stacking.
 */
export const notification = (push: PushDelivery, conversationId: string) => ({
  title: push.title,
  body: push.body,
  tag: `${push.kind}:${conversationId}`,
  renotify: true,
  url: `/app/c/${conversationId}`,
})

export async function sendPush(
  kit: Tenancy,
  env: { VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT: string },
  orgId: string,
  push: PushDelivery
): Promise<Outcome> {
  if (!env.VAPID_PRIVATE_KEY) return { state: "failed", error: "push_unset" }
  const subs = await kit.withOrg({ orgId }, (db) =>
    db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
  )
  if (subs.length === 0) return { state: "suppressed" }
  const [newest] = push.conversationId
    ? [{ id: push.conversationId }]
    : await kit.withOrg({ orgId }, (db) =>
        db
          .select({ id: conversations.id })
          .from(conversations)
          .where(sql`${conversations.archivedAt} is null`)
          .orderBy(sql`${conversations.updatedAt} desc`)
          .limit(1)
      )
  if (!newest) return { state: "failed", error: "no_conversation" }
  const payload = notification(push, newest.id)
  const privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY)
  const statuses = await Promise.all(
    subs.map(async (sub) => {
      // Re-checked here as well as when saved: the server posts to this address.
      if (!PUSH_ENDPOINT.test(sub.endpoint)) return 410
      try {
        const request = await buildPushHTTPRequest({
          privateJWK,
          subscription: {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          message: {
            payload,
            adminContact: env.VAPID_SUBJECT,
            options: { ttl: push.ttl, urgency: "normal" },
          },
        })
        const response = await fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        })
        await response.body?.cancel()
        return response.status
      } catch {
        return 0
      }
    })
  )
  // A gone subscription will not come back, so it goes on its first failure.
  const gone = subs.filter((_, i) => [404, 410].includes(statuses[i] as number))
  if (gone.length > 0) {
    await kit.withOrg({ orgId }, async (db) => {
      for (const { id } of gone)
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id))
    })
  }
  // One device reached is sent: retrying for the others would buzz that one again.
  if (statuses.some((s) => s >= 200 && s < 300)) return { state: "sent" }
  const retryable = statuses.find((s) => s === 0 || s === 429 || s >= 500)
  if (retryable !== undefined)
    return { state: "retry", error: `push_${retryable}` }
  if (gone.length === subs.length) return { state: "suppressed" }
  return { state: "failed", error: `push_${statuses.find((s) => s >= 400)}` }
}
