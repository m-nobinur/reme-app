/**
 * Rewinds one conversation for a live test: everything after a boundary
 * message goes, so the next turn starts from the state the boundary saw. It
 * deletes the conversation's later messages, the CoS session's events logged
 * after the boundary was written, its own notice aside (with the reflection
 * passes over them), and
 * the org's owner tasks and domains made after it. A task made before the
 * boundary and changed after cannot be put back; it is listed, not touched.
 *
 *   DATABASE_URL=... node apps/api/scripts/rewind.mjs \
 *     --conversation <id> --after <message id> [--apply] [--allow-host <host>]
 *
 * A dry run by default: it prints what it would delete. It runs as the
 * database owner, since `events` is append-only for the app's role, so it
 * refuses any host but a local one or the one named with `--allow-host`,
 * and refuses production's outright.
 */
import { pathToFileURL } from "node:url"
import postgres from "postgres"

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"])

/**
 * Why `url` must not be rewound, or null. Production's host is in no file
 * here, so a remote host runs only when named exactly, and never one that
 * says production or that `REME_PROD_DB_HOST` names.
 */
export function hostRefusal(url, allowHost = null, prodHost = null) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return "DATABASE_URL is not a URL"
  }
  if (prodHost && host === prodHost) return `${host} is production`
  if (/prod/i.test(host)) return `${host} looks like production`
  if (LOCAL.has(host)) return null
  return host === allowHost
    ? null
    : `${host} is not local: name it with --allow-host to rewind it`
}

/** What a rewind after `messageId` would delete, read and nothing written. */
export async function planRewind(sql, conversationId, messageId) {
  const [boundary] = await sql`
    select seq, created_at, org_id from conversation_messages
    where conversation_id = ${conversationId} and id = ${messageId}`
  if (!boundary) throw new Error(`no message ${messageId} in ${conversationId}`)
  const at = boundary.created_at
  const org = boundary.org_id
  const [messages, events, passes, tasks, domains, changed] = await Promise.all(
    [
      sql`select id, seq, content->>'role' as role from conversation_messages
      where conversation_id = ${conversationId} and seq > ${boundary.seq}
      order by seq`,
      // The log is cut after the last row the boundary saw: those written by
      // then, and the notice its own post wrote beside it.
      sql`select event_id, seq, type from events
      where session_id = ${conversationId} and type like 'cos.%'
        and seq > coalesce((select max(seq) from events
          where session_id = ${conversationId} and (recorded_at <= ${at}
            or (type = 'cos.event' and payload->>'message_id' = ${messageId}))), -1)
      order by seq`,
      sql`select event_id from events
      where type = 'cos.background_step' and payload->>'session_id' = ${conversationId}
        and recorded_at > ${at}`,
      sql`select id, kind, state from owner_tasks
      where org_id = ${org} and created_at > ${at}`,
      sql`select id, name, state from domains
      where org_id = ${org} and created_at > ${at}`,
      sql`select distinct t.id, t.kind from owner_tasks t join task_steps s on s.task_id = t.id
      where t.org_id = ${org} and t.created_at <= ${at} and s.changed_at > ${at}`,
    ]
  )
  return {
    conversationId,
    orgId: org,
    boundary: { id: messageId, seq: Number(boundary.seq), at },
    messages: [...messages],
    events: [...events],
    passes: [...passes],
    tasks: [...tasks],
    domains: [...domains],
    untouched: [...changed],
  }
}

/** Deletes what `plan` lists, in one transaction. */
export async function applyRewind(sql, plan) {
  await sql.begin(async (tx) => {
    const ids = (rows, key) => rows.map((r) => r[key])
    if (plan.messages.length > 0)
      await tx`delete from conversation_messages
        where conversation_id = ${plan.conversationId} and id in ${tx(ids(plan.messages, "id"))}`
    const eventIds = [
      ...ids(plan.events, "event_id"),
      ...ids(plan.passes, "event_id"),
    ]
    if (eventIds.length > 0)
      await tx`delete from events where event_id in ${tx(eventIds)}`
    if (plan.tasks.length > 0)
      await tx`delete from owner_tasks where id in ${tx(ids(plan.tasks, "id"))}`
    if (plan.domains.length > 0)
      await tx`delete from domains where id in ${tx(ids(plan.domains, "id"))}`
  })
}

const summary = (plan) =>
  [
    `Boundary: message ${plan.boundary.id} (seq ${plan.boundary.seq}, ${new Date(plan.boundary.at).toISOString()})`,
    `Messages after it: ${plan.messages.length}${plan.messages.length ? ` (${plan.messages.map((m) => `${m.role} ${m.id}`).join(", ")})` : ""}`,
    `CoS events after it: ${plan.events.length}${plan.events.length ? ` (${[...new Set(plan.events.map((e) => e.type))].join(", ")})` : ""}`,
    `Reflection passes after it: ${plan.passes.length}`,
    `Owner tasks made after it: ${plan.tasks.length}${plan.tasks.length ? ` (${plan.tasks.map((t) => `${t.kind} ${t.state}`).join(", ")})` : ""}`,
    `Domains made after it: ${plan.domains.length}${plan.domains.length ? ` (${plan.domains.map((d) => `${d.name} ${d.state}`).join(", ")})` : ""}`,
    ...(plan.untouched.length
      ? [
          `Not rewound, changed after it but made before: ${plan.untouched.map((t) => `${t.kind} task ${t.id}`).join(", ")}`,
        ]
      : []),
  ].join("\n")

function argsOf(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  return {
    conversation: value("--conversation"),
    after: value("--after"),
    allowHost: value("--allow-host"),
    apply: argv.includes("--apply"),
  }
}

async function main() {
  const args = argsOf(process.argv.slice(2))
  const url = process.env.DATABASE_URL
  if (!url || !args.conversation || !args.after) {
    console.error(
      "usage: DATABASE_URL=... node apps/api/scripts/rewind.mjs --conversation <id> --after <message id> [--apply] [--allow-host <host>]"
    )
    process.exit(2)
  }
  const refused = hostRefusal(
    url,
    args.allowHost,
    process.env.REME_PROD_DB_HOST
  )
  if (refused) {
    console.error(`refused: ${refused}`)
    process.exit(1)
  }
  const sql = postgres(url, { max: 1 })
  try {
    const plan = await planRewind(sql, args.conversation, args.after)
    console.log(summary(plan))
    if (!args.apply) {
      console.log(
        "\nDry run: nothing deleted. Run again with --apply to delete it."
      )
      return
    }
    await applyRewind(sql, plan)
    console.log("\nDeleted.")
  } finally {
    await sql.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
