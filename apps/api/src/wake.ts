import { dashesToCommas, type ServerMessage } from "@workspace/contracts"
import {
  chiefStaffId,
  conversationMessages,
  deliveries,
  jobRuns,
  newUlid,
  type OrgScopedDb,
  sql,
  surfacedKey,
  type Tenancy,
  taskFollowups,
  unpromptedKey,
  wakeSession,
} from "@workspace/db"
import { vouched } from "@workspace/gates/contacts"
import type { LanguageModel } from "ai"
import { settleCard } from "./build-questions.ts"
import { cosModel } from "./chat.ts"
import { ownerOf, runOpened } from "./continue.ts"
import {
  activeTools,
  contextOf,
  cosPrefix,
  LIMITS,
  personaOf,
  reservation,
} from "./cos/agent.ts"
import { CONTEXT_POLICY, readSession } from "./cos/history.ts"
import { loadWorkspace } from "./cos/tools.ts"
import {
  beginTurn,
  closeLapsedTurn,
  SessionBusy,
  sessionState,
  type Turn,
  withinCap,
} from "./cos/turns.ts"

/**
 * A proactive CoS turn (architecture S2), handed over by the orchestrator on
 * the after-turn queue: an org's `cos_wake` job, once the staff results that
 * asked for a turn have gathered for a minute, or a heartbeat Jev said yes
 * to, which logged its items as a `schedule` event first. `slot` is the
 * job's due time and keys the post and the run's `job_runs` row. A heartbeat
 * adds `beat`: whether to email, the contacts its trusted facts hold, the
 * Search report's chip, and the follow-ups it asks about (`task:` keys). A
 * procedure's schedule, such as `weekly_report`, adds `skill`, the
 * procedure the turn follows; its posts count with the events'.
 */
export type WakeJob = {
  kind: "cos_wake"
  orgId: string
  jobId: string
  slot: string
  skill?: string
  beat?: {
    email: boolean
    trusted: string[]
    chip?: string
    follow_ups: string[]
  }
}

export const isWakeJob = (body: unknown): body is WakeJob =>
  (body as { kind?: unknown } | null)?.kind === "cos_wake"

/** How long the owner must have typed nothing before a turn they did not start. */
export const IDLE_MS = 2 * 60_000

/** Posts event-driven turns may make in an org's day; a `[quiet]` turn makes none. */
export const WAKE_POSTS_PER_DAY = 3

/** What became of a wake, for the log and the tests. */
export type Woke =
  | "ran"
  | "fell_back"
  /** Its post is already queued: a redelivered message. */
  | "done"
  /** The owner typed in the last `IDLE_MS`: their next turn reads the events. */
  | "owner_active"
  /** The day's posts are spent. */
  | "capped"
  | "over_cap"
  | "frozen"
  | "gone"
  /** The chat is still in its onboarding script. */
  | "waiting"
  | "no_model"

/** The outbox rows a post writes, as the orchestrator's consumer reads them. */
type Delivery = { orgId: string; key: string; conversationId: string } & (
  | { channel: "in_app"; message: Omit<ServerMessage, "id"> }
  | { channel: "email"; subject: string; text: string }
)

/** A reply that is only the marker, or opens or ends with it, posts nothing; so does an empty one. */
export const isQuiet = (text: string) =>
  !text || /^\[quiet\]/i.test(text) || /\[quiet\]$/i.test(text)

/** `2026-10-30`, the org's date now, as the heartbeat's cap is keyed. */
const today = (zone: string | null) =>
  new Date().toLocaleDateString("en-CA", { timeZone: zone ?? "UTC" })

/** Event-driven posts already made on the org's local day. */
async function postsToday(db: OrgScopedDb, orgId: string, zone: string | null) {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from ${deliveries}
    where starts_with(key, ${`wake:${orgId}:`}) and channel = 'in_app'
      and (created_at at time zone ${zone ?? "UTC"})::date
        = (now() at time zone ${zone ?? "UTC"})::date`)
  return row?.n ?? 0
}

/** Whether the owner typed, in any conversation, in the last `IDLE_MS`. */
async function ownerTyped(db: OrgScopedDb) {
  const [row] = await db.execute<{ typed: boolean }>(sql`
    select exists (
      select 1 from ${conversationMessages}
      where content->>'role' = 'user'
        and created_at > now() - ${`${IDLE_MS} milliseconds`}::interval
    ) as typed`)
  return row?.typed === true
}

/**
 * Puts a heartbeat's follow-ups back when its turn posted nothing for a
 * reason other than the turn deciding to stay quiet, so a later beat asks.
 */
const giveBack = (db: OrgScopedDb, orgId: string, keys: string[]) =>
  keys.length === 0
    ? Promise.resolve()
    : db.execute(
        sql`delete from ${deliveries} where key in (${sql.join(
          keys.map((k) => sql`${surfacedKey(orgId, k)}`),
          sql`, `
        )})`
      )

/**
 * Runs the turn as the org's owner, in `ask` mode with the read tools only.
 * It opens only with no turn open (`SessionBusy`, which the queue retries
 * after a turn's longest life) and the owner quiet for `IDLE_MS`, within the
 * daily cost cap and the day's posts: `WAKE_POSTS_PER_DAY` for events, the
 * one unprompted message for a heartbeat. Its reply is posted through the
 * outbox, which logs it as the assistant's notice and pushes it; a `[quiet]`
 * reply posts nothing and spends none of the day's posts. Nor does a reply
 * with a link, an email address or a phone number that no trusted fact
 * holds: the org's own hosts, or a heartbeat's trusted facts. What became of
 * the run is written to its `job_runs` row.
 */
export async function wakeTurn(
  env: Env,
  kit: Tenancy,
  job: WakeJob,
  deps: { model?: LanguageModel | null } = {}
): Promise<Woke> {
  const cos = cosModel(env)
  const model = deps.model !== undefined ? deps.model : cos.model
  const { modelId, price } = cos
  if (!model || !price) return "no_model"
  const { beat } = job
  const heartbeat = beat !== undefined
  const key = `${heartbeat ? "heartbeat" : "wake"}:${job.orgId}:${job.jobId}:${job.slot}`
  const found = await kit.withOrg({ orgId: job.orgId }, (db) =>
    ownerOf(db, job.orgId, `cos_wake:${job.jobId}`)
  )
  if (!found) return "gone"
  const { owner, zone } = found
  const tools = { env, kit, owner, settleCard }
  const [{ workspace, facts, profile }, prefix] = await Promise.all([
    loadWorkspace(tools),
    cosPrefix(),
  ])
  const persona = personaOf(facts, profile)
  const day = today(zone)
  const cap = unpromptedKey(job.orgId, day)
  const trusted = [
    ...(beat?.trusted ?? []),
    ...[
      workspace.site.host,
      ...(workspace.domains ?? []).map((d) => d.name),
    ].filter((host) => host !== null),
  ]
  const record = async (
    db: OrgScopedDb,
    outcome: "done" | "no_change" | "failed",
    detail: string
  ) => {
    await db
      .update(jobRuns)
      .set({ outcome, detail })
      .where(
        sql`${jobRuns.jobId} = ${job.jobId} and ${jobRuns.runAt} = ${job.slot}::timestamptz`
      )
  }
  /** Whether the follow-ups stay asked: the turn posted, or chose to stay quiet. */
  let kept = false
  /** Whether the reply reached `post`, which records what it did. */
  let decided = false
  const ended = async (outcome: Woke) => {
    if (outcome === "done") return outcome
    await kit.withOrg({ orgId: job.orgId }, async (db) => {
      if (!kept) await giveBack(db, job.orgId, beat?.follow_ups ?? [])
      if (outcome === "ran" && !decided)
        await record(db, "failed", "turn_error")
      else if (outcome !== "ran")
        await record(
          db,
          outcome === "fell_back" ? "failed" : "no_change",
          outcome
        )
    })
    return outcome
  }
  const reserved = reservation(price)
  const opened = await kit.withOrg({ orgId: job.orgId }, async (db) => {
    const staffId = await chiefStaffId(db)
    if (!staffId) return "gone" as const
    const sessionId = await wakeSession(db)
    if (sessionId === "busy") throw new SessionBusy(job.orgId)
    if (sessionId === "none") return "gone" as const
    if (sessionId === "waiting") return "waiting" as const
    const session = { orgId: job.orgId, staffId, sessionId }
    if (await closeLapsedTurn(db, session, LIMITS.totalMs)) {
      throw new SessionBusy(sessionId)
    }
    const [posted] = await db.execute(
      sql`select 1 from ${deliveries} where key = ${key}`
    )
    if (posted) return "done" as const
    if (await ownerTyped(db)) return "owner_active" as const
    const [taken] = heartbeat
      ? await db.execute(sql`select 1 from ${deliveries} where key = ${cap}`)
      : []
    if (
      taken ||
      (!heartbeat &&
        (await postsToday(db, job.orgId, zone)) >= WAKE_POSTS_PER_DAY)
    )
      return "capped" as const
    const state = await sessionState(db, sessionId, prefix.sha256, null)
    if (state.frozen) return "frozen" as const
    if (!(await withinCap(db, job.orgId, reserved))) return "over_cap" as const
    const context = contextOf(
      "ask",
      workspace,
      zone,
      new Date(),
      undefined,
      persona,
      false,
      null,
      facts,
      false,
      job.skill ? { skill: job.skill } : "wake"
    )
    const turn: Turn = { ...session, turnId: newUlid() }
    await beginTurn(db, turn, {
      prefix: state.prefixLogged ? null : prefix,
      messages: [],
      context: {
        turn_id: turn.turnId,
        prefix_sha256: prefix.sha256,
        context_policy_version: CONTEXT_POLICY.version,
        mode: "ask",
        active_tools: activeTools("ask", true),
        text: context.text,
        reserved_usd: reserved,
      },
      contextTaint: context.taint,
    })
    return {
      turn,
      mode: "ask" as const,
      log: await readSession(db, sessionId),
    }
  })
  if (typeof opened === "string") return ended(opened)

  const queued: Delivery[] = []
  const post = async (db: OrgScopedDb, reply: string) => {
    decided = true
    if (isQuiet(reply)) {
      kept = true
      return record(db, "no_change", "quiet")
    }
    const text = dashesToCommas(reply)
    if (!vouched(text, trusted))
      return record(db, "failed", "unsourced_contact")
    if (heartbeat) {
      const took = await db
        .insert(deliveries)
        .values({
          orgId: job.orgId,
          key: cap,
          channel: "in_app",
          state: "sent",
        })
        .onConflictDoNothing()
        .returning({ key: deliveries.key })
      if (took.length === 0) return record(db, "no_change", "capped")
    }
    const conversationId = opened.turn.sessionId
    const out: Delivery[] = [
      {
        orgId: job.orgId,
        key,
        conversationId,
        channel: "in_app",
        message: {
          text: [text],
          ...(beat?.chip && {
            button: {
              label: beat.chip,
              // The Search report's Google chip starts the sign-in from the row itself.
              action:
                beat.chip === "Connect Google"
                  ? { kind: "connect" as const, service: "google" as const }
                  : { kind: "ask" as const, text: beat.chip },
            },
          }),
        },
      },
      ...(beat?.email
        ? [
            {
              orgId: job.orgId,
              key: `${key}:email`,
              conversationId,
              channel: "email" as const,
              subject: persona.name
                ? `An update from ${persona.name}`
                : "An update on your business",
              text,
            },
          ]
        : []),
    ]
    await db
      .insert(deliveries)
      .values(
        out.map((d) => ({
          orgId: d.orgId,
          key: d.key,
          channel: d.channel,
          payload: d,
        }))
      )
      .onConflictDoNothing()
    if (beat && beat.follow_ups.length > 0)
      await db
        .insert(taskFollowups)
        .values(
          beat.follow_ups.map((fingerprint) => ({
            orgId: job.orgId,
            fingerprint,
            sentAt: new Date(),
          }))
        )
        .onConflictDoNothing()
    await record(
      db,
      "done",
      out.length > 1 ? "sent:in_app,email" : "sent:in_app"
    )
    kept = true
    queued.push(...out)
  }
  const ran = await runOpened({
    env,
    kit,
    tools,
    price,
    reserved,
    zone,
    opened,
    model,
    modelId,
    newMessageId: () => `wake_${opened.turn.turnId}`,
    post,
  })
  // After the close commits, so the consumer finds the rows; one unsent is
  // queued again by the orchestrator's hourly sweep.
  for (const delivery of queued) {
    await env.DELIVERIES.send(delivery).catch((error: unknown) =>
      console.error(
        JSON.stringify({
          code: "wake.delivery_unsent",
          channel: delivery.channel,
          error: error instanceof Error ? error.name : "unknown",
        })
      )
    )
  }
  return ended(ran)
}
