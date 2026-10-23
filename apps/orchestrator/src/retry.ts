import { Blueprint, PLANNED_PAGES } from "@workspace/contracts"
import {
  assignments,
  assignmentTransitions,
  eq,
  postAssistantMessage,
  sql,
  type Tenancy,
} from "@workspace/db"
import { REPEATING_FAILURE, SANDBOX_UPDATING } from "@workspace/facade"
import { insertAssignment } from "./app.ts"
import { creationChoices } from "./brief.ts"
import type { Ids } from "./state.ts"

/**
 * What follows an owner's build once it ends (cloudflare.ts). A build that
 * failed on our side is started once more, and the owner hears in the chat
 * what happened. Every line is a template over structured data: nothing the
 * Developer wrote reaches the owner from here.
 */

/** Failures on our side, each in the owner's words. Any other reason waits on the owner. */
export const SYSTEM_CAUSES: Readonly<Record<string, string>> = {
  "gates.repair_budget_exhausted": "it kept failing its final checks",
  "developer.stalled": "it stopped making progress",
  "developer.no_report": "it stopped before the draft was done",
  "developer.start_failed": "it couldn't get started",
  "provider.unavailable": "it kept being interrupted",
  [SANDBOX_UPDATING]: "it kept being interrupted",
  [REPEATING_FAILURE]: "it kept hitting the same problem",
  "sandbox.site_lost": "its work was lost while it waited",
  "pool.exhausted": "there was no room to build it just then",
}

export type Ended = {
  origin: "owner" | "console"
  kind: string
  lane: string
  retry_of: string | null
  reason: string | null
  /** Another site build is open: it speaks for itself. */
  busy: boolean
}

/** Retry an owner's build or full rebuild once; say a retry's failure, or a quick change's. */
export function decide(ended: Ended): "retry" | "stop" | "quiet" {
  if (ended.origin !== "owner" || !ended.kind.startsWith("site.")) {
    return "quiet"
  }
  if (!ended.reason || !Object.hasOwn(SYSTEM_CAUSES, ended.reason)) {
    return "quiet"
  }
  if (ended.busy) return "quiet"
  if (ended.retry_of) return "stop"
  return ended.kind === "site.build" || ended.lane === "full" ? "retry" : "stop"
}

const subject = (kind: string) =>
  kind === "site.revise" ? "Your website change" : "Your website build"

export function retryingText(kind: string, reason: string): string {
  const where =
    reason === "gates.repair_budget_exhausted" ? " in its final checks" : ""
  return `${subject(kind)} hit a problem${where}, so I'm starting it again. Nothing for you to do: I'll say here when the draft is ready.`
}

export function stoppedText(kind: string, reason: string): string {
  const cause = SYSTEM_CAUSES[reason] ?? "something went wrong on my side"
  return `${subject(kind)} couldn't finish: ${cause}. Say try again, or tell me what to change.`
}

const PAGE_NAMES = new Map<string, string>(
  PLANNED_PAGES.map((p) => [p.id, p.label])
)

/** The ready line: the planned pages by the names the owner picked them by. */
export function readyText(kind: string, blueprint: unknown): string {
  if (kind === "site.revise") {
    return "Your website changes are ready. Preview them, then approve them or tell me what to change."
  }
  const next = "Preview it, then approve it or tell me what to change."
  const pages =
    Blueprint.safeParse(blueprint).data?.pages.map((p) => p.page) ?? []
  const named = pages
    .filter((id) => id !== "service")
    .flatMap((id) => PAGE_NAMES.get(id) ?? [])
  if (named.length === 0) return `Your website draft is ready. ${next}`
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
  const each = pages.includes("service") ? ", plus a page for each service" : ""
  return `Your website draft is ready, with ${list} pages${each}. ${next}`
}

export type Note = { key: string; text: string }

/** A post the chat could not take yet throws, so the step's retries try again. */
export async function postNote(
  kit: Tenancy,
  orgId: string,
  note: Note
): Promise<void> {
  const posted = await postAssistantMessage(kit, {
    orgId,
    key: note.key,
    message: { text: [note.text] },
  })
  if (posted === "busy" || posted === "waiting") {
    throw new Error(`build.note_${posted}`)
  }
}

/** The ready line, while the review it announces is still open. */
export async function sayReady(kit: Tenancy, ids: Ids): Promise<void> {
  const [row] = await kit.withOrg({ orgId: ids.orgId }, (db) =>
    db
      .select({
        kind: assignments.kind,
        state: assignments.state,
        blueprint: assignments.blueprint,
      })
      .from(assignments)
      .where(eq(assignments.id, ids.assignmentId))
  )
  if (row?.state !== "awaiting_review") return
  await postNote(kit, ids.orgId, {
    key: `site.ready:${ids.assignmentId}`,
    text: readyText(row.kind, row.blueprint),
  })
}

/** The plan with its drawn photos unset, so the retry's photo step draws and places them. */
const redrawn = (blueprint: unknown) => {
  const plan = Blueprint.safeParse(blueprint)
  if (!plan.success) return null
  return {
    ...plan.data,
    images: plan.data.images.map(({ asset_id, ...slot }) =>
      slot.source === "upload" ? { ...slot, asset_id } : slot
    ),
  }
}

/**
 * A failed build's follow-up: one retry of the same kind and goal, keyed
 * `retry:<id>` so a replayed step finds the row it made, and the line to
 * post, if any. A retry the daily cap refuses is told as a failure.
 */
export async function afterFailure(
  env: Pick<Env, "ASSIGNMENTS">,
  kit: Tenancy,
  ids: Ids
): Promise<{ retry_id: string | null; note: Note | null }> {
  const key = `retry:${ids.assignmentId}`
  const read = await kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const [row] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, ids.assignmentId))
    const choices = await creationChoices(db, ids)
    const [last] = await db
      .select({ reason: assignmentTransitions.reason })
      .from(assignmentTransitions)
      .where(
        sql`${assignmentTransitions.assignmentId} = ${ids.assignmentId} and ${assignmentTransitions.toState} = 'failed'`
      )
      .orderBy(sql`${assignmentTransitions.version} desc`)
      .limit(1)
    // This build's own retry, made by an earlier attempt of the step, is not another build.
    const [open] = await db
      .select({ id: assignments.id })
      .from(assignments)
      .where(
        sql`${assignments.kind} like 'site.%' and ${assignments.state} not in ('published', 'failed', 'cancelled') and ${assignments.idempotencyKey} <> ${key}`
      )
      .limit(1)
    return { row, choices, reason: last?.reason ?? null, busy: Boolean(open) }
  })
  const { row, choices, reason } = read
  if (!row || !reason) return { retry_id: null, note: null }
  const verdict = decide({
    origin: choices.origin,
    kind: row.kind,
    lane: choices.lane,
    retry_of: choices.retry_of,
    reason,
    busy: read.busy,
  })
  if (verdict === "quiet") return { retry_id: null, note: null }
  const stopped = {
    retry_id: null,
    note: {
      key: `site.stopped:${ids.assignmentId}`,
      text: stoppedText(row.kind, reason),
    },
  }
  if (verdict === "stop") return stopped
  const made = await kit.withOrg({ orgId: ids.orgId }, (db) =>
    insertAssignment(db, ids.orgId, key, true, {
      kind: row.kind,
      goal: row.goal,
      model: choices.model,
      withhold: choices.withhold,
      lane: choices.lane,
      change_kind: choices.change_kind,
      retry_of: {
        assignment_id: ids.assignmentId,
        blueprint: redrawn(row.blueprint),
      },
    })
  )
  if (!("row" in made)) return stopped
  const retry = made.row
  if (!retry.workflowInstanceId) {
    // shortcut: a refused create is taken as this step's earlier attempt
    // having made the instance; if it was a real failure, the hourly
    // redrive finds the id has no instance and starts one.
    await env.ASSIGNMENTS.create({
      id: retry.id,
      params: { assignment_id: retry.id, org_id: ids.orgId },
    }).catch(() => undefined)
    await kit.withOrg({ orgId: ids.orgId }, (db) =>
      db
        .update(assignments)
        .set({ workflowInstanceId: retry.id })
        .where(eq(assignments.id, retry.id))
    )
  }
  return {
    retry_id: retry.id,
    note: {
      key: `site.retrying:${ids.assignmentId}`,
      text: retryingText(row.kind, reason),
    },
  }
}
