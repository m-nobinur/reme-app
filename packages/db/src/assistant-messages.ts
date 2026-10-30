import { createHash } from "node:crypto"
import {
  ChangeAskedPart,
  CosEvent,
  HandoffResult,
  ServerMessage,
  type TaintLabel,
} from "@workspace/contracts"
import { sql } from "drizzle-orm"
import { appendSessionEvent } from "./events.ts"
import {
  assignments,
  conversationMessages,
  conversations,
  events,
} from "./schema.ts"
import type { OrgScopedDb, Tenancy } from "./tenancy.ts"

/**
 * What a post did. `busy` and `waiting` wrote nothing and are the caller's
 * to retry (a Workflow step throws on them); `exists` means a post with the
 * same key already landed; `none` means the org has no conversation at all.
 */
export type Posted = "posted" | "exists" | "busy" | "waiting" | "none"

const digest = (key: string) =>
  createHash("sha256").update(key).digest("hex").slice(0, 40)

/** The message id a key posts under: stable, so a retry finds the first post. */
export const serverMessageId = (key: string) => `srv_${digest(key)}`

/**
 * The id of an owner's emailed reply. The prefix is what marks a row as
 * having come by email: `apps/api/src/chat.ts` reads it to log the row to the
 * CoS, and nothing that approves a card reads a row with it.
 */
export const emailMessageId = (key: string) => `eml_${digest(key)}`

/**
 * A message the assistant posts on its own, with no owner turn, in the
 * conversation the rail's Chat icon opens (newest `updated_at`, not
 * archived), parented on its tail as a turn's reply would be. It takes the
 * turn lock `apps/api/src/chat.ts` takes, and only tries it, so a post never
 * lands inside a turn. It lands after a card the owner has not answered,
 * which stays answerable where it sits: `apps/api/src/chat.ts` answers the
 * row a click names and cancels the newest open card on a typed message. It
 * waits only while the onboarding script still runs there, because the
 * script reads that conversation's cards from its tail.
 *
 * `conversationId` names the conversation instead (a reminder goes to the
 * one it was set in), archived or not; one the org does not have is `none`.
 *
 * Logged in the CoS session in the same transaction, as a `notice`
 * `cos.event` naming the message, so the next turn reads it whatever starts
 * that turn.
 */
export async function postAssistantMessage(
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
): Promise<Posted> {
  const { id, text, button, questions } = ServerMessage.parse({
    ...message,
    id: serverMessageId(key),
  })
  // A card's questions, as the words the owner read, so a typed answer is recognised.
  const asked = questions
    ? [`On a card I asked: ${questions.questions.map((q) => q.text).join(" ")}`]
    : []
  return post(kit, {
    orgId,
    id,
    conversationId,
    role: "assistant",
    parts: [
      { type: "step-start" },
      ...text.map((words) => ({ type: "text", text: words, state: "done" })),
      ...(button ? [{ type: "data-button", data: button }] : []),
      ...(questions ? [{ type: "data-build_questions", data: questions }] : []),
    ],
    event: {
      source: "notice",
      summary: [...text, ...asked].join("\n\n").slice(0, 1500),
      evidence: [],
      wake: false,
      message_id: id,
    },
  })
}

/**
 * Where a `cos.event` goes: the conversation the rail's Chat icon opens, or
 * `conversationId`, held under its turn lock with no turn open. `busy` and
 * `none` are as `Posted` says.
 */
async function session(
  db: OrgScopedDb,
  conversationId?: string
): Promise<{ id: string; kind: string } | "busy" | "none"> {
  const [target] = await db.execute<{ id: string; kind: string }>(
    conversationId
      ? sql`select id, kind from ${conversations} where id = ${conversationId}`
      : sql`select id, kind from ${conversations} where archived_at is null
        order by updated_at desc limit 1`
  )
  if (!target) return "none"
  const [turn] = await db.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(2, hashtext(${target.id}::text)) as locked`
  )
  if (!turn?.locked) return "busy"
  // A CoS turn streams after its first transaction lets the lock go; its
  // latest `cos.context` with no `cos.turn` yet is that turn still open. One
  // older than `LIMITS.totalMs` plus `GRACE_MS` (90 s) has lapsed.
  const [open] = await db.execute(sql`
    select 1 from ${events} c
    where c.session_id = ${target.id} and c.type = 'cos.context'
      and c.recorded_at > now() - interval '90 seconds'
      and not exists (select 1 from ${events} t
        where t.session_id = c.session_id and t.type = 'cos.turn'
          and t.payload->>'turn_id' = c.payload->>'turn_id')
    limit 1`)
  return open ? "busy" : target
}

/** What a handoff result reads as in the CoS log: it may quote the owner's goal. */
export const handoffEvent = (result: HandoffResult) => ({
  type: "cos.event",
  payload: CosEvent.parse({
    source: "staff",
    summary: result.summary,
    evidence: result.evidence,
    wake: true,
  }),
  taint: ["inferred", "untrusted_input"] as TaintLabel[],
})

/**
 * Logs an ended assignment's `result` in the CoS session now, inside the
 * caller's transaction. `busy` and `none` leave it for the next turn's
 * opening, which logs every result no `cos.event` names yet
 * (`unloggedResults`), so the CoS never polls for one.
 */
export async function logHandoff(
  db: OrgScopedDb,
  assignment: { orgId: string; id: string; staffId: string },
  result: HandoffResult
): Promise<"logged" | "busy" | "none"> {
  const target = await session(db)
  if (typeof target === "string") return target
  await appendSessionEvent(db, {
    orgId: assignment.orgId,
    staffId: assignment.staffId,
    assignmentId: assignment.id,
    sessionId: target.id,
    ...handoffEvent(result),
  })
  return "logged"
}

/** Ended assignments whose result no `cos.event` has logged yet, oldest first. */
export async function unloggedResults(
  db: OrgScopedDb
): Promise<{ id: string; staffId: string; result: HandoffResult }[]> {
  const rows = await db.execute<{
    id: string
    staff_id: string
    result: unknown
  }>(sql`
    select a.id, a.staff_id, a.result from ${assignments} a
    where a.result is not null and not exists (select 1 from ${events} e
      where e.assignment_id = a.id and e.type = 'cos.event')
    order by a.updated_at`)
  return rows.map((row) => ({
    id: row.id,
    staffId: row.staff_id,
    result: HandoffResult.parse(row.result),
  }))
}

/**
 * An owner's emailed reply, stored as the owner's message in the conversation
 * the reply token named, under the same gates as an assistant post: it never
 * lands inside a turn, nor before the onboarding script has ended. Unlike an
 * assistant post it also waits while a card or approval the owner has not
 * answered is open anywhere there, so an emailed "yes" can never sit beside
 * a card as if it answered it (ADR-042): one sent then is `waiting` and
 * stored nowhere. `key` is the mail's Message-ID, so redelivery is `exists`.
 *
 * The caller has already checked who sent it. Logged to the CoS by the owner's
 * next typed turn, with the taint of any owner message.
 */
export const postOwnerEmail = (
  kit: Tenancy,
  {
    orgId,
    conversationId,
    key,
    text,
  }: { orgId: string; conversationId: string; key: string; text: string }
): Promise<Posted> =>
  post(kit, {
    orgId,
    id: emailMessageId(key),
    conversationId,
    role: "user",
    parts: [{ type: "text", text }],
  })

/**
 * A change the owner asked for in the panel, written into the chat: their
 * words as their own message, then a resolved line for the assistant's side.
 * Both ids come from the request's key, so a retry stores nothing twice. The
 * change has started whatever this answers: a conversation that is busy or
 * waiting on a card keeps the change out of the chat, and `none` means the
 * org has no such conversation. The caller never fails the change on it.
 */
export async function postChangeAsked(
  kit: Tenancy,
  {
    orgId,
    key,
    text,
    conversationId,
  }: { orgId: string; key: string; text: string; conversationId?: string }
): Promise<Posted> {
  const asked = await post(kit, {
    orgId,
    id: `chg_${digest(key)}`,
    conversationId,
    role: "user",
    parts: [{ type: "text", text }],
  })
  if (asked !== "posted" && asked !== "exists") return asked
  return post(kit, {
    orgId,
    id: `chga_${digest(key)}`,
    conversationId,
    role: "assistant",
    parts: [
      { type: "step-start" },
      ChangeAskedPart.parse({ type: "data-change_asked", data: { text } }),
    ],
  })
}

async function post(
  kit: Tenancy,
  {
    orgId,
    id,
    conversationId,
    role,
    parts,
    event,
  }: {
    orgId: string
    id: string
    conversationId?: string
    role: "assistant" | "user"
    parts: Record<string, unknown>[]
    event?: CosEvent
  }
): Promise<Posted> {
  return kit.withOrg({ orgId }, async (db) => {
    // shortcut: no index on the id alone, so this filters the org's rows;
    // posts are a few per domain, add one if they grow common.
    const [posted] = await db.execute(
      sql`select 1 from ${conversationMessages} where id = ${id} limit 1`
    )
    if (posted) return "exists"
    const target = await session(db, conversationId)
    if (typeof target === "string") return target
    if (target.kind === "onboarding" && !(await scriptEnded(db, target.id))) {
      return "waiting"
    }
    // The owner's words wait behind an open card, wherever it sits, since an
    // assistant post may have landed on top of it; the assistant's never do.
    if (role === "user") {
      const [card] = await db.execute(sql`
        select 1 from ${conversationMessages} m
        where m.conversation_id = ${target.id} and exists (
          select 1 from jsonb_array_elements(m.content->'parts') p
          where p->>'type' like 'tool-%'
            and p->>'state' in ('input-available', 'approval-requested'))
        limit 1`)
      if (card) return "waiting"
    }
    const [tail] = await db.execute<{ id: string }>(sql`
      select id from ${conversationMessages}
      where conversation_id = ${target.id}
      order by seq desc limit 1`)
    await db.insert(conversationMessages).values({
      conversationId: target.id,
      id,
      orgId,
      parentId: tail?.id ?? null,
      format: "ai-sdk/v6",
      content: { role, parts },
    })
    await db.execute(
      sql`update ${conversations} set updated_at = now() where id = ${target.id}`
    )
    if (event) {
      await appendSessionEvent(db, {
        orgId,
        staffId: null,
        assignmentId: null,
        sessionId: target.id,
        type: "cos.event",
        payload: CosEvent.parse(event),
        // The words may be a model's (`writeUpdate`).
        taint: ["inferred"],
      })
    }
    return "posted"
  })
}

/**
 * `ended` in `apps/api/src/onboarding.ts`, read from the same parts
 * `readScript` reads: a build offer the owner answered, or the builder
 * question answered. shortcut: a copy of that rule in SQL; if `ended` changes,
 * change this with it.
 */
async function scriptEnded(db: OrgScopedDb, id: string): Promise<boolean> {
  const [row] = await db.execute(sql`
    select 1 from ${conversationMessages} m, jsonb_array_elements(m.content->'parts') p
    where m.conversation_id = ${id} and m.content->>'role' = 'assistant' and (
      (p->>'type' = 'tool-request_change'
        and p->>'state' in ('output-available', 'output-denied'))
      or (coalesce(p->'input'->>'key', p->'input'->>'step') = 'manual_builder'
        and p->>'state' <> 'input-available'))
    limit 1`)
  return row !== undefined
}
