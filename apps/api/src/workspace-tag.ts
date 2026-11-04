import {
  type ActivitySegment,
  LOGO_VARIANTS,
  LogoRounds,
} from "@workspace/contracts"
import type { OrgScopedDb, Tenancy } from "@workspace/db"
import { conversationMessages, conversations, sql } from "@workspace/db"
import { withOnboarding } from "./activity.ts"
import type { Owner } from "./changes.ts"
import { readScript, waitingCard } from "./chat.ts"
import { readLogos } from "./logo.ts"
import { type Held, logoOf, stepOf } from "./onboarding.ts"
import { onboardingSegment } from "./onboarding-progress.ts"
import { etag, statusWithFacts } from "./workspace.ts"

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
  owner: Owner,
  env: Env
): Promise<{ body: string; etag: string }> {
  const { orgId } = owner
  return kit.withOrg({ orgId }, async (db) => {
    const [{ status, facts }, tail, open] = await Promise.all([
      statusWithFacts(db, env, new Date()),
      newestMessage(db),
      openOnboarding(db),
    ])
    const onboarding = open && (await onboardingOf(db, owner, env, open, facts))
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
 * until they settle the quote questions, then skipped.
 */
async function onboardingOf(
  db: OrgScopedDb,
  owner: Owner,
  env: Env,
  open: Open,
  facts: readonly Held[]
): Promise<ActivitySegment> {
  const progress = await readScript(db, open.id)
  const o = {
    ...progress,
    orgId: owner.orgId,
    facts,
    orgName: open.org_name,
    ownerName: "",
  }
  const card = waitingCard(open.tail && { content: open.tail })
  const asking =
    card?.type === "tool-ask_open"
      ? (card.input as { about?: string } | null)?.about
      : card && stepOf(card)
  const segment = onboardingSegment(
    o,
    new Date(open.created_at).toISOString(),
    Boolean(card),
    asking ?? undefined
  )
  if (segment.state === "done") {
    return { ...segment, at: await finishedAt(db, open) }
  }
  const logo =
    card?.type === "tool-ask_design" &&
    (await logoRound(env, owner, card.toolCallId, facts))
  return logo ? { ...segment, logo } : segment
}

/**
 * The design tray's newest logo round, read as the tray reads it, while it
 * draws or waits on a pick. None once it failed or a logo it drew is kept.
 */
export async function logoRound(
  env: Env,
  owner: Owner,
  toolCallId: string,
  facts: readonly Held[]
): Promise<ActivitySegment["logo"]> {
  const url = new URL("https://api.invalid/logos")
  url.searchParams.set("tool_call_id", toolCallId)
  const response = await readLogos(new Request(url), env, owner)
  // A round the panel cannot read never breaks the poll: it shows no row.
  if (!response.ok) return undefined
  const read = LogoRounds.safeParse(await response.json())
  if (!read.success) return undefined
  const { rounds } = read.data
  const last = rounds.at(-1)
  // The tray shows a round's designs as they land, while its ideas are still
  // being read and the round stays "drawing"; the panel says the same.
  if (last?.status === "drawing" && last.variants.length < LOGO_VARIANTS) {
    return { status: "drawing", options: LOGO_VARIANTS }
  }
  const kept = logoOf(facts)?.id
  const picked = rounds.some((r) => r.variants.some((v) => v.id === kept))
  return last && last.status !== "failed" && last.variants.length > 0 && !picked
    ? { status: "ready", options: last.variants.length }
    : undefined
}

/**
 * When onboarding finished: the row after the newest settled onboarding card,
 * which is the owner's answer or the assistant's next step, else the card's
 * own row. The conversation's `updated_at` moves with every later message, so
 * it cannot say; a request-change card is a later journey's, not onboarding's.
 * Read only once the segment is done, so a poll mid-onboarding does not.
 */
export async function finishedAt(
  db: OrgScopedDb,
  open: Pick<Open, "id" | "updated_at">
): Promise<string> {
  const [row] = await db.execute<{ at: string | Date }>(sql`
    select coalesce(
      (select n.created_at from ${conversationMessages} n
        where n.conversation_id = m.conversation_id and n.seq > m.seq
        order by n.seq limit 1),
      m.created_at) as at
    from ${conversationMessages} m
    where m.conversation_id = ${open.id} and m.content->>'role' = 'assistant'
      and exists (
        select 1 from jsonb_array_elements(m.content->'parts') p
        where p->>'type' like 'tool-%' and p->>'type' <> 'tool-request_change'
          and p->>'state' <> 'input-available'
          and (p->>'type' in ('tool-ask_upload', 'tool-review_quote_form', 'tool-ask_design')
            or coalesce(p->'input'->>'key', p->'input'->>'step') is not null))
    order by m.seq desc
    limit 1`)
  return new Date(row?.at ?? open.updated_at).toISOString()
}
