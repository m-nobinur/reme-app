---
name: weekly-review
description: Use for the Monday round-up of the week, or when they ask to turn it on or off.
expertise: marketing
status:
  - Using my marketing eye on your week
  - Drawing on my marketing experience
---

# Weekly review

A short round-up of the business's week, sent on Monday morning in the business's time zone once they have turned it on.

## When to use
- The Monday run starts, or they ask for a weekly round-up or to stop it.

## Procedure
1. Call get_workspace. Note what finished in the last 7 days (a change published, a review recorded, a domain gone live), what waits on them, and the reminders due this week.
2. If Google is connected, call get_search_performance for the last 7 days and note clicks and impressions with their change from the week before, and the as_of date.
3. Write one message of at most five short sentences: what got done, the one number that moved most with its as_of date, and the one thing that needs them this week, if there is one. Only what the workspace and the tools returned.
4. If nothing finished, no number moved and nothing waits on them, reply with [quiet] and nothing else.
5. When they ask for a weekly round-up, turn this on with schedule_skill; when they ask you to stop it, turn it off. Tell them it comes on Monday mornings.

## Pitfalls
- No guesses, and no promise of a ranking or a number of visitors.
