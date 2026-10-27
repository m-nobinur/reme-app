import type {
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowTimeoutDuration,
} from "cloudflare:workers"
import type { TaskKind, TaskStepName } from "@workspace/contracts"
import {
  eq,
  type OrgScopedDb,
  ownerTasks,
  type StepWrite,
  setStep,
  sql,
  syncTasks,
  type Tenancy,
  taskSteps,
} from "@workspace/db"
import { canonicalHash } from "@workspace/facade"
import { type Say, withKit } from "./domain-flow.ts"

/**
 * The probe and hold engine: a Workflow watches by reading the real state,
 * and only a change in what it read costs a model call or a message. Plan
 * "Probe and hold engine" (techniques T2, T3, T7).
 */

/** What a read says about one step of the org's task of its kind. */
export type Reading = {
  step: TaskStepName
  /** The proof: hashed, and stored as the step's evidence when it changes. */
  evidence: unknown
  /** What no row carries, such as a blocked note, written when it changes. */
  write?: Pick<StepWrite, "state" | "note" | "blocked_on">
  /** The owner's message, worded only when the evidence changed. */
  tell?: () => Promise<Omit<Say, "key"> | null>
}

/** A read's result for the Workflow, and its reading; none when there is nothing to record. */
export type Observed<T> = { result: T; reading?: Reading }

/** Drops every `at` and `*_at` key, so the time of a read never moves its hash. */
export const timeless = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(timeless)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "at" && !key.endsWith("_at"))
            .map(([key, v]) => [key, timeless(v)])
        )
      : value

/** The newest task of `kind` holding `step`, open first, made from the org's rows if missing. */
export async function stepOf(
  db: OrgScopedDb,
  orgId: string,
  kind: TaskKind,
  step: TaskStepName
) {
  const find = () =>
    db
      .select({ taskId: taskSteps.taskId, hash: taskSteps.probeHash })
      .from(taskSteps)
      .innerJoin(ownerTasks, eq(ownerTasks.id, taskSteps.taskId))
      .where(sql`${ownerTasks.kind} = ${kind} and ${taskSteps.step} = ${step}`)
      .orderBy(
        sql`${ownerTasks.state} in ('active', 'later') desc`,
        sql`${ownerTasks.createdAt} desc`
      )
      .limit(1)
  const [found] = await find()
  if (found) return found
  await syncTasks(db, orgId)
  const [made] = await find()
  if (!made) throw new Error(`task.missing:${kind}`)
  return made
}

/**
 * One probe, as the step `name`: `read` runs, its evidence is hashed as
 * sorted JSON with no timestamps, and the hash is compared with the one the
 * task step holds. Every probe stores `probe_hash` and `probed_at`; a new
 * hash also stores the evidence, `changed_at` and the reading's `write`, and
 * only then is the owner's message worded, keyed `task:{id}:{step}:{hash}`,
 * so a retried post lands once and a state seen before is never said again.
 * One read is one message however many steps it moves. A read that throws is
 * an error, never a change: the step retries and nothing stored moves. The
 * hash is written last, so a step that fails after the compare compares again.
 */
export async function probe<T>(
  step: WorkflowStep,
  name: string,
  env: Pick<Env, "HYPERDRIVE">,
  target: { orgId: string; kind: TaskKind },
  read: (kit: Tenancy) => Promise<Observed<T>>,
  config?: WorkflowStepConfig
): Promise<T & { say?: Say }> {
  // Every result is plain JSON, the callers' own step results, which a generic `T` cannot show.
  const body = (): Promise<never> =>
    withKit(env, async (kit): Promise<never> => {
      const { result, reading } = await read(kit)
      if (!reading) return result as never
      const { orgId, kind } = target
      const evidence = timeless(reading.evidence)
      const hash = canonicalHash(evidence).slice("sha256:".length)
      const stored = await kit.withOrg({ orgId }, (db) =>
        stepOf(db, orgId, kind, reading.step)
      )
      const changed = stored.hash !== hash
      const message = changed ? await reading.tell?.() : null
      const at = new Date()
      await kit.withOrg({ orgId }, (db) =>
        setStep(db, stored.taskId, reading.step, {
          probe_hash: hash,
          probed_at: at,
          ...(changed && { evidence, changed_at: at, ...reading.write }),
        })
      )
      if (!message) return result as never
      const key = `task:${stored.taskId}:${reading.step}:${hash.slice(0, 12)}`
      return { ...(result as object), say: { key, ...message } } as never
    })
  // A step with no config keeps the engine's defaults, as the callers' other steps do.
  return config ? step.do(name, config, body) : step.do(name, body)
}

/**
 * A wait the owner can end: their `type` event or the timeout, then a fresh
 * probe before anything else, so the next step acts on what is true now. The
 * probe that led here marked the step blocked. `woken` is whether the event
 * came; Workflows ends a wait that timed out by throwing.
 */
export async function hold<T>(
  step: WorkflowStep,
  name: string,
  wait: { type: string; timeout: WorkflowTimeoutDuration | number },
  again: () => Promise<T>
): Promise<{ woken: boolean; seen: T }> {
  let woken = true
  try {
    await step.waitForEvent(name, wait)
  } catch {
    woken = false
  }
  return { woken, seen: await again() }
}
