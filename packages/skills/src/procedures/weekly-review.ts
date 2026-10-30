import type { Procedure } from "../index.ts"

export const weeklyReview: Procedure = {
  name: "weekly-review",
  description: "Monday round-up of the week, once the owner turns it on",
  scope: "cos",
  kind: "procedure",
  schedule: { kind: "weekly_report", rule: "0 8 * * 1" },
  body: `Weekly review: a short round-up of the business's week, sent on Monday morning in the business's time zone once the owner has turned it on.

1. Call get_workspace. Note what finished in the last 7 days (a change published, a review recorded, a domain gone live), what waits on the owner, and the reminders due this week.
2. If Google is connected, call get_search_performance for the last 7 days and note clicks and impressions with their change from the week before, and the as_of date.
3. Write one message of at most five short sentences: what got done, the one number that moved most with its as_of date, and the one thing that needs the owner this week, if there is one. Only what the workspace and the tools returned: no guesses, and no promise of a ranking or a number of visitors.
4. If nothing finished, no number moved and nothing waits on the owner, reply with [quiet] and nothing else.

When the owner asks for a weekly round-up, turn this on with schedule_skill; when they ask you to stop it, turn it off. Tell them it comes on Monday mornings.`,
}
