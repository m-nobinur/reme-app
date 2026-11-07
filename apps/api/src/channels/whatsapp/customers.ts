import type { ServerMessage } from "@workspace/contracts"
import { deliveries, type Tenancy, whatsappAccounts } from "@workspace/db"
import { tell } from "./reply.ts"

/**
 * A customer on a Reme-held number (purchased or dev): the owner is told in
 * the app, and the customer gets one holding reply a day. A Coexistence
 * number is the business's own app, so Reme stays out of it. Both writes are
 * keyed, so a redelivered wamid notifies and replies once.
 */
export async function holdCustomer(
  env: Env,
  kit: Tenancy,
  orgId: string,
  message: { id: string; from: string }
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const held = await kit.withOrg({ orgId }, async (db) => {
    const [account] = await db
      .select({ coexistence: whatsappAccounts.coexistence })
      .from(whatsappAccounts)
    if (!account || account.coexistence) return null
    const notice = {
      orgId,
      key: `customer:${message.id}`,
      channel: "in_app" as const,
      message: {
        // The model reads a notice as its own words, so the customer's text
        // stays out until ServerMessage has a data field for it.
        text: [
          `A customer messaged your WhatsApp number from +${message.from}.`,
        ],
        kind: "note",
      } satisfies Omit<ServerMessage, "id">,
    }
    const fresh = await db
      .insert(deliveries)
      .values({
        orgId,
        key: notice.key,
        channel: notice.channel,
        payload: notice,
      })
      .onConflictDoNothing()
      .returning({ key: deliveries.key })
    if (fresh.length === 0) return null
    // A settled marker with no payload: the sweep never queues it.
    const first = await db
      .insert(deliveries)
      .values({
        orgId,
        key: `customer-held:${message.from}:${day}`,
        channel: "whatsapp",
        state: "sent",
        sentAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ key: deliveries.key })
    return { notice, first: first.length > 0 }
  })
  if (!held) return
  // Unsent, the row waits for the orchestrator's hourly sweep.
  await env.DELIVERIES.send(held.notice).catch(() =>
    console.error(JSON.stringify({ code: "customer.unsent", org_id: orgId }))
  )
  if (held.first)
    await tell(
      env,
      kit,
      orgId,
      message.from,
      (business) => `Thanks for your message. ${business} will reply soon.`
    )
}
