import { type ChatRequest, ErrorEnvelope, GOAL_MAX } from "@workspace/contracts"
import {
  channelInbound,
  channelLinks,
  conversations,
  eq,
  type OrgScopedDb,
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
import { type Graph, graphOf, markRead } from "./graph.ts"
import { transcribe } from "./media.ts"
import {
  approvalMessage,
  choiceText,
  type Extra,
  extraOf,
  sendReply,
  sendStale,
  type Tap,
  tapOf,
} from "./reply.ts"
import { releaseHeld, seeUpdate } from "./templates.ts"

/** The webhook's word that a linked owner wrote: ids only, never text. */
export type ChannelJob = { kind: "channel"; orgId: string; linkId: string }

export const isChannelJob = (body: unknown): body is ChannelJob =>
  (body as { kind?: unknown } | null)?.kind === "channel"

/** Meta drops the typing indicator after 25 s. */
const TYPING_RENEW_MS = 20_000

export type ChannelTurn = "ran" | "replayed" | "idle" | "gone"

type Waiting = { id: string; body: Record<string, unknown>; receivedAt: Date }

/** What one turn answers: the owner's words since the last turn, or one tap. */
type Step = { rows: Waiting[]; text: string; tap: Tap | null }

const textOf = ({ body }: Waiting) =>
  body.type === "text"
    ? ((body.text as { body?: unknown } | undefined)?.body as string)
    : undefined

const audioOf = ({ body }: Waiting) =>
  body.type === "audio"
    ? ((body.audio as { id?: unknown } | undefined)?.id as string | undefined)
    : undefined

const UNHEARD =
  "I couldn't make out that voice note. Could you send it again or type it?"

/** A tap stands alone; the words and voice notes between taps gather into one turn. */
function stepsOf(waiting: Waiting[]): Step[] {
  const steps: Step[] = []
  let words: Step | undefined
  for (const row of waiting) {
    const tap = tapOf(row.body)
    if (tap) {
      words = undefined
      steps.push({ rows: [row], text: "", tap })
      continue
    }
    if (!words) {
      words = { rows: [], text: "", tap: null }
      steps.push(words)
    }
    words.rows.push(row)
  }
  return steps
}

/**
 * What the owner sent since the last turn, as CoS turns in the mode a new
 * web conversation starts in, each answered in WhatsApp formatting with its
 * buttons. A tap on Approve or Not now is a results turn; a tap on a quick
 * reply sends that reply's message. A conversation mid-turn throws
 * `SessionBusy`, which the queue retries from the first step not yet done;
 * a turn that already ran on an earlier attempt sends nothing.
 */
export async function channelTurn(
  env: Env,
  kit: Tenancy,
  job: ChannelJob,
  deps: ChatDeps = {}
): Promise<ChannelTurn> {
  const inOrg = <T>(work: (db: OrgScopedDb) => Promise<T>) =>
    kit.withOrg({ orgId: job.orgId }, work)
  const found = await inOrg(async (db) => {
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
  const last = waiting.at(-1)
  if (!last) return "idle"
  const to = link.externalId
  let conversationId = link.conversationId

  /**
   * The turn a step asks for, with the message it continues when it is a
   * results turn: null when it has nothing to say, "stale" when its button
   * is out of date.
   */
  async function turnOf(
    step: Step
  ): Promise<{ turn: ChatRequest["turn"]; from?: UIMessage } | "stale" | null> {
    const { tap } = step
    const message_id = `wa_${await hashCode((step.rows[0] as Waiting).id)}`
    if (!tap) {
      const text = step.text.slice(0, GOAL_MAX)
      return text.trim()
        ? { turn: { kind: "message", message_id, text } }
        : null
    }
    const open = conversationId
    if (!open) return "stale"
    if (tap.kind === "choice") {
      const text = await inOrg((db) => choiceText(db, open, tap))
      return text ? { turn: { kind: "message", message_id, text } } : "stale"
    }
    const card = await inOrg((db) => approvalMessage(db, open, tap.approvalId))
    return card
      ? {
          from: card,
          turn: {
            kind: "results",
            message_id: card.id,
            results: [
              {
                kind: "approval",
                approval_id: tap.approvalId,
                approved: tap.approved,
              },
            ],
          },
        }
      : "stale"
  }

  async function run(step: Step): Promise<ChannelTurn> {
    const heard: string[] = []
    let unheard = false
    if (!step.tap) {
      const lines: string[] = []
      for (const row of step.rows) {
        const mediaId = audioOf(row)
        if (!mediaId) {
          const typed = textOf(row)
          if (typed) lines.push(typed)
          continue
        }
        const words = await transcribe(env, graph, mediaId)
        if (words) {
          heard.push(words)
          lines.push(words)
        } else unheard = true
      }
      step.text = lines.join("\n\n")
      if (unheard && !step.text.trim()) {
        await sendReply(graph, to, UNHEARD, null, () => "")
        return "idle"
      }
    }
    const asked = await turnOf(step)
    if (asked === null) return "idle"
    if (asked === "stale") {
      await sendStale(graph, to)
      return "ran"
    }
    const { turn, from } = asked
    conversationId ??= await openConversation(
      kit,
      owner,
      link.id,
      (step.rows[0] as Waiting).id
    )
    const id = conversationId
    const closing: Promise<unknown>[] = []
    const response = await chat(
      new Request("https://api.invalid/chat", {
        method: "POST",
        body: JSON.stringify({ conversation_id: id, mode: "act", turn }),
      }),
      env,
      kit,
      owner,
      { ...deps, channel: "whatsapp", waitUntil: (p) => closing.push(p) }
    )
    if (response.ok) {
      const reply = await replyOf(response, from)
      await Promise.all(closing)
      await sendReply(
        graph,
        to,
        heard.length
          ? `Heard: “${heard.join(" ").slice(0, 300)}”\n\n${reply.text}`
          : reply.text,
        reply.extra,
        () => new URL(`/app/c/${id}`, env.WEB_ORIGIN).href
      )
      return "ran"
    }
    const refused = ErrorEnvelope.safeParse(await response.json())
    const code = refused.success ? refused.data.code : response.status
    if (code === "chat.busy") throw new SessionBusy(id)
    if (code === "chat.message_exists") return "replayed"
    if (code === "chat.stale" && step.tap) {
      await sendStale(graph, to)
      return "ran"
    }
    throw new Error(`channel.chat_refused:${code}`)
  }

  /** Marks a step's rows done as soon as it is, so a retry never repeats it. */
  const settle = (rows: Waiting[]) =>
    inOrg(async (db) => {
      await db
        .update(channelInbound)
        .set({ processedAt: sql`now()` })
        .where(
          sql`${channelInbound.linkId} = ${link.id} and ${channelInbound.externalMessageId} in ${rows.map((w) => w.id)}`
        )
      await db
        .update(channelLinks)
        .set({
          lastInboundAt: sql`greatest(${channelLinks.lastInboundAt}, ${(rows.at(-1) as Waiting).receivedAt.toISOString()}::timestamptz)`,
        })
        .where(eq(channelLinks.id, link.id))
    })

  const typing = keepTyping(graph, last.id)
  const outcomes: ChannelTurn[] = []
  try {
    for (const step of stepsOf(waiting)) {
      outcomes.push(await run(step))
      await settle(step.rows)
    }
  } finally {
    clearInterval(typing)
  }
  // After the window opened above, so the held updates go as text.
  if (waiting.some((w) => seeUpdate(w.body))) {
    await releaseHeld(env, kit, job.orgId, link.id)
  }
  return outcomes.includes("ran")
    ? "ran"
    : outcomes.includes("replayed")
      ? "replayed"
      : "idle"
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

/**
 * The reply's words, every text part the turn streamed, and what it asks
 * next. A results turn streams on top of the message `from`, whose own
 * parts were sent when it was new.
 */
async function replyOf(
  response: Response,
  from?: UIMessage
): Promise<{ text: string; extra: Extra }> {
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
  for await (const each of readUIMessageStream({
    message: from && structuredClone(from),
    stream: chunks,
  })) {
    message = each
  }
  const text = (message?.parts ?? [])
    .slice(from?.parts.length ?? 0)
    .flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : []))
    .join("\n\n")
  return { text, extra: message ? extraOf(message, text !== "") : null }
}
