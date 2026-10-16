import { createHash } from "node:crypto"
import { ServerMessage } from "@workspace/contracts"
import { sql } from "drizzle-orm"
import { conversationMessages, conversations, events } from "./schema.ts"
import type { OrgScopedDb, Tenancy } from "./tenancy.ts"

/**
 * What a post did. `busy` and `waiting` wrote nothing and are the caller's
 * to retry (a Workflow step throws on them); `exists` means a post with the
 * same key already landed; `none` means the org has no conversation at all.
 */
export type Posted = "posted" | "exists" | "busy" | "waiting" | "none"

/** The message id a key posts under: stable, so a retry finds the first post. */
export const serverMessageId = (key: string) =>
  `srv_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`

/**
 * A message the assistant posts on its own, with no owner turn, in the
 * conversation the rail's Chat icon opens (newest `updated_at`, not
 * archived), parented on its tail as a turn's reply would be. It takes the
 * turn lock `apps/api/src/chat.ts` takes, and only tries it, so a post never
 * lands inside a turn. It waits while the tail holds a card or an approval
 * the owner has not answered, because the chat answers cards on the last
 * message only, and while the onboarding script still runs there, because
 * the script reads that conversation's cards.
 *
 * Not written to the CoS session log: `cos.message` belongs to a turn, so the
 * model learns what changed from the workspace context, not from this row.
 */
export async function postAssistantMessage(
  kit: Tenancy,
  {
    orgId,
    key,
    message,
  }: { orgId: string; key: string; message: Omit<ServerMessage, "id"> }
): Promise<Posted> {
  const { id, text, button } = ServerMessage.parse({
    ...message,
    id: serverMessageId(key),
  })
  return kit.withOrg({ orgId }, async (db) => {
    // shortcut: no index on the id alone, so this filters the org's rows;
    // posts are a few per domain, add one if they grow common.
    const [posted] = await db.execute(
      sql`select 1 from ${conversationMessages} where id = ${id} limit 1`
    )
    if (posted) return "exists"
    const [target] = await db.execute<{ id: string; kind: string }>(
      sql`select id, kind from ${conversations} where archived_at is null
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
    if (open) return "busy"
    if (target.kind === "onboarding" && !(await scriptEnded(db, target.id))) {
      return "waiting"
    }
    const [tail] = await db.execute<{ id: string; waits: boolean }>(sql`
      select id, content->>'role' = 'assistant' and exists (
          select 1 from jsonb_array_elements(content->'parts') p
          where p->>'type' like 'tool-%'
            and p->>'state' in ('input-available', 'approval-requested', 'approval-responded')
        ) as waits
      from ${conversationMessages}
      where conversation_id = ${target.id}
      order by seq desc limit 1`)
    if (tail?.waits) return "waiting"
    await db.insert(conversationMessages).values({
      conversationId: target.id,
      id,
      orgId,
      parentId: tail?.id ?? null,
      format: "ai-sdk/v6",
      content: {
        role: "assistant",
        parts: [
          { type: "step-start" },
          ...text.map((words) => ({
            type: "text",
            text: words,
            state: "done",
          })),
          ...(button ? [{ type: "data-button", data: button }] : []),
        ],
      },
    })
    await db.execute(
      sql`update ${conversations} set updated_at = now() where id = ${target.id}`
    )
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
