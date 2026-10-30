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

/** "Tuesday 20 October at 9:00 AM BST", in the org's zone (UTC when it has none). */
function whenOf(at: Date, zone: string | null): string {
  const timeZone = zone ?? "UTC"
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at)
  // en-GB for BST rather than GMT+1, with its "am" in capitals as the app writes it.
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
    .format(at)
    .replace(/\b(am|pm)\b/, (period) => period.toUpperCase())
  return `${day} at ${time}`
}

export const reminderJob: Handler = async ({ db, env, job, now }) => {
  const [reminder] = job.refId
    ? await db.select().from(reminders).where(eq(reminders.id, job.refId))
    : []
  if (!reminder) return { outcome: "no_change", detail: "gone" }
  if (reminder.doneAt) return { outcome: "no_change", detail: "done" }
  if (!reminder.dueAt) return { outcome: "no_change", detail: "no_due" }

  const [org] = await db.select({ zone: orgs.timeZone }).from(orgs)
  const lines = [`Reminder: “${reminder.title}”`]
  if (now.getTime() - reminder.dueAt.getTime() > LATE_MS)
    lines.push(`It was due on ${whenOf(reminder.dueAt, org?.zone ?? null)}.`)

  // The occurrence is the key's tail: a reminder moved to a new time is a new
  // delivery, and a rerun of this one is not.
  const key = `reminder:${reminder.id}:${reminder.dueAt.toISOString()}`
  const sends = [
    await deliverIn(db, env, {
      orgId: reminder.orgId,
      key,
      channel: "in_app",
      message: { text: lines },
      // Null for the owner's own, which goes to the newest conversation.
      ...(reminder.conversationId && {
        conversationId: reminder.conversationId,
      }),
    }),
  ]

  // shortcut: the owner's latest typed message stands for "in the app", since
  // nothing records a visit. Add a last-seen column if email should hold back
  // for an owner who only reads.
  const [active] = await db.execute<{ active: boolean }>(sql`
    select exists (
      select 1 from ${conversationMessages}
      where content->>'role' = 'user'
        and created_at >= ${reminder.createdAt.toISOString()}::timestamptz
    ) as active`)
  if (!active?.active)
    sends.push(
      await deliverIn(db, env, {
        orgId: reminder.orgId,
        key: `${key}:email`,
        channel: "email",
        // One line: a title with a line break must not reach the header.
        subject: `Reminder: ${reminder.title.replace(/\s+/g, " ")}`,
        text: lines.join("\n\n"),
      })
    )
  return {
    outcome: "done",
    detail: sends.length > 1 ? "in_app,email" : "in_app",
    // The Queue hears of them only once the row is committed.
    after: async () => {
      await Promise.all(sends.map((send) => send?.()))
    },
  }
}
