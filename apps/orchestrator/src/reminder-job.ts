import { conversationMessages, eq, orgs, reminders, sql } from "@workspace/db"
import { deliverIn } from "./deliveries.ts"
import type { Handler } from "./jobs.ts"

/**
 * The `reminder` job (ADR-043): says the reminder in its conversation, and by
 * email when the owner has not been in the app since they set it. The words
 * are a fixed template, no model. Owner-set reminders ignore quiet hours, so
 * nothing here looks at them.
 */

/** A run later than this says when the reminder was due. */
const LATE_MS = 5 * 60_000

/** "Tuesday 20 October at 09:00 BST", in the org's zone (UTC when it has none). */
function whenOf(at: Date, zone: string | null): string {
  const timeZone = zone ?? "UTC"
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at)
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at)
  return `${day} at ${time}`
}

export const reminderJob: Handler = async ({ db, env, job, now }) => {
  const [reminder] = job.refId
    ? await db.select().from(reminders).where(eq(reminders.id, job.refId))
    : []
  if (!reminder) return { outcome: "skipped", detail: "gone" }
  if (reminder.doneAt) return { outcome: "skipped", detail: "done" }
  if (!reminder.dueAt) return { outcome: "skipped", detail: "no_due" }

  const [org] = await db.select({ zone: orgs.timeZone }).from(orgs)
  const lines = [`Reminder: “${reminder.title}”`]
  if (now.getTime() - reminder.dueAt.getTime() > LATE_MS)
    lines.push(`It was due on ${whenOf(reminder.dueAt, org?.zone ?? null)}.`)

  // The occurrence is the key's tail: a reminder moved to a new time is a new
  // delivery, and a rerun of this one is not.
  const key = `reminder:${reminder.id}:${reminder.dueAt.toISOString()}`
  await deliverIn(db, env, {
    orgId: reminder.orgId,
    key,
    channel: "in_app",
    message: { text: lines },
    // Null for the owner's own, which goes to the newest conversation.
    ...(reminder.conversationId && {
      conversationId: reminder.conversationId,
    }),
  })

  // shortcut: the owner's latest typed message stands for "in the app", since
  // nothing records a visit. Add a last-seen column if email should hold back
  // for an owner who only reads.
  const [active] = await db.execute<{ active: boolean }>(sql`
    select exists (
      select 1 from ${conversationMessages}
      where content->>'role' = 'user'
        and created_at >= ${reminder.createdAt.toISOString()}::timestamptz
    ) as active`)
  if (active?.active) return { outcome: "ok", detail: "in_app" }
  await deliverIn(db, env, {
    orgId: reminder.orgId,
    key: `${key}:email`,
    channel: "email",
    // One line: a title with a line break must not reach the header.
    subject: `Reminder: ${reminder.title.replace(/\s+/g, " ")}`,
    text: lines.join("\n\n"),
  })
  return { outcome: "ok", detail: "in_app,email" }
}
