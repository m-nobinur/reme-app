import {
  CreateReminderRequest,
  REMINDER_NOTES_MAX,
  Reminder,
  ReminderPatch,
  Uuid,
} from "@workspace/contracts"
import {
  eq,
  type OrgScopedDb,
  reminders,
  sql,
  type Tenancy,
} from "@workspace/db"
import type { Owner } from "./changes.ts"
import {
  failure,
  idempotencyKey,
  invalid,
  keyMissing,
  readBody,
} from "./http.ts"
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
  // A concurrent call with the key committed first: its row is the answer.
  return toReminder(row ?? ((await keyed(db, made.idempotencyKey)) as Row))
}

/**
 * Completes a reminder or reopens it. Setting what is already set writes
 * nothing, so a retry keeps the first `done_at`. One conditional update, so
 * two racing calls cannot both write. Null for an id the org does not hold.
 */
export async function setReminderDone(
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
  if (changed) return toReminder(changed)
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

/** `POST /reminders` when `id` is empty, `PATCH /reminders/:id` otherwise. */
export async function reminderRoute(
  request: Request,
  kit: Tenancy,
  owner: Owner,
  id: string
): Promise<Response | null> {
  const method = request.method
  if (id === "" ? method !== "POST" : method !== "PATCH") return null
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const body = await readBody(request)
  if (id !== "") {
    const parsed = ReminderPatch.safeParse(body)
    if (!parsed.success) return invalid(parsed.error.issues)
    const row = await kit.withOrg({ orgId: owner.orgId }, (db) =>
      setReminderDone(db, id, parsed.data.done)
    )
    return row ? Response.json(row) : notFound()
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
  return made instanceof Response ? made : Response.json(made, { status: 201 })
}
