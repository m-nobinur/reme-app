import { CosContext, CosContinue, type CosTurn } from "@workspace/contracts"
import {
  chiefStaffId,
  eq,
  memberships,
  newUlid,
  orgs,
  scheduledJobs,
  sql,
  type Tenancy,
  users,
} from "@workspace/db"
import type { LanguageModel } from "ai"
import { enqueueAfterTurn } from "./after-turn.ts"
import { settleCard } from "./build-questions.ts"
import type { Owner } from "./changes.ts"
import { cosModel, putRow } from "./chat.ts"
import {
  type AgentTurn,
  activeTools,
  contextOf,
  cosPrefix,
  LIMITS,
  newRunState,
  personaOf,
  reservation,
} from "./cos/agent.ts"
import {
  CONTEXT_POLICY,
  deriveCosMessages,
  type LoggedEvent,
  readSession,
} from "./cos/history.ts"
import { closeTurn, type Rows, ranTurn, settle, streamTurn } from "./cos/run.ts"
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
 * One more CoS turn for a turn cut off at its step or time limit with work
 * left (`closeRun` queued its `cos_continue` job). The orchestrator claims
 * the job and hands it here on the after-turn queue, since the CoS runs in
 * this Worker; the message holds ids only.
 */
export type ContinueJob = { kind: "cos_continue"; orgId: string; jobId: string }

export const isContinueJob = (body: unknown): body is ContinueJob =>
  (body as { kind?: unknown } | null)?.kind === "cos_continue"

/** What became of a continuation, for the log and the tests. */
export type Continued =
  | "ran"
  | "fell_back"
  /** Its reply is already logged: a redelivered message. */
  | "done"
  /** The owner sent a message since: their turn supersedes it. */
  | "superseded"
  | "over_cap"
  | "frozen"
  | "gone"
  | "no_model"

/** The continuation's reply id: one per turn continued, so a redelivery finds it. */
export const continuationId = (turnId: string) => `cont_${turnId}`

/**
 * Whether the log after the continued turn's context shows an attempt that
 * ended without a recorded outcome: a turn abandoned, or a call started
 * with no result logged. Its side effects are then not known.
 */
export function unknownAfter(log: LoggedEvent[], from: number): boolean {
  const after = log.filter((e) => e.seq > from)
  const results = new Set(
    after
      .filter((e) => e.type === "cos.tool_result")
      .map((e) => (e.payload as { tool_call_id: string }).tool_call_id)
  )
  return after.some(
    (e) =>
      (e.type === "cos.turn" &&
        (e.payload as CosTurn).outcome === "abandoned") ||
      (e.type === "cos.tool_started" &&
        !results.has((e.payload as { tool_call_id: string }).tool_call_id))
  )
}

/**
 * Runs the continuation as the org's owner. It opens like an owner's turn,
 * under the same lock, lapse check and daily cap, with the continued turn's
 * mode and no new owner message, and its reply is a new message after the
 * one cut off. A turn still open throws `SessionBusy`, which the queue
 * retries after a turn's longest life.
 */
export async function continueTurn(
  env: Env,
  kit: Tenancy,
  job: ContinueJob,
  deps: { model?: LanguageModel | null } = {}
): Promise<Continued> {
  const cos = cosModel(env)
  const model = deps.model !== undefined ? deps.model : cos.model
  const { modelId, price } = cos
  if (!model || !price) return "no_model"
  const found = await kit.withOrg({ orgId: job.orgId }, async (db) => {
    const [row] = await db
      .select({ refId: scheduledJobs.refId, payload: scheduledJobs.payload })
      .from(scheduledJobs)
      .where(eq(scheduledJobs.id, job.jobId))
    const [person] = await db
      .select({
        workosUserId: users.workosUserId,
        email: users.email,
        name: users.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        sql`${memberships.role} = 'owner' and ${memberships.status} = 'active'`
      )
      .orderBy(memberships.createdAt)
      .limit(1)
    const [org] = await db.select({ zone: orgs.timeZone }).from(orgs)
    return row?.refId && person
      ? { row, person, zone: org?.zone ?? null }
      : null
  })
  if (!found) return "gone"
  const { turn_id: turnId, attempt } = CosContinue.parse(found.row.payload)
  const sessionId = found.row.refId as string
  const owner: Owner = {
    orgId: job.orgId,
    session: {
      ...found.person,
      // No browser session: the bridge records the job as the caller's.
      sessionId: `cos_continue:${job.jobId}`,
      impersonated: false,
    },
  }
  const tools = { env, kit, owner, settleCard }
  const [{ workspace, facts, profile }, prefix] = await Promise.all([
    loadWorkspace(tools),
    cosPrefix(),
  ])
  const reserved = reservation(price)
  const opened = await kit.withOrg({ orgId: job.orgId }, async (db) => {
    const staffId = await chiefStaffId(db)
    if (!staffId) return "gone" as const
    const session = { orgId: job.orgId, staffId, sessionId }
    if (await closeLapsedTurn(db, session, LIMITS.totalMs)) {
      throw new SessionBusy(sessionId)
    }
    const log = await readSession(db, sessionId)
    const continued = log.find(
      (e) =>
        e.type === "cos.context" &&
        (e.payload as { turn_id?: unknown }).turn_id === turnId
    )
    if (!continued) return "gone" as const
    const said = (role: string, id?: string) =>
      log.some((e) => {
        const { message } = e.payload as {
          message?: { id: string; role: string }
        }
        return (
          e.type === "cos.message" &&
          message?.role === role &&
          (id ? message.id === id : e.seq > continued.seq)
        )
      })
    if (said("assistant", continuationId(turnId))) return "done" as const
    if (said("user")) return "superseded" as const
    const state = await sessionState(db, sessionId, prefix.sha256, null)
    if (state.frozen) return "frozen" as const
    if (!(await withinCap(db, job.orgId, reserved))) return "over_cap" as const
    const { mode } = CosContext.parse(continued.payload)
    const context = contextOf(
      mode,
      workspace,
      found.zone,
      new Date(),
      undefined,
      personaOf(facts, profile),
      false,
      null,
      facts,
      false,
      unknownAfter(log, continued.seq) ? "unknown" : "cut"
    )
    const turn: Turn = { ...session, turnId: newUlid() }
    await beginTurn(db, turn, {
      prefix: state.prefixLogged ? null : prefix,
      messages: [],
      context: {
        turn_id: turn.turnId,
        prefix_sha256: prefix.sha256,
        context_policy_version: CONTEXT_POLICY.version,
        mode,
        active_tools: activeTools(mode),
        text: context.text,
        reserved_usd: reserved,
      },
      contextTaint: context.taint,
    })
    return { turn, mode, log: await readSession(db, sessionId) }
  })
  if (typeof opened === "string") return opened
  const run: AgentTurn = {
    turn: opened.turn,
    kit,
    tools,
    price,
    reserved,
    state: newRunState(),
    abort: new AbortController(),
    zone: found.zone,
    log: opened.log,
  }
  const rows: Rows = (db, message) => putRow(db, owner, sessionId, message)
  const closing: Promise<unknown>[] = []
  const ended = (outcome: "error" | "integrity" | "fallback"): CosTurn => {
    const { outcome: _, ...ran } = ranTurn(run, modelId, "answered", null)
    return outcome === "fallback"
      ? {
          ...ran,
          outcome,
          reason: run.state.overBudget ? "budgetary" : "provider",
        }
      : { ...ran, outcome }
  }
  try {
    await settle(run, rows)
    const streamed = await streamTurn({
      run,
      model,
      mode: opened.mode,
      modelId,
      uiMessages: deriveCosMessages(run.log, CONTEXT_POLICY).messages,
      newMessageId: () => continuationId(turnId),
      lead: [],
      chip: null,
      reading: null,
      rows,
      waitUntil: (p) => closing.push(p),
      attempt,
    })
    if (streamed instanceof Response) {
      // Read to its end, which runs the turn's close.
      await streamed.text()
      await Promise.all(closing)
    } else {
      await closeTurn(
        run,
        ended(
          run.state.readFailed
            ? "error"
            : run.state.integrity
              ? "integrity"
              : "fallback"
        ),
        null,
        rows
      )
    }
    await enqueueAfterTurn(env, run.turn)
    return streamed instanceof Response ? "ran" : "fell_back"
  } catch (error) {
    await closeTurn(run, ended("error"), null, rows).catch(() => undefined)
    throw error
  }
}
