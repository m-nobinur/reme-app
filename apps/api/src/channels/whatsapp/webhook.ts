import {
  channelInbound,
  channelLinkOf,
  channelLinks,
  eq,
  orgs,
  redeemChannelCode,
  sql,
  type Tenancy,
  whatsAppAccountByPhone,
} from "@workspace/db"
import { z } from "zod"
import { holdsNul } from "../../conversations.ts"
import { boundedBody } from "../../http.ts"
import { same } from "../../stripe.ts"
import { hashCode } from "../token.ts"
import { holdCustomer } from "./customers.ts"
import { GraphFailed, graphOf, markRead, sendText } from "./graph.ts"
import { sayGoodbye, tapOf, tell } from "./reply.ts"
import type { ChannelJob } from "./turn.ts"

export const WEBHOOK_PATH = "/channels/whatsapp/webhook"

/** Meta's own cap on a webhook body. */
const BODY_CAP = 3 * 1024 * 1024
/** How long quick messages gather before their turn starts. */
const GATHER_SECONDS = 2
/** What the settings page's link puts in the owner's WhatsApp: 24 bytes, base64url. */
const CODE = /^Connect Reme ([A-Za-z0-9_-]{32})$/
/** The owner's two words to Reme itself, as `new` or `*new*`. */
const COMMAND = /^[\s*/]*(new|stop)[\s*]*$/i

export const whatsAppEnabled = (env: Env) => env.WHATSAPP_ENABLED === "1"

const Payload = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            messages: z.array(z.record(z.string(), z.unknown())).optional(),
          }),
        })
      ),
    })
  ),
})

const Message = z.object({
  from: z.string().regex(/^\d{1,32}$/),
  id: z.string().min(1).max(200),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
})
type Message = z.infer<typeof Message>

const status = (code: number) => new Response(null, { status: code })

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

/** `X-Hub-Signature-256`: `sha256=` and the app secret's HMAC of the raw body. */
async function signed(
  raw: Uint8Array,
  header: string | null,
  secret: string
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const expected = hex(await crypto.subtle.sign("HMAC", key, raw))
  return same(header.slice(7).toLowerCase(), expected)
}

/** A masked number for the settings list, as `+44 7•••• ••1234`. */
const masked = (waId: string) =>
  `+${waId.slice(0, 2)} ${waId.slice(2, 3)}•••• ••${waId.slice(-4)}`

/**
 * Meta's webhook for every business number, ahead of any session: the
 * verify handshake, then signed message deliveries. A signed delivery is
 * answered 200 once its messages are stored, so Meta does not send it again;
 * a failure before that is a 503, and the redelivery is deduped by wamid.
 */
export async function whatsAppWebhook(
  request: Request,
  env: Env,
  kit: Tenancy,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<Response | null> {
  if (!whatsAppEnabled(env)) return null
  if (request.method === "GET") return verify(new URL(request.url), env)
  if (request.method !== "POST") return null
  const secret = env.WHATSAPP_APP_SECRET
  if (!secret) return status(503)
  const raw = await boundedBody(request, BODY_CAP)
  if (!raw) return status(413)
  if (
    !(await signed(raw, request.headers.get("x-hub-signature-256"), secret))
  ) {
    return status(401)
  }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return status(400)
  }
  const parsed = Payload.safeParse(body)
  if (!parsed.success) return status(200)
  for (const { changes } of parsed.data.entry) {
    for (const { field, value } of changes) {
      const phone = value.metadata?.phone_number_id
      if (field !== "messages" || !phone || !value.messages) continue
      const account = await whatsAppAccountByPhone(kit, phone)
      if (!account) continue
      for (const each of value.messages) {
        const message = Message.safeParse(each)
        if (message.success && !holdsNul(each)) {
          await receive(env, kit, account, message.data, each, waitUntil)
        }
      }
    }
  }
  return status(200)
}

function verify(url: URL, env: Env): Response {
  const token = env.WHATSAPP_VERIFY_TOKEN
  if (!token) return status(503)
  const q = url.searchParams
  const challenge = q.get("hub.challenge")
  if (q.get("hub.mode") !== "subscribe" || !challenge) return status(400)
  if (!same(q.get("hub.verify_token") ?? "", token)) return status(403)
  return new Response(challenge, { headers: { "content-type": "text/plain" } })
}

async function receive(
  env: Env,
  kit: Tenancy,
  account: { accountId: string; orgId: string },
  message: Message,
  raw: Record<string, unknown>,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<void> {
  const { accountId } = account
  const allowed = await env.CHANNEL_LIMIT?.limit({
    key: `whatsapp:${message.from}`,
  })
  if (allowed && !allowed.success) return
  const code = CODE.exec(message.text?.body.trim() ?? "")?.[1]
  if (code) return redeem(env, kit, accountId, message.from, code)
  const link = await channelLinkOf(kit, accountId, message.from)
  if (!link) return holdCustomer(env, kit, account.orgId, message)
  const word = COMMAND.exec(message.text?.body ?? "")?.[1]?.toLowerCase()
  if (word) return command(env, kit, link, message.id, message.from, raw, word)
  // A list pick or a tap on a button we did not send has nothing to answer.
  if (message.type === "interactive" && !tapOf(raw)) return
  const graph = await kit.withOrg({ orgId: link.orgId }, async (db) => {
    await db
      .insert(channelInbound)
      .values({
        orgId: link.orgId,
        kind: "whatsapp",
        externalMessageId: message.id,
        linkId: link.linkId,
        body: raw,
      })
      .onConflictDoNothing()
    return graphOf(env, db, link.orgId)
  })
  // Ticks and typing as it lands; the turn waits out the gathering first.
  if (graph)
    waitUntil(
      markRead(graph, message.id).catch((error: unknown) =>
        console.warn(
          JSON.stringify({
            code: "whatsapp.typing_failed",
            graph: error instanceof Error ? error.message : "unknown",
          })
        )
      )
    )
  // Sent for a redelivery too: the turn takes only rows still waiting.
  const job: ChannelJob = {
    kind: "channel",
    orgId: link.orgId,
    linkId: link.linkId,
  }
  await env.AFTER_TURN.send(job, { delaySeconds: GATHER_SECONDS })
}

/**
 * *new* points the link at a fresh conversation and *stop* ends the link.
 * The word is stored already processed, so a redelivery acts once and a
 * waiting message never reads it as a question.
 */
async function command(
  env: Env,
  kit: Tenancy,
  link: { linkId: string; orgId: string },
  messageId: string,
  from: string,
  raw: Record<string, unknown>,
  word: string
): Promise<void> {
  const first = await kit.withOrg({ orgId: link.orgId }, async (db) => {
    const stored = await db
      .insert(channelInbound)
      .values({
        orgId: link.orgId,
        kind: "whatsapp",
        externalMessageId: messageId,
        linkId: link.linkId,
        body: raw,
        processedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning({ id: channelInbound.externalMessageId })
    if (stored.length === 0) return false
    await db
      .update(channelLinks)
      .set(
        word === "stop" ? { revokedAt: sql`now()` } : { conversationId: null }
      )
      .where(eq(channelLinks.id, link.linkId))
    return true
  })
  if (!first) return
  if (word === "stop") {
    return sayGoodbye(env, kit, link.orgId, from, new Date())
  }
  return tell(env, kit, link.orgId, from, () => "Started a new conversation.")
}

/** A stranger's code, or a spent one, gets no answer. */
async function redeem(
  env: Env,
  kit: Tenancy,
  accountId: string,
  from: string,
  code: string
): Promise<void> {
  const link = await redeemChannelCode(kit, {
    hash: await hashCode(code),
    accountId,
    externalId: from,
    label: masked(from),
  })
  if (!link) return
  const found = await kit.withOrg({ orgId: link.orgId }, async (db) => {
    const [org] = await db.select({ name: orgs.name }).from(orgs)
    const graph = await graphOf(env, db, link.orgId)
    return org && graph ? { name: org.name, graph } : null
  })
  if (!found) return
  try {
    await sendText(
      found.graph,
      from,
      `You're connected to ${found.name}. Message me here any time.`
    )
  } catch (error) {
    if (!(error instanceof GraphFailed)) throw error
    console.error(
      JSON.stringify({ code: "whatsapp.welcome_failed", graph: error.message })
    )
  }
}
