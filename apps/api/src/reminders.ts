import {
  CreateReminderRequest,
  idempotencyKey,
  REMINDER_NOTES_MAX,
  Reminder,
  ReminderPatch,
  Uuid,
} from "@workspace/contracts"
import {
  eq,
  lowerNextDue,
  type OrgScopedDb,
  reminders,
  scheduledJobs,
  sql,
  type Tenancy,
} from "@workspace/db"
import type { Owner } from "./changes.ts"
import { failure, invalid, keyMissing, readBody } from "./http.ts"
import { ownerStaffId } from "./staff.ts"

/**
 * Reminders someone wrote down: the owner through `POST /reminders`, or the
 * Chief of Staff through its tool. Both go through `createReminder`, so the
 * two share its checks and its replay. A reminder is looked up under the
 * session's org before it is changed, so another org's id is a 404. The
 * title is the owner's text: stored and returned as data, never read.
 */

type Row = typeof reminders.$inferSelect

const toReminder = (row: Row): Reminder =>
  Reminder.parse({
    id: row.id,
    title: row.title,
    due_at: row.dueAt?.toISOString() ?? null,
    done_at: row.doneAt?.toISOString() ?? null,
    source: row.source,
    conversation_id: row.conversationId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  })

/** How far in the past a due time may be, for a clock a little behind. */
const PAST_MS = 5 * 60_000
/** How far ahead a due time may be. */
const AHEAD_MS = 366 * 24 * 3_600_000

/**
 * Puts the reminder's job at `dueAt`, or removes it when there is none. A
 * reminder has at most one job, a one-off, so moving it is a delete and an
 * insert; a job that already ran or paused comes back armed.
 */
async function armJob(
  db: OrgScopedDb,
  orgId: string,
  id: string,
  dueAt: Date | null
) {
  await db
    .delete(scheduledJobs)
    .where(
      sql`${scheduledJobs.kind} = 'reminder' and ${scheduledJobs.refId} = ${id}`
    )
  if (dueAt)
    await db
      .insert(scheduledJobs)
      .values({ orgId, kind: "reminder", refId: id, nextRunAt: dueAt })
}

/**
 * Tells the scheduler's KV guard about a reminder's due time. Call it after
 * the transaction that wrote the reminder commits, or the cron could scan
 * before the job exists and write a later time back.
 */
export const wakeScheduler = (
  env: Pick<Env, "SCHEDULE" | "JOBS">,
  made: Reminder
) =>
  made.due_at && !made.done_at
    ? lowerNextDue(env.SCHEDULE, new Date(made.due_at), env.JOBS)
    : Promise.resolve()

const keyed = async (db: OrgScopedDb, key: string) => {
  const [row] = await db
    .select()
    .from(reminders)
    .where(eq(reminders.idempotencyKey, key))
  return row
}

/**
 * A new reminder, or the one an earlier call with the same key made: the
 * key is looked up before anything is checked, so a retry after the due time
 * has passed still gets the first row. A due time more than 5 minutes gone,
 * or more than 366 days ahead, is refused rather than moved. A refusal is the
 * §28.1 envelope as a 400 `Response`; anything else the database refuses is
 * thrown, since its outcome is unknown. `input` has passed
 * `CreateReminderRequest`; `conversationId` must be a conversation of the
 * org's, and `createdByStaffId` a staff row of the org's.
 */
export async function createReminder(
  db: OrgScopedDb,
  made: {
    orgId: string
    createdByStaffId: string
    source: Reminder["source"]
    conversationId: string | null
    idempotencyKey: string
  },
  input: CreateReminderRequest,
  now: Date = new Date()
): Promise<Reminder | Response> {
  const kept = await keyed(db, made.idempotencyKey)
  if (kept) return toReminder(kept)
  // Postgres refuses NUL in text, and a refusal there would be a 500.
  if (input.title.includes("\u0000")) return invalid([{ path: ["title"] }])
  const due = input.due_at === null ? null : new Date(input.due_at)
  const refused = dueRefused(due, now)
  if (refused) return refused
  const [row] = await db
    .insert(reminders)
    .values({
      orgId: made.orgId,
      title: input.title,
      dueAt: due,
      source: made.source,
      conversationId: made.conversationId,
      createdByStaffId: made.createdByStaffId,
      idempotencyKey: made.idempotencyKey,
    })
    .onConflictDoNothing()
    .returning()
  // A concurrent call with the key committed first: its row is the answer,
  // and it armed the job.
  if (!row) return toReminder((await keyed(db, made.idempotencyKey)) as Row)
  await armJob(db, made.orgId, row.id, due)
  return toReminder(row)
}

/** A title as two reminders for the same thing share it: case, spacing and stops aside. */
const sameJob = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/**
 * The open reminder `conversationId` already holds for `title`'s job, so
 * the assistant moves it instead of setting a second one. Null for none.
 */
export async function openTwin(
  db: OrgScopedDb,
  conversationId: string,
  title: string
): Promise<Reminder | null> {
  const rows = await db
    .select()
    .from(reminders)
    .where(
      sql`${reminders.conversationId} = ${conversationId} and ${reminders.doneAt} is null`
    )
  const twin = rows.find((r) => sameJob(r.title) === sameJob(title))
  return twin ? toReminder(twin) : null
}

/** Why a due time is refused, or null when it is in range. */
function dueRefused(due: Date | null, now: Date): Response | null {
  if (due && due.getTime() < now.getTime() - PAST_MS) {
    return failure(400, {
      class: "validation",
      code: "reminder.due_past",
      message: "A reminder cannot be due in the past.",
      detail: {},
    })
  }
  if (due && due.getTime() > now.getTime() + AHEAD_MS) {
    return failure(400, {
      class: "validation",
      code: "reminder.due_far",
      message: "A reminder can be due at most a year ahead.",
      detail: {},
    })
  }
  return null
}

/**
 * Changes an open reminder's title or due time, moving its job with it. A
 * field left out stays. Null for an id the org does not hold or a reminder
 * already done; a due time out of range is the 400 `createReminder` answers.
 */
export async function updateReminder(
  db: OrgScopedDb,
  id: string,
  patch: { title?: string; due_at?: string | null },
  now: Date = new Date()
): Promise<Reminder | Response | null> {
  if (!Uuid.safeParse(id).success) return null
  if (patch.title?.includes("\u0000")) return invalid([{ path: ["title"] }])
  const due =
    patch.due_at === undefined
      ? undefined
      : patch.due_at === null
        ? null
        : new Date(patch.due_at)
  const refused = due === undefined ? null : dueRefused(due, now)
  if (refused) return refused
  const [row] = await db
    .update(reminders)
    .set({
      ...(patch.title !== undefined && { title: patch.title }),
      ...(due !== undefined && { dueAt: due }),
    })
    .where(sql`${reminders.id} = ${id} and ${reminders.doneAt} is null`)
    .returning()
  if (!row) return null
  if (due !== undefined) await armJob(db, row.orgId, id, due)
  return toReminder(row)
}

/** Deletes a reminder and its job. Null for an id the org does not hold. */
export async function deleteReminder(
  db: OrgScopedDb,
  id: string
): Promise<Reminder | null> {
  if (!Uuid.safeParse(id).success) return null
  await armJob(db, "", id, null)
  const [row] = await db
    .delete(reminders)
    .where(eq(reminders.id, id))
    .returning()
  return row ? toReminder(row) : null
}

/**
 * Completes a reminder or reopens it. Setting what is already set writes
 * nothing, so a retry keeps the first `done_at`. One conditional update, so
 * two racing calls cannot both write. Null for an id the org does not hold.
 */
async function setReminderDone(
  db: OrgScopedDb,
  id: string,
  done: boolean
): Promise<Reminder | null> {
  if (!Uuid.safeParse(id).success) return null
  const [changed] = await db
    .update(reminders)
    .set({ doneAt: done ? new Date() : null })
    .where(
      sql`${reminders.id} = ${id} and (${reminders.doneAt} is null) = ${done}`
    )
    .returning()
  if (changed) {
    // Reopened with its time still ahead, it fires again; a time gone by stays
    // in the notifications until it is done.
    const ahead = !done && changed.dueAt && changed.dueAt > new Date()
    await armJob(db, changed.orgId, id, ahead ? changed.dueAt : null)
    return toReminder(changed)
  }
  const [held] = await db.select().from(reminders).where(eq(reminders.id, id))
  return held ? toReminder(held) : null
}

/** Open reminders: soonest due first, undated after, then newest first. */
export async function readReminderNotes(db: OrgScopedDb): Promise<Reminder[]> {
  const rows = await db
    .select()
    .from(reminders)
    .where(sql`${reminders.doneAt} is null`)
    .orderBy(
      sql`${reminders.dueAt} asc nulls last, ${reminders.createdAt} desc, ${reminders.id} desc`
    )
    .limit(REMINDER_NOTES_MAX)
  return rows.map(toReminder)
}

const notFound = () =>
  failure(404, {
    class: "resource",
    code: "reminder.not_found",
    message: "No reminder with that id in this business.",
    detail: {},
  })

/**
 * The key space the Chief of Staff's `create_reminder` writes under, one key
 * per approval. The owner's route refuses it, so an owner key can never
 * replay an assistant row or the reverse.
 */
export const ASSISTANT_KEY_PREFIX = "approval:"

/**
 * `POST /reminders` when `id` is empty, `PATCH /reminders/:id` or
 * `DELETE /reminders/:id` otherwise. A delete needs no key: deleting twice
 * is the same as once, and the second answers 404.
 */
export async function reminderRoute(
  request: Request,
  env: Pick<Env, "SCHEDULE" | "JOBS">,
  kit: Tenancy,
  owner: Owner,
  id: string
): Promise<Response | null> {
  const method = request.method
  if (id === "" ? method !== "POST" : method !== "PATCH" && method !== "DELETE")
    return null
  if (method === "DELETE") {
    const gone = await kit.withOrg({ orgId: owner.orgId }, (db) =>
      deleteReminder(db, id)
    )
    return gone ? new Response(null, { status: 204 }) : notFound()
  }
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  if (key.startsWith(ASSISTANT_KEY_PREFIX)) {
    return failure(400, {
      class: "validation",
      code: "idempotency_key.reserved",
      message: "This Idempotency-Key is reserved for the assistant.",
      detail: {},
    })
  }
  const body = await readBody(request)
  if (id !== "") {
    const parsed = ReminderPatch.safeParse(body)
    if (!parsed.success) return invalid(parsed.error.issues)
    const row = await kit.withOrg({ orgId: owner.orgId }, (db) =>
      setReminderDone(db, id, parsed.data.done)
    )
    if (!row) return notFound()
    await wakeScheduler(env, row)
    return Response.json(row)
  }
  const parsed = CreateReminderRequest.safeParse(body)
  if (!parsed.success) return invalid(parsed.error.issues)
  const made = await kit.withOrg(
    { orgId: owner.orgId, workosUserId: owner.session.workosUserId },
    async (db) =>
      createReminder(
        db,
        {
          orgId: owner.orgId,
          createdByStaffId: (await ownerStaffId(db, {
            orgId: owner.orgId,
            workosUserId: owner.session.workosUserId,
            ownerName: owner.session.name ?? owner.session.email,
          })) as string,
          source: "owner",
          conversationId: null,
          idempotencyKey: key,
        },
        parsed.data
      )
  )
  // A replay answers as the first call did.
  if (made instanceof Response) return made
  await wakeScheduler(env, made)
  return Response.json(made, { status: 201 })
}
