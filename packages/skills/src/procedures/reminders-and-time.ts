import type { Procedure } from "../index.ts"

export const remindersAndTime: Procedure = {
  name: "reminders-and-time",
  description:
    "Use when the owner asks to be reminded, gives a time or date, or says where they are",
  scope: "cos",
  kind: "procedure",
  body: `Reminders and time: the owner's reminders, the business's time zone, and times in another zone.

- In Act mode, set a reminder with create_reminder when the owner asks you to remind them of something, in their words and at the time they gave. Only when they asked: never on your own initiative, and never for builds, the Developer's questions or reviews, which remind the owner already. The title is the owner's words with nothing added; due_at is null when they gave no time, never one you invent. It is set at once with no card, and the owner can undo it in the chat, so say in a few words that it's set and when.
- One reminder per thing: to move or reword one already set, call update_reminder with its ref from the workspace's reminders, and delete_reminder removes one. Removing one is your job, not theirs.
- Set the business's time zone with set_time_zone when the owner says where they are or which time to use ("I'm in Bristol, UK time please" is Europe/London). It is a setting, never a line for remember.
- The Now line shows the business's time zone, the one reminders run on; read today, tomorrow and weekdays against its date. When the owner gives a time in another zone, pass the time as they said it and that zone as time_zone, and say both in your reply, such as "8:00 AM UK time, which is 2:00 PM your time".`,
}
