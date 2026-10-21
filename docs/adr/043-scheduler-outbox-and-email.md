# ADR-043: A Postgres scheduler, one outbox, and email both ways through Cloudflare

Status: proposed, 2026-10-19. Applies to `apps/orchestrator`, `apps/api`, `packages/db`,
`packages/contracts` and `infra/`. Implements the outbox §13 describes and §28.2 says exists, which
it did not. Changes no DR. Email provider decided by the owner on 2026-10-19; `4-integrations.md`
§3 says the same.

## Context

Reminders are stored and never fire: nothing reads `reminders.due_at` except the list sort. No
scheduled job ever runs the Chief of Staff, so it cannot speak first, and the weekly search report
runs at Monday 07:00 UTC whatever the owner's zone. Every message that leaves Reme goes through
its own path: `postAssistantMessage` for in-app, the `ALERTS` `send_email` binding for uptime
alerts, nothing for an owner's email.

Two limits shape the answer. Hyperdrive allows no advisory locks or session state across
statements. Both Neon projects are on Free, which suspends a compute after 5 idle minutes and
allows 100 CU-hours a month; a query every minute would keep production awake all month and get
it suspended.

## Decision

**Jobs are rows.** `scheduled_jobs (id, org_id, kind, ref_id, rule, next_run_at, last_run_at,
failures, paused_at, created_at)`, kind `reminder`, `heartbeat` or `weekly_report`, with a partial
index on `next_run_at where paused_at is null`. `rule` is a cron expression read in the org's zone
with `croner` 10.0.1, pinned, and null for a one-off. `next_run_at` is stored in UTC and
recomputed after each run. A reminder's job is written in the same transaction as the reminder,
and editing or finishing the reminder updates or deletes it.

**A cron claims, a Queue runs.** A Cron Trigger at `* * * * *` in the orchestrator, in both
environments, reads the earliest `next_run_at` from KV first and queries Postgres only when
something is due. Each scan writes the new earliest time back. So a quiet minute costs one KV read
and no Postgres wake-up.

The KV key `jobs:next-due` (binding `SCHEDULE`, one namespace shared by the orchestrator and the
api) holds `{next, scanned}`: the earliest due time and when Postgres was last scanned. The cron
returns without a query when `next` is in the future and the last scan is under 55 minutes old.
KV can only ever hold a time later than the truth, through a lost write, two writers racing, or
a write not yet propagated, and the fallback scan finds the job from its own row, so the worst a
KV fault does is delay a job to the next hourly scan. A scan claims up to 100 jobs, sends one
message each, then writes `next_due_at()` back. When the send fails, the scan clears those claims
at once and leaves KV due, so the jobs wait a minute rather than the 20-minute lease. Anything that creates a job or moves one earlier
calls `lowerNextDue` from `@workspace/db` after its commit, which stores `min(stored, at)` and
never throws.

**A wake makes it punctual.** KV alone was not enough. On staging a reminder due at 20:04:59 was
claimed at the 20:07 tick, because the api's write had not reached the location the cron ran in,
and the cron's read is cached for a minute on top. So `lowerNextDue` also takes the `JOBS` queue
and sends `{kind: "scan"}` with `delaySeconds` set to one second past the due time. The jobs
consumer answers a scan message with `scanDue(..., force)`, which skips the KV check, claims what
is due and sends it back to the same queue. The message names no job, so a duplicate or a stale
one costs one claim. It is sent for anything within the queue's 12-hour delay limit, and later
times wait for the cron. The api, the CoS tool and the job runner all wake; the retention sweep's
heartbeat does not need to. The minute cron and its KV guard stay as the fallback.

The claim is one `SECURITY DEFINER` function, `claim_due_jobs(limit)`, a single statement with
`FOR UPDATE SKIP LOCKED` that returns `(job_id, org_id)` and nothing else. `next_due_at()`
(migration 0021) is the second for the scheduler: one timestamp, no ids, with a claimed row
counted from the end of its 20-minute lease so a dead consumer's job comes back without waiting
for the fallback scan. The tenancy suite probes both functions' shapes. Every claimed job goes to
a Queue as one message, and the consumer runs it under `withOrg`.

**A run happens once.** `job_runs (job_id, org_id, run_at, outcome, detail)` is unique on
`(job_id, run_at)`. The consumer locks the job and runs it only if it is still claimed, unpaused
and due; then it inserts the run with `on conflict do nothing`, so a redelivered message, even one
racing the first, finds the run written and does nothing. The insert, the handler and the move to
the next time are one transaction: a crash leaves nothing behind and the job is retaken when its
claim lapses. A handler therefore writes only to Postgres, sends through the outbox, and fits
inside `withOrg`'s 15-second idle limit. A kind with no handler is recorded `skipped`.

Success clears `claimed_at` and `failures` and moves `next_run_at` to the rule's next time after
now, or pauses a one-off for good. Computing from now collapses missed fires: a daily job down
for three days runs once, never three times. When `orgs.time_zone` changes, `recomputeOrgJobs`
(in `@workspace/db`, with `nextRun`) moves the org's upcoming recurring jobs into the new zone in
the same transaction. A failed run rolls back, is recorded `failed` in a transaction
of its own, and backs off `min(60, 2^failures)` minutes. The fifth failure in a row pauses the job,
raises `alert.raised` `{kind: "job.paused"}` and posts one fixed chat message, keyed by the pause
so it posts once. A job whose org is closed (ADR-035) is paused without running, and deleting the
account deletes the org's jobs.

Across a DST change croner keeps wall-clock meaning: a time that happens twice fires once, at the
first; a time the clocks skip fires an hour later (02:30 becomes 03:30). An hourly rule skips the
repeated hour. Rules are five-part cron, so nothing runs more often than the cron does.

**One outbox.** `deliveries (org_id, key, channel, state, attempts, sent_at, error)`, unique on
`(org_id, key)`. The key names the cause, such as `reminder:<id>` or
`heartbeat:<org>:<job>:<slot>`, never the time sent. A second insert is a no-op, so nothing sends
twice. A Queue consumer sends: in-app through `postAssistantMessage`, email through the
`send_email` binding. A reminder goes to `reminders.conversation_id`, not the newest conversation.

**The heartbeat.** Each org has one `heartbeat` job, with its rule set by `orgs.proactivity` in
the org's zone: `off` has no job, `low` runs every 8 hours, `default` every 4 and `high` hourly.
A time inside quiet hours (`quiet_start` to `quiet_end`, 21:00 to 08:00 by default, which may
cross midnight) moves to their end by wall clock, so 08:00 stays 08:00 across a DST change.
Signup makes the job and the hourly sweep ensures it for every org, so existing orgs need no
backfill; whatever later changes the dial calls the same `ensureHeartbeat`, and a change of zone
or quiet hours calls `recomputeOrgJobs`. Quiet hours apply to the heartbeat only: a reminder
fires at the time the owner named.

The handler stops with no model call in quiet hours (a retry's backoff can land there) and when
the org had a CoS turn in the last 15 minutes, since the owner is in the chat. Otherwise it reads
a digest in code: reviews recorded, Developer questions waiting, approvals waiting over a day,
reminders due in the next 24 hours, and site, domain and search alerts. Each item is
`{key: "<kind>:<entity id>:<seq>", since, facts}`, sorted by key, with absolute times only, so
the same state read an hour later is the same digest. A ledger drops items already surfaced: a
`deliveries` row keyed `heartbeat-item:<org>:<item key>`, inserted if absent and never sent. It is
written before any model runs, so a model that fails does not raise the same items again. A
digest query that fails rolls the run back, ledger included, so a source error is not a change.
An empty digest, or one with nothing new, ends the run `skipped`. `job_outcome` has no
`owner_active` or `error` value and adding one needs a migration, so those runs are `skipped`
and `failed` with the reason in `detail`.

New items go to two models after the run commits, in its `after`. First Jev
(`typesafe/jev-1.13` through the AI SDK provider's `evaluationModel`, the second Jev caller)
answers "Is any of this worth interrupting the owner for now?" over the scrubbed items and the
owner profile, asked as three yes-or-no questions (does an item need the owner to decide or act,
did something go wrong that visitors would notice, is it news the owner would want today), and
the beat goes on when the likeliest reaches 0.3. Jev is a floor that stops plain noise; the
writer, told the dial's bar, judges the rest. On the 30 labelled digests in `evals/heartbeat`
(2026-10-21) the floor agreed with the labels on 25, against 24 for a bar per dial (low 0.9,
default 0.6, high 0.5) and 15 for one question at the bars first planned (0.95, 0.9, 0.8), which
Jev never reached: one question scored every digest between 0.15 and 0.68. The labels are the
coordinator's seed, so the floor and the writer's bar are to be rechecked on the owner's labels
and on the dismiss rate of the first 50 real heartbeats. On a yes
the beat takes the day's one unprompted message, a `deliveries` row keyed
`unprompted:<org>:<local date>` inserted if absent; already taken, it stops before the writer.
The writer is `openai/gpt-6.1-sol` at low effort on the CoS's OpenRouter routing, with no tools,
the items as data, the profile, and its own last heartbeat and its date. The prompt sets the bar
by dial (low: something finished or a decision; default: real progress or news the owner would
want; high: short updates even when on track) and allows `[quiet]` with a reason, read by
hermes' loose rule. Code checks the message: at most 3 sentences, 450 characters and one
question, and no link, email address or phone number that a fact the item vouches for (an
alert's host, a title the owner wrote) does not hold exactly. A quiet, failed or refused reply
gives the day back, so a later beat can still speak; the reason goes in `job_runs.detail`. A
message goes in-app keyed `heartbeat:<org>:<job>:<slot>`, and by email too when the owner has
not typed since the last heartbeat, which the daily cap keeps to one a day. Each Jev and writer
call is logged as a `cos.background_step` (`job: heartbeat_gate` or `heartbeat_writer`), so the
CoS's daily cap counts it.

The weekly search report is a heartbeat item on the org's own Monday (`search_report:<ISO
week>:1`, or `search_report:connect:1` for the one ask to connect), so the report and the
heartbeat coalesce into one message and the report follows the owner's zone. The sweep's Monday
07:00 UTC step is gone. Nothing creates a `weekly_report` job any more; the value stays in
`job_kind` and the contract until a migration can drop it.

**Updates the owner set in motion are worded by the model.** The site-live line, the Search
Console announcement and the domain nudge, live and failed lines go through one function,
`writeUpdate`: the facts (hosts, the domain, its DNS provider, the 3-day limit) and today's
fixed text go to the same writer at low effort with a 15-second limit, since each runs inside a
Workflow step. The model's text is used only when every fact's value appears in it verbatim, it
holds no number the facts do not, no link or phone number other than theirs, and it keeps the
heartbeat's limits; otherwise, on any error, or with no key, the fixed text is sent. Each call
is a `cos.background_step` (`job: update`). `statusText`'s DNS records and the no-model lines
(`ASK_REPLY`, `NO_ANSWER`, `PLANNED_ERROR`) stay fixed. These lines answer the owner's own
actions, so quiet hours do not apply to them.

**Email out is Cloudflare Email Sending** on a `send_email` binding, after
`wrangler email sending enable remeai.co.uk`, which also adds the DMARC record the domain lacks.
3,000 a month are included, then $0.35 per 1,000. `E_RECIPIENT_SUPPRESSED` turns the owner's
email channel off. An email carries no secret and no session link: it links to the app, which
asks for sign-in, and to the notification settings.

**Email in is Email Routing to an Email Worker on `reply.remeai.co.uk`.** Every outbound email
sets `Reply-To: reply+<token>@reply.remeai.co.uk`; plus addressing routes every token to one rule.
Each environment has its own base address (`REPLY_MAILBOX`: production `reply@reply.remeai.co.uk`,
staging `reply@reply-stg.remeai.co.uk`), because one routing rule sends an address to one Worker.
Its local part is at most 7 characters, so it, the `+` and the 56-character token fit the
64-character limit; if subaddressing does not route on a subdomain, short names on the apex
(`reply@`, `rstg@`) work with no code change.
The token is HMAC-signed and bound to one org and one conversation. The Worker's `email()` handler
parses MIME with `postal-mime` 4.0.11, drops mail without an SPF or DKIM pass aligned with the
sender's DMARC, drops a sender that is not an owner of that org, strips quoted history, caps the
body and stores it with `untrusted_input` taint as the owner's message in that conversation. An
emailed "yes" approves nothing: a reply can add information, never run a card.

**Background work runs in Queue consumers, never `ctx.waitUntil`**, which stops at 30 seconds
with no retry. Approvals that wait outside chat keep using Workflows `waitForEvent`.

## What was rejected

- **A Workflow per reminder.** $54 to $111 a month at 10,000 orgs against about $8, and an
  instance id cannot be reused when a reminder is edited.
- **A Durable Object per org.** It splits job state between SQLite and Postgres and puts it
  outside RLS, branching and backups.
- **Querying Postgres every minute.** It keeps Neon Free awake all month; the KV guard is the
  price of the per-minute cron.
- **Resend as the primary sender.** A new vendor and API key for 100 a day free or $20 for
  50,000, against a binding type we already deploy. It stays the fallback.
- **An inbound email webhook.** A public endpoint with a signature to verify, where the Email
  Worker runs inside our own Worker with neither.

## Consequences

- Production gains a per-minute cron next to the hourly one. The uptime check stays hourly.
- `orgs` gains `time_zone`, `quiet_start`, `quiet_end` and `proactivity`. The weekly report, the
  daily spend cap's day and printed dates move to the org's zone; Google's Pacific day stays.
- Onboarding `remeai.co.uk` for sending and `reply.remeai.co.uk` for routing are one-time
  Cloudflare steps per account, done when the owner pushes.
- Email Sending is a public beta. Its starting daily quota for this account is not known yet.

## Change if

Email Sending misses on deliverability or quota during its beta (move out to Resend; inbound
stays); a heartbeat cadence needs finer than a minute; Neon moves to a paid plan, which lets the
KV guard go; or a customer-facing email channel arrives, which needs customer-scoped tokens and
the injection corpus suite first.
