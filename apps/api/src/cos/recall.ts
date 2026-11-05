import type {
  SearchConversationsInput,
  SearchConversationsOutput,
} from "@workspace/contracts"
import { type OrgScopedDb, sql } from "@workspace/db"
import type { ToolContext } from "./tools.ts"
import type { Turn } from "./turns.ts"

/** The most matches one search returns, and the longest snippet. */
export const RECALL = { results: 5, snippetChars: 300 } as const

/**
 * Full-text search over this org's own earlier CoS conversations, after
 * hermes-agent tools/session_search_tool.py (MIT): only what the owner typed
 * in the chat and the assistant's replies, the latest version of each
 * message, never a tool result, an email (`eml_`) or the app's own posts
 * (`srv_`), which quote records. The current conversation is already in the
 * model's context. Ranked by match, discounted by age (a 90-day half-life),
 * so the best recent match comes first. RLS keeps it to the org `withOrg`
 * set. shortcut: no index on the message text; it scans the org's
 * `cos.message` rows, so add a GIN expression index when an org passes
 * about 50,000 of them.
 */
export async function recall(
  db: OrgScopedDb,
  query: string,
  current: string | null
): Promise<SearchConversationsOutput> {
  const rows = await db.execute<{
    conversation: string
    at: string
    role: string
    snippet: string
  }>(sql`
    with latest as (
      select distinct on (session_id, payload->'message'->>'id')
        session_id, recorded_at, payload->'message' as message
      from events
      where type = 'cos.message'
        and session_id is distinct from ${current}::uuid
        and payload->'message'->>'id' not like 'eml\_%'
        and payload->'message'->>'id' not like 'srv\_%'
        and payload->'message'->>'role' in ('user', 'assistant')
      order by session_id, payload->'message'->>'id', seq desc
    ), texts as (
      select session_id, recorded_at, message->>'role' as role,
        (select string_agg(p->>'text', ' ') from jsonb_array_elements(message->'parts') p
          where p->>'type' = 'text') as body
      from latest
    ), q as (select websearch_to_tsquery('english', ${query}) as q)
    select t.session_id::text as conversation, t.recorded_at::text as at, t.role,
      ts_headline('english', t.body, q.q,
        'MaxWords=40, MinWords=12, StartSel="", StopSel="", MaxFragments=1') as snippet
    from texts t, q
    where t.body is not null and to_tsvector('english', t.body) @@ q.q
    order by ts_rank_cd(to_tsvector('english', t.body), q.q)
      * power(0.5, extract(epoch from now() - t.recorded_at) / (90 * 86400)) desc,
      t.recorded_at desc
    limit ${RECALL.results}`)
  const results = [...rows].flatMap((r) => {
    const snippet = r.snippet
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, RECALL.snippetChars)
    return snippet
      ? [
          {
            conversation: r.conversation,
            at: new Date(r.at).toISOString(),
            by: r.role === "user" ? ("owner" as const) : ("assistant" as const),
            snippet,
          },
        ]
      : []
  })
  return results.length > 0
    ? { outcome: "found", results }
    : { outcome: "none" }
}

/** `search_conversations`: `recall` in the turn's org, leaving out the turn's own conversation. */
export const searchConversations = (
  { kit, owner }: ToolContext,
  input: SearchConversationsInput,
  _key: string,
  turn: Turn
): Promise<SearchConversationsOutput> =>
  kit.withOrg({ orgId: owner.orgId }, (db) =>
    recall(db, input.query, turn.sessionId)
  )
