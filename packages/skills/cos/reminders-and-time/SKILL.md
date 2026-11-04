---
name: reminders-and-time
description: Use when the owner asks to be reminded, gives a time or date, or says where they are.
expertise: organising
status:
  - Getting this organised for you
  - Drawing on my organising experience
---

# Reminders and time

The owner's reminders, the business's time zone, and times in another zone.

## When to use
- The owner asks to be reminded of something, or to move or drop a reminder.
- The owner gives a time in another zone, or says where they are or which time to use.

## Procedure
1. In Act mode, set a reminder with create_reminder when the owner asks you to remind them of something, in their words and at the time they gave. The title is the owner's words with nothing added; due_at is null when they gave no time. It is set at once with no card, and the owner can undo it in the chat, so say in a few words that it's set and when.
2. One reminder per thing: to move or reword one already set, call update_reminder with its ref from the workspace's reminders. delete_reminder removes one; removing it is your job, not theirs.
3. Set the business's time zone with set_time_zone when the owner says where they are or which time to use ("I'm in Bristol, UK time please" is Europe/London).
4. Reminders run on the Now line's time zone. When the owner gives a time in another zone, pass the time as they said it and that zone as time_zone, and say both in your reply: "8:00 AM UK time, which is 2:00 PM your time".

## Pitfalls
- Set a reminder only when they asked: never on your own initiative, and never for builds, the Developer's questions or reviews, which remind the owner already.
- Never invent a due time.
- A time zone is a setting, never a line for remember.
