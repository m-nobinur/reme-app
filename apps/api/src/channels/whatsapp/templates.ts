import {
  afterQuiet,
  channelLinks,
  deliveries,
  eq,
  inQuiet,
  nextRun,
  orgs,
  sql,
  type Tenancy,
} from "@workspace/db"
import { splitText, whatsAppText } from "./format.ts"
import {
  call,
  type Graph,
  GraphFailed,
  graphOf,
  OUTSIDE_WINDOW,
  sendTemplate,
  sendText,
} from "./graph.ts"

/**
 * Updates outside the 24-hour window. The orchestrator hands over each
 * `in_app` delivery for an owner's linked chat as a `whatsapp` outbox row;
 * this sends it as text while the window is open. Once it is closed, the
 * first update of the org's day sends the `reme_update` template and every
 * update is held: the row stays `sending` with its lease at the next end of
 * quiet hours, so the hourly redrive brings it back as the morning summary.
 * The owner's "See update" tap opens the window and sends what was held.
 */

export const UPDATE_TEMPLATE = "reme_update"
const LANGUAGE = "en_GB"
/** The template's quick reply, as it comes back on the owner's tap. */
export const SEE_UPDATE = "see_update"

/** Meta refuses a body that ends with a variable, hence the full stop. */
const DEFINITION = {
  name: UPDATE_TEMPLATE,
  language: LANGUAGE,
  category: "UTILITY",
  components: [
    {
      type: "BODY",
      text: "You have an update from Reme about {{1}}.",
      example: { body_text: [["a reminder"]] },
    },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "See update" }] },
  ],
}

/** What `{{1}}` says, by the in-app key's kind: never the update's own words. */
const ABOUT: Record<string, string> = {
  reminder: "a reminder",
  enquiry: "a new enquiry",
}

/** Ten minutes short of Meta's 24 hours, so a text never races the close. */
const WINDOW = "23 hours 50 minutes"
/** As the orchestrator's: bounds how long a dead consumer holds a row. */
const LEASE = "5 minutes"
/** A held update older than this is stale and dropped. */
const KEEP = "3 days"

/** An `in_app` delivery the orchestrator handed over for one linked chat. */
export type WhatsAppUpdate = {
  channel: "whatsapp"
  orgId: string
  key: string
  linkId: string
  /** The in-app key's first part: `reminder`, `heartbeat`, `wake`. */
  kind: string
  text: string
}

export const isWhatsAppUpdate = (body: unknown): body is WhatsAppUpdate =>
  (body as { channel?: unknown } | null)?.channel === "whatsapp"

/** Whether an inbound message is the owner's tap on the template's button. */
export const seeUpdate = (body: Record<string, unknown>) =>
  body.type === "button" &&
  (body.button as { payload?: unknown } | undefined)?.payload === SEE_UPDATE

/** Creates the templates on a business's WABA unless it has them. */
export async function ensureTemplates(
  graph: Graph,
  wabaId: string
): Promise<void> {
  const found = await call<{ data: { name: string }[] }>(
    graph,
    `${wabaId}/message_templates?name=${UPDATE_TEMPLATE}&fields=name`
  )
  if (!found.data.some((t) => t.name === UPDATE_TEMPLATE)) {
    await call(graph, `${wabaId}/message_templates`, DEFINITION)
  }
}

export type UpdateSent =
  | "text"
  | "template"
  | "held"
  /** Another consumer holds the row, or it is settled. */
  | "busy"
  /** The link is revoked, its updates are off, or the number is gone. */
  | "gone"
  | "expired"
  | "failed"

export async function sendUpdate(
  env: Pick<Env, "CHANNEL_TOKEN_KEY">,
  kit: Tenancy,
  update: WhatsAppUpdate
): Promise<UpdateSent> {
  const { orgId, key, linkId } = update
  const found = await kit.withOrg({ orgId }, async (db) => {
    const [claimed] = await db
      .update(deliveries)
      .set({
        state: "sending",
        attempts: sql`${deliveries.attempts} + 1`,
        leaseUntil: sql`now() + ${LEASE}::interval`,
      })
      .where(
        sql`${deliveries.key} = ${key} and (${deliveries.state} = 'pending' or (${deliveries.state} = 'sending' and ${deliveries.leaseUntil} < now()))`
      )
      .returning({
        stale: sql<boolean>`${deliveries.createdAt} < now() - ${KEEP}::interval`,
      })
    if (!claimed) return null
    const [chat] = await db
      .select({
        to: channelLinks.externalId,
        open: sql<boolean>`coalesce(${channelLinks.lastInboundAt} > now() - ${WINDOW}::interval, false)`,
        zone: orgs.timeZone,
        start: orgs.quietStart,
        end: orgs.quietEnd,
      })
      .from(channelLinks)
      .innerJoin(orgs, eq(orgs.id, channelLinks.orgId))
      .where(
        sql`${channelLinks.id} = ${linkId} and ${channelLinks.revokedAt} is null and ${channelLinks.updates}`
      )
    const graph = chat ? await graphOf(env, db, orgId) : null
    return { stale: claimed.stale, chat, graph }
  })
  if (!found) return "busy"
  const { chat, graph } = found
  const settle = (state: "sent" | "suppressed" | "failed", error?: string) =>
    kit.withOrg({ orgId }, (db) =>
      db
        .update(deliveries)
        .set({
          state,
          error: error ?? null,
          sentAt: state === "sent" ? sql`now()` : null,
          leaseUntil: null,
          payload: null,
        })
        .where(eq(deliveries.key, key))
    )
  const hold = (until: Date) =>
    kit.withOrg({ orgId }, (db) =>
      db
        .update(deliveries)
        .set({ leaseUntil: until })
        .where(eq(deliveries.key, key))
    )
  if (!chat || !graph) {
    await settle("suppressed")
    return "gone"
  }
  if (found.stale) {
    await settle("failed", "whatsapp_expired")
    return "expired"
  }
  if (chat.open) {
    try {
      for (const part of splitText(whatsAppText(update.text))) {
        await sendText(graph, chat.to, part)
      }
      await settle("sent")
      return "text"
    } catch (error) {
      if (!(error instanceof GraphFailed)) throw error
      // A part already sent would repeat, so only a closed window tries again.
      if (error.code !== OUTSIDE_WINDOW) {
        await settle("failed", error.message)
        return "failed"
      }
    }
  }
  const now = new Date()
  const quiet = { start: chat.start, end: chat.end }
  // A reminder's time is the owner's own, as in-app.
  if (update.kind !== "reminder" && inQuiet(now, chat.zone, quiet)) {
    await hold(afterQuiet(now, chat.zone, quiet))
    return "held"
  }
  const [h, m] = chat.end.split(":").map(Number)
  const morning = nextRun(`${m} ${h} * * *`, chat.zone, now)
  const day = now.toLocaleDateString("en-CA", { timeZone: chat.zone ?? "UTC" })
  const dayKey = `whatsapp-template:${linkId}:${day}`
  const first = await kit.withOrg({ orgId }, (db) =>
    db
      .insert(deliveries)
      .values({
        orgId,
        key: dayKey,
        channel: "whatsapp",
        state: "sent",
        sentAt: now,
      })
      .onConflictDoNothing()
      .returning({ key: deliveries.key })
  )
  if (first.length > 0) {
    try {
      await sendTemplate(graph, chat.to, {
        name: UPDATE_TEMPLATE,
        language: { code: LANGUAGE },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: ABOUT[update.kind] ?? "your business" },
            ],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{ type: "payload", payload: SEE_UPDATE }],
          },
        ],
      })
    } catch (error) {
      if (!(error instanceof GraphFailed)) throw error
      await kit.withOrg({ orgId }, (db) =>
        db.delete(deliveries).where(eq(deliveries.key, dayKey))
      )
      await settle("failed", error.message)
      return "failed"
    }
  }
  await hold(morning)
  return first.length > 0 ? "template" : "held"
}

/**
 * The owner's tap opened the window: every update held for this chat goes
 * now. A held row's lease runs past an ordinary claim's, which tells the two
 * apart.
 */
export async function releaseHeld(
  env: Pick<Env, "AFTER_TURN">,
  kit: Tenancy,
  orgId: string,
  linkId: string
): Promise<void> {
  const held = await kit.withOrg({ orgId }, (db) =>
    db
      .update(deliveries)
      .set({ leaseUntil: sql`now()` })
      .where(
        sql`${deliveries.channel} = 'whatsapp' and ${deliveries.state} = 'sending' and ${deliveries.payload}->>'linkId' = ${linkId} and ${deliveries.leaseUntil} > now() + ${LEASE}::interval`
      )
      .returning({ payload: deliveries.payload })
  )
  if (held.length > 0) {
    await env.AFTER_TURN.sendBatch(
      held.map(({ payload }) => ({ body: payload as WhatsAppUpdate }))
    )
  }
}
