import type { ActivitySegment } from "@workspace/contracts"
import type { OrgScopedDb, Tenancy } from "@workspace/db"
import { conversationMessages, conversations, sql } from "@workspace/db"
import { withOnboarding } from "./activity.ts"
import { readScript, waitingCard } from "./chat.ts"
import type { Held } from "./onboarding.ts"
import { onboardingSegment } from "./onboarding-progress.ts"
import { etag, type SiteConfig, statusWithFacts } from "./workspace.ts"

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
    const [{ status, facts }, tail, open] = await Promise.all([
      statusWithFacts(db, config, new Date()),
      newestMessage(db),
      openOnboarding(db),
    ])
    const onboarding = open && (await onboardingOf(db, orgId, open, facts))
    const body = JSON.stringify(
      status.activity
        ? {
            ...status,
            activity: withOnboarding(status.activity, onboarding ?? null),
          }
        : status
    )
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

type Open = {
  id: string
  org_name: string
  created_at: string | Date
  updated_at: string | Date
  /** The newest row's content, as `waitingCard` reads it. */
  tail: NonNullable<Parameters<typeof waitingCard>[0]>["content"] | null
}

/**
 * The onboarding conversation while the site has never been live, the
 * journey's only time, with its newest row (by
 * `conversation_messages_conversation_seq_idx`); the live check is one probe
 * of `deployments_site_config_version_key`. Null once the site is live, so
 * a live site's poll never reads the script.
 */
async function openOnboarding(db: OrgScopedDb): Promise<Open | null> {
  const [row] = await db.execute<Open>(sql`
    select c.id, o.name as org_name, c.created_at, c.updated_at, m.content as tail
    from ${conversations} c
    join orgs o on o.id = c.org_id
    left join lateral (
      select content from ${conversationMessages}
      where conversation_id = c.id order by seq desc limit 1
    ) m on true
    where c.kind = 'onboarding' and c.archived_at is null
      and not exists (select 1 from deployments d where d.site_id = c.org_id)
    order by c.created_at desc
    limit 1`)
  return row ?? null
}

/**
 * The onboarding segment from the conversation's cards and the facts the
 * workspace read: waiting while the newest row holds an open card, as of
 * when onboarding started, or its last row once done.
 *
 * shortcut: `asked` is left out, as it reads the planner's steps from the
 * event log; an optional "Your customers" the owner deferred shows open
 * until they settle how customers reach them, then skipped.
 */
async function onboardingOf(
  db: OrgScopedDb,
  orgId: string,
  open: Open,
  facts: readonly Held[]
): Promise<ActivitySegment> {
  const progress = await readScript(db, open.id)
  const o = { ...progress, orgId, facts, orgName: open.org_name, ownerName: "" }
  const waiting = Boolean(waitingCard(open.tail && { content: open.tail }))
  const segment = onboardingSegment(
    o,
    new Date(open.created_at).toISOString(),
    waiting
  )
  return segment.state === "done"
    ? { ...segment, at: new Date(open.updated_at).toISOString() }
    : segment
}
