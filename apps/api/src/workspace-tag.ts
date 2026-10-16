import type { OrgScopedDb, Tenancy } from "@workspace/db"
import { conversationMessages, conversations, sql } from "@workspace/db"
import { etag, type SiteConfig, statusOf } from "./workspace.ts"

// Apart from workspace.ts because it reads conversation_messages, which
// nothing under cos/ may reach (ADR-034), and cos/tools.ts reads workspace.ts.

/**
 * `/workspace`'s body and its tag, in one transaction. The tag also names
 * the newest message of the conversation the chat opens, which the body
 * does not carry, so a message the assistant posts with no owner turn
 * changes the tag and the chat reads that thread again.
 */
export async function readTaggedWorkspace(
  kit: Tenancy,
  orgId: string,
  config: SiteConfig
): Promise<{ body: string; etag: string }> {
  return kit.withOrg({ orgId }, async (db) => {
    const [status, tail] = await Promise.all([
      statusOf(db, config, new Date()),
      newestMessage(db),
    ])
    const body = JSON.stringify(status)
    return { body, etag: await etag(body, tail) }
  })
}

/**
 * The tail of the newest open conversation, the one the rail's Chat icon
 * opens and `postAssistantMessage` posts to: by
 * `conversations_org_updated_idx`, then `conversation_messages_conversation_seq_idx`.
 */
async function newestMessage(db: OrgScopedDb): Promise<string | null> {
  const [row] = await db.execute<{ id: string }>(sql`
    select m.id from ${conversations} c
    cross join lateral (
      select id from ${conversationMessages}
      where conversation_id = c.id order by seq desc limit 1
    ) m
    where c.archived_at is null
    order by c.updated_at desc, c.id desc
    limit 1`)
  return row?.id ?? null
}
