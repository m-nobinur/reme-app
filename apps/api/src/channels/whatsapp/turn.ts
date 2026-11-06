import { ErrorEnvelope, GOAL_MAX } from "@workspace/contracts"
import {
  channelInbound,
  channelLinks,
  conversations,
  eq,
  sql,
  type Tenancy,
} from "@workspace/db"
import {
  parseJsonEventStream,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  uiMessageChunkSchema,
} from "ai"
import type { Owner } from "../../changes.ts"
import { type ChatDeps, chat } from "../../chat.ts"
import { ownerOf } from "../../continue.ts"
import { SessionBusy } from "../../cos/turns.ts"
import { ownerStaffId } from "../../staff.ts"
import { hashCode } from "../token.ts"
import { splitText, whatsAppText } from "./format.ts"
import {
  type Graph,
  GraphFailed,
  graphOf,
  markRead,
  sendText,
} from "./graph.ts"
import { releaseHeld, seeUpdate } from "./templates.ts"

/** The webhook's word that a linked owner wrote: ids only, never text. */
export type ChannelJob = { kind: "channel"; orgId: string; linkId: string }

export const isChannelJob = (body: unknown): body is ChannelJob =>
  (body as { kind?: unknown } | null)?.kind === "channel"

/** Meta drops the typing indicator after 25 s. */
const TYPING_RENEW_MS = 20_000

export type ChannelTurn = "ran" | "replayed" | "idle" | "gone"

type Waiting = { id: string; body: Record<string, unknown>; receivedAt: Date }

const textOf = ({ body }: Waiting) =>
  body.type === "text"
    ? ((body.text as { body?: unknown } | undefined)?.body as string)
    : undefined

/**
 * Every message the owner sent since the last turn, as one CoS turn in the
 * mode a new web conversation starts in, and its words sent back as one
 * WhatsApp message. A conversation mid-turn throws `SessionBusy`, which the
 * queue retries; a turn that already ran on an earlier attempt sends nothing.
 */
export async function channelTurn(
  env: Env,
  kit: Tenancy,
  job: ChannelJob,
  deps: ChatDeps = {}
): Promise<ChannelTurn> {
  const found = await kit.withOrg({ orgId: job.orgId }, async (db) => {
    const [link] = await db
      .select()
      .from(channelLinks)
      .where(
        sql`${channelLinks.id} = ${job.linkId} and ${channelLinks.revokedAt} is null`
      )
    if (!link) return null
    const person = await ownerOf(
      db,
      job.orgId,
      `whatsapp:${link.id}`,
      link.userId
    )
    if (!person) return null
    const graph = await graphOf(env, db, job.orgId)
    if (!graph) return null
    const waiting: Waiting[] = await db
      .select({
        id: channelInbound.externalMessageId,
        body: channelInbound.body,
        receivedAt: channelInbound.receivedAt,
      })
      .from(channelInbound)
      .where(
        sql`${channelInbound.linkId} = ${link.id} and ${channelInbound.processedAt} is null`
      )
      .orderBy(channelInbound.receivedAt, channelInbound.externalMessageId)
    return { link, ...person, graph, waiting }
  })
  if (!found) return "gone"
  const { link, owner, graph, waiting } = found
  const first = waiting[0]
  const last = waiting.at(-1)
  if (!first || !last) return "idle"
  // shortcut: voice notes, photos and taps wait for their own stories; text only.
  const text = waiting
    .flatMap((w) => textOf(w) ?? [])
    .join("\n\n")
    .slice(0, GOAL_MAX)
  const typing = keepTyping(graph, last.id)
  let outcome: ChannelTurn = "idle"
  try {
    if (text.trim()) {
      const conversationId =
        link.conversationId ??
        (await openConversation(kit, owner, link.id, first.id))
      const closing: Promise<unknown>[] = []
      const response = await chat(
        new Request("https://api.invalid/chat", {
          method: "POST",
          body: JSON.stringify({
            conversation_id: conversationId,
            mode: "act",
            turn: {
              kind: "message",
              message_id: `wa_${await hashCode(first.id)}`,
              text,
            },
          }),
        }),
        env,
        kit,
        owner,
        { ...deps, waitUntil: (p) => closing.push(p) }
      )
      if (response.ok) {
        const reply = await replyOf(response)
        await Promise.all(closing)
        await send(graph, link.externalId, reply)
        outcome = "ran"
      } else {
        const refused = ErrorEnvelope.safeParse(await response.json())
        const code = refused.success ? refused.data.code : response.status
        if (code === "chat.busy") throw new SessionBusy(conversationId)
        if (code !== "chat.message_exists") {
          throw new Error(`channel.chat_refused:${code}`)
        }
        outcome = "replayed"
      }
    }
  } finally {
    clearInterval(typing)
  }
  await kit.withOrg({ orgId: job.orgId }, async (db) => {
    await db
      .update(channelInbound)
      .set({ processedAt: sql`now()` })
      .where(
        sql`${channelInbound.linkId} = ${link.id} and ${channelInbound.externalMessageId} in ${waiting.map((w) => w.id)}`
      )
    await db
      .update(channelLinks)
      .set({
        lastInboundAt: sql`greatest(${channelLinks.lastInboundAt}, ${last.receivedAt.toISOString()}::timestamptz)`,
      })
      .where(eq(channelLinks.id, link.id))
  })
  // After the window opened above, so the held updates go as text.
  if (waiting.some((w) => seeUpdate(w.body))) {
    await releaseHeld(env, kit, job.orgId, link.id)
  }
  return outcome
}

/** Read receipt and typing now, renewed until the reply goes. */
function keepTyping(graph: Graph, messageId: string) {
  const mark = () =>
    markRead(graph, messageId).catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          code: "whatsapp.typing_failed",
          graph: error instanceof Error ? error.message : "unknown",
        })
      )
    )
  void mark()
  return setInterval(mark, TYPING_RENEW_MS)
}

/** The link's first conversation, made once: a retry finds it by its key. */
async function openConversation(
  kit: Tenancy,
  owner: Owner,
  linkId: string,
  firstId: string
): Promise<string> {
  const scope = {
    orgId: owner.orgId,
    workosUserId: owner.session.workosUserId,
  }
  return kit.withOrg(scope, async (db) => {
    const key = `whatsapp:${firstId}`
    await db
      .insert(conversations)
      .values({
        orgId: owner.orgId,
        kind: "assistant",
        createdByStaffId: (await ownerStaffId(db, {
          ...scope,
          ownerName: owner.session.name ?? owner.session.email,
        })) as string,
        idempotencyKey: key,
      })
      .onConflictDoNothing()
    const [pointed] = await db
      .update(channelLinks)
      .set({
        conversationId: sql`coalesce(${channelLinks.conversationId}, (select id from ${conversations} where idempotency_key = ${key}))`,
      })
      .where(eq(channelLinks.id, linkId))
      .returning({ id: channelLinks.conversationId })
    return pointed?.id as string
  })
}

/** The reply's words, every text part of the message the turn streamed. */
async function replyOf(response: Response): Promise<string> {
  const chunks = parseJsonEventStream({
    stream: response.body as ReadableStream<Uint8Array>,
    schema: uiMessageChunkSchema(),
  }).pipeThrough(
    new TransformStream<{ success: boolean; value?: unknown }, UIMessageChunk>({
      transform(part, out) {
        if (part.success) out.enqueue(part.value as UIMessageChunk)
      },
    })
  )
  let message: UIMessage | undefined
  for await (const each of readUIMessageStream({ stream: chunks })) {
    message = each
  }
  return (message?.parts ?? [])
    .flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : []))
    .join("\n\n")
}

async function send(graph: Graph, to: string, reply: string): Promise<void> {
  if (!reply) return
  try {
    for (const part of splitText(whatsAppText(reply))) {
      await sendText(graph, to, part)
    }
  } catch (error) {
    // The reply is on the web either way; a resend would repeat its first part.
    if (!(error instanceof GraphFailed)) throw error
    console.error(
      JSON.stringify({ code: "whatsapp.reply_failed", graph: error.message })
    )
  }
}
