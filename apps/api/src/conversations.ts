import {
  Conversation,
  ConversationHistory,
  ConversationList,
  ConversationMessage,
  ConversationPatch,
  CosFeedback,
  MessageFeedback,
  type MessageRating,
  Uuid,
} from "@workspace/contracts"
import {
  appendEvent,
  conversationMessages,
  conversations,
  eq,
  events,
  failureCode,
  type OrgScopedDb,
  sql,
  type Tenancy,
} from "@workspace/db"
import type { Owner } from "./changes.ts"
import {
  constraint,
  eventKey,
  failure,
  idempotencyKey,
  invalid,
  keyMissing,
  readBody,
  withoutProviderData,
} from "./http.ts"
import { ownerStaffId } from "./staff.ts"

/**
 * The owner's conversations. Every read and write runs under the session's
 * org, and a conversation is looked up under that org before anything is
 * written to it, so another org's id is a 404 and never a constraint error
 * that would say whether it exists.
 */

/** The longest list the thread rail gets, newest first. */
const LIST_MAX = 50

export const notFound = () =>
  failure(404, {
    class: "resource",
    code: "conversation.not_found",
    message: "No conversation with that id in this business.",
    detail: {},
  })

type Row = typeof conversations.$inferSelect

const toConversation = (row: Row): Conversation =>
  Conversation.parse({
    id: row.id,
    kind: row.kind,
    title: row.title,
    archived_at: row.archivedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  })

/** The org's conversation with this id, or null for one it does not hold. */
async function find(db: OrgScopedDb, id: string): Promise<Row | null> {
  if (!Uuid.safeParse(id).success) return null
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
  return row ?? null
}

async function list(kit: Tenancy, owner: Owner) {
  const rows = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    db
      .select()
      .from(conversations)
      .orderBy(sql`${conversations.updatedAt} desc, ${conversations.id} desc`)
      .limit(LIST_MAX)
  )
  return Response.json(
    ConversationList.parse({ conversations: rows.map(toConversation) })
  )
}

/**
 * An assistant conversation, keyed by the client's thread id: a retry finds
 * the row the first attempt made. The body is not read; the kind is always
 * `assistant`, since the server makes the onboarding row itself.
 */
async function create(request: Request, kit: Tenancy, owner: Owner) {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const row = await kit.withOrg(
    { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
    async (db) => {
      const [made] = await db
        .insert(conversations)
        .values({
          orgId: owner.orgId,
          kind: "assistant",
          createdByStaffId: (await ownerStaffId(db, {
            orgId: owner.orgId,
            workosUserId: owner.session.workosUserId,
            ownerName: owner.session.name ?? owner.session.email,
          })) as string,
          idempotencyKey: key,
        })
        .onConflictDoNothing()
        .returning()
      if (made) return made
      const [kept] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.idempotencyKey, key))
      return kept
    }
  )
  return Response.json(toConversation(row as Row), { status: 201 })
}

/**
 * A rename or an archive toggle. A title is kept on one line with single
 * spaces; the contract has already held it to 1 to 120 characters with
 * something in them, and collapsing spaces keeps it there. Setting what is
 * already set writes nothing, so a retry leaves the times alone.
 */
async function patch(request: Request, kit: Tenancy, owner: Owner, id: string) {
  if (!idempotencyKey(request)) return keyMissing()
  const parsed = ConversationPatch.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const change = parsed.data
  // Postgres refuses NUL in text, and a refusal there would be a 500.
  if ("title" in change && change.title.includes("\u0000")) {
    return invalid([{ path: ["title"] }])
  }
  const row = await kit.withOrg({ orgId: owner.orgId }, async (db) => {
    const held = await find(db, id)
    if (!held) return null
    if ("title" in change) {
      const title = change.title.replace(/\s+/g, " ").trim()
      if (held.title === title) return held
      // The database's clock, as every write of `updated_at` takes it, so
      // the list orders one clock's times.
      const [renamed] = await db
        .update(conversations)
        .set({ title, updatedAt: sql`now()` })
        .where(eq(conversations.id, held.id))
        .returning()
      return renamed ?? held
    }
    if ((held.archivedAt !== null) === change.archived) return held
    // The list is by last activity, so archiving leaves `updated_at` alone:
    // tidying old threads must not push active ones off it.
    const [toggled] = await db
      .update(conversations)
      .set({
        archivedAt: change.archived ? new Date() : null,
        updatedAt: held.updatedAt,
      })
      .where(eq(conversations.id, held.id))
      .returning()
    return toggled ?? held
  })
  return row ? Response.json(toConversation(row)) : notFound()
}

/**
 * A message as it is stored: the contract's, less the date and the rating
 * added on read.
 */
export type StoredMessage = Omit<
  ConversationMessage,
  "content" | "feedback"
> & {
  content: Omit<ConversationMessage["content"], "metadata">
}

type MessageRow = typeof conversationMessages.$inferSelect

/**
 * The one place a stored message becomes the contract's: the date assistant-ui
 * reads as `metadata.custom.createdAt` comes from the row's `created_at`, and
 * an assistant row's latest rating from its `cos.feedback` events.
 */
function toConversationMessage(
  row: MessageRow,
  rating: MessageRating | null = null
): ConversationMessage {
  const { role, parts } = row.content as StoredMessage["content"]
  return {
    id: row.id,
    parent_id: row.parentId,
    format: row.format as ConversationMessage["format"],
    content: {
      role,
      // A row written before the provider's data was stripped still holds it.
      parts: parts.map((part) => withoutProviderData(part)),
      metadata: { custom: { createdAt: row.createdAt.toISOString() } },
    },
    feedback: role === "assistant" ? rating : null,
  }
}

async function history(kit: Tenancy, owner: Owner, id: string) {
  const rows = await kit.withOrg({ orgId: owner.orgId }, async (db) => {
    const held = await find(db, id)
    if (!held) return null
    // Each row's latest rating in the same statement: the newest
    // `cos.feedback` for it, by the database's clock.
    // ponytail: the org's feedback events are scanned per row; an expression
    // index on (payload->>'conversation_id') when this shows in the slow log.
    return db
      .select({
        row: conversationMessages,
        rating: sql<MessageRating | null>`(
          select e.payload->>'rating' from ${events} e
          where e.org_id = ${conversationMessages.orgId}
            and e.type = 'cos.feedback'
            and e.payload->>'conversation_id' = ${held.id}::text
            and e.payload->>'message_id' = ${conversationMessages.id}
          order by e.recorded_at desc, e.event_id desc
          limit 1)`,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, held.id))
      .orderBy(conversationMessages.seq)
  })
  if (!rows) return notFound()
  return Response.json(
    ConversationHistory.parse({
      messages: rows.map(({ row, rating }) =>
        toConversationMessage(row, rating)
      ),
    })
  )
}

/** A message as the writer takes it: the contract's, less the date and rating. */
const Stored = ConversationMessage.omit({ feedback: true }).extend({
  content: ConversationMessage.shape.content.omit({ metadata: true }),
})

const messageInvalid = () =>
  failure(400, {
    class: "validation",
    code: "message.invalid",
    message: "A message does not match the contract.",
    detail: {},
  })

/** Whether a value holds NUL anywhere, keys included: Postgres refuses it. */
export const holdsNul = (value: unknown) => {
  let nul = false
  JSON.stringify(value, (key, each) => {
    if (
      key.includes("\0") ||
      (typeof each === "string" && each.includes("\0"))
    ) {
      nul = true
    }
    return each
  })
  return nul
}

/**
 * Writes a turn's messages in the order given, the owner's before the reply,
 * each as its own statement so `seq` follows that order. Every message is
 * checked against the contract first, so a row a history read would refuse is
 * never stored. A message already stored is left as it is, and the
 * conversation moves to the top of the list only when a row was written, so a
 * retried turn changes nothing. All or nothing: a message naming a parent the
 * conversation never stored (after a failed stream, say) is a validation
 * error and none of the turn is kept. Null when written.
 */
export async function appendMessages(
  kit: Tenancy,
  orgId: string,
  conversationId: string,
  messages: StoredMessage[]
): Promise<Response | null> {
  if (
    messages.some((m) => !Stored.safeParse(m).success) ||
    holdsNul(messages)
  ) {
    return messageInvalid()
  }
  try {
    const held = await kit.withOrg({ orgId }, async (db) => {
      const conversation = await find(db, conversationId)
      if (!conversation) return false
      let wrote = false
      for (const message of messages) {
        const written = await db
          .insert(conversationMessages)
          .values({
            conversationId: conversation.id,
            id: message.id,
            orgId,
            parentId: message.parent_id,
            format: message.format,
            content: message.content,
          })
          .onConflictDoNothing()
          .returning({ id: conversationMessages.id })
        wrote ||= written.length > 0
      }
      if (wrote) {
        // The database's clock, never the Worker's: the list compares this
        // with times the database set, and two clocks drift apart.
        await db
          .update(conversations)
          .set({ updatedAt: sql`now()` })
          .where(eq(conversations.id, conversation.id))
      }
      return true
    })
    return held ? null : notFound()
  } catch (error) {
    const { code, name } = constraint(error)
    if (code === "23503" && name === "conversation_messages_parent_fk") {
      return failure(400, {
        class: "validation",
        code: "message.parent_unknown",
        message: "A message names a parent this conversation does not hold.",
        detail: {},
      })
    }
    // The table's own checks: a message that is its own parent.
    if (code === "23514") return messageInvalid()
    throw error
  }
}

const messageNotFound = () =>
  failure(404, {
    class: "resource",
    code: "message.not_found",
    message: "No reply with that id in this conversation.",
    detail: {},
  })

/**
 * The owner's thumb on one of the CoS's replies: an assistant row of this
 * conversation with text in it. It is appended as a `cos.feedback` event
 * with no session, so it takes no turn lock and no seq, never waits on a
 * turn, and never reaches the model. Each press carries its own
 * Idempotency-Key, kept as the event's key, so a replay writes nothing and
 * still answers 204. The latest rating recorded wins.
 */
async function feedback(
  request: Request,
  kit: Tenancy,
  owner: Owner,
  id: string
) {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const parsed = MessageFeedback.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  const { message_id: messageId, rating } = parsed.data
  const keyed = await eventKey("cos.feedback", key)
  try {
    const found = await kit.withOrg({ orgId: owner.orgId }, async (db) => {
      const held = await find(db, id)
      if (!held) return notFound()
      const [row] = await db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
        .where(
          sql`${conversationMessages.conversationId} = ${held.id} and ${conversationMessages.id} = ${messageId}`
        )
      const content = row?.content as StoredMessage["content"] | undefined
      if (
        content?.role !== "assistant" ||
        !content.parts.some((part) => part.type === "text")
      ) {
        return messageNotFound()
      }
      await appendEvent(db, {
        orgId: owner.orgId,
        assignmentId: null,
        staffId: null,
        type: "cos.feedback",
        payload: CosFeedback.parse({
          conversation_id: held.id,
          message_id: messageId,
          rating,
        }),
        idempotencyKey: keyed,
      })
      return null
    })
    return found ?? new Response(null, { status: 204 })
  } catch (error) {
    const { code, name } = constraint(error)
    // The same press again: its rating is already recorded.
    if (code === "23505" && name === "events_org_idempotency_key") {
      return new Response(null, { status: 204 })
    }
    console.error(
      JSON.stringify({
        code: "conversation.feedback_failed",
        error: failureCode(error),
      })
    )
    throw error
  }
}

/**
 * `/conversations` when `id` is empty, `/conversations/:id`,
 * `/conversations/:id/messages` and `/conversations/:id/feedback`, split by
 * `ownerRoute`.
 */
export async function conversationRoute(
  request: Request,
  kit: Tenancy,
  owner: Owner,
  id: string,
  action: string
): Promise<Response | null> {
  const method = request.method
  if (id === "") {
    if (method === "GET") return list(kit, owner)
    if (method === "POST") return create(request, kit, owner)
    return null
  }
  if (action === "messages") {
    return method === "GET" ? history(kit, owner, id) : null
  }
  if (action === "feedback") {
    return method === "POST" ? feedback(request, kit, owner, id) : null
  }
  if (method === "GET") {
    const row = await kit.withOrg({ orgId: owner.orgId }, (db) => find(db, id))
    return row ? Response.json(toConversation(row)) : notFound()
  }
  if (method === "PATCH") return patch(request, kit, owner, id)
  return null
}
