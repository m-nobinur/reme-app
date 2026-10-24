import { z } from "zod"
import { TimeZone } from "./chat.ts"
import { Timestamp, Uuid } from "./common.ts"

// Row shapes for the scheduler and the delivery outbox, and the org columns
// they read. Reminders, the heartbeat and the weekly report are all rows in
// `scheduled_jobs`; the Cron Trigger claims the due ones and the Queue
// consumer runs each under `withOrg`.

/**
 * `reminder` points at a `reminders` row through `ref_id`. The other two are
 * one job per org and have no referent.
 */
export const JobKind = z.enum(["reminder", "heartbeat", "weekly_report"])

/**
 * `rule` is a cron expression read in `orgs.time_zone`, and null for a
 * one-off. `next_run_at` is UTC and recomputed from the rule after each run.
 * `failures` counts runs in a row that failed; the job is paused at five.
 */
export const ScheduledJob = z.strictObject({
  id: Uuid,
  org_id: Uuid,
  kind: JobKind,
  ref_id: Uuid.nullable(),
  rule: z.string().min(1).max(200).nullable(),
  next_run_at: Timestamp,
  /** When the Cron Trigger took the job. Cleared when the run ends. */
  claimed_at: Timestamp.nullable(),
  /** When the last run ended. */
  last_run_at: Timestamp.nullable(),
  failures: z.int().nonnegative(),
  paused_at: Timestamp.nullable(),
  created_at: Timestamp,
})

/**
 * One row per `(job_id, run_at)`, so a redelivered Queue message finds its run
 * already written. `org_id` is here for the row's isolation policy.
 */
export const JobRun = z.strictObject({
  job_id: Uuid,
  org_id: Uuid,
  run_at: Timestamp,
  outcome: z.enum(["ok", "skipped", "failed"]),
  /** What happened, for an operator. Never shown to the owner. */
  detail: z.string().max(500).nullable(),
})

/**
 * The outbox. `key` is the idempotency key: one per message and channel, so
 * a second insert is a no-op and nothing sends twice. `suppressed` is a
 * recipient the provider refused for good, and turns the channel off.
 * `sending` is a consumer's claim until `lease_until`; `unknown` is an email
 * whose send may have left and is never sent again.
 */
export const Delivery = z.strictObject({
  org_id: Uuid,
  key: z.string().min(1).max(200),
  channel: z.enum(["in_app", "email", "push"]),
  state: z.enum([
    "pending",
    "sending",
    "unknown",
    "sent",
    "failed",
    "suppressed",
  ]),
  attempts: z.int().nonnegative(),
  sent_at: Timestamp.nullable(),
  error: z.string().max(500).nullable(),
  lease_until: Timestamp.nullable(),
  created_at: Timestamp,
})

/**
 * The hosts the browsers' push services answer on (Chrome and Edge's FCM,
 * Firefox, Safari, Windows). The server posts to a stored endpoint, so a
 * subscription may not aim it anywhere else: no other host, port or userinfo.
 */
export const PUSH_ENDPOINT =
  /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\/[^\s]*$/

/**
 * `POST /push/subscriptions`: what a browser's `PushSubscription.toJSON()`
 * holds, less the expiry.
 */
export const PushSubscribeRequest = z.strictObject({
  endpoint: z.string().max(2000).regex(PUSH_ENDPOINT),
  keys: z.strictObject({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
})

/** The subscription's id, which `DELETE /push/subscriptions/{id}` takes. */
export const PushSubscribed = z.strictObject({ id: Uuid })

/**
 * `GET /push/config`: the VAPID public key a browser subscribes with, or null
 * where push is not set up and the settings page offers nothing.
 */
export const PushConfig = z.strictObject({
  public_key: z.string().min(1).max(200).nullable(),
})

/** Wall-clock time of day in the org's zone, as `HH:MM`. */
const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/**
 * How often the heartbeat looks: `off` never, then every 8 hours, 4 hours
 * and hour. A reminder the owner asked for ignores the dial.
 */
export const Proactivity = z.enum(["off", "low", "default", "high"])

/**
 * The `orgs` columns that time depends on. `time_zone` is null until the
 * browser first reports its zone, on loading the app or in a chat turn. Quiet hours default to 21:00
 * to 08:00 and may cross midnight, so `quiet_start` after `quiet_end` is
 * normal; equal values mean no quiet hours.
 */
export const OrgSchedule = z.strictObject({
  time_zone: TimeZone.nullable(),
  quiet_start: LocalTime,
  quiet_end: LocalTime,
  proactivity: Proactivity,
})

/**
 * `PUT /time-zone`: the zone the owner's browser keeps, sent when the app
 * loads, so the org's zone is right before the first chat turn and follows
 * the owner when they move. Answered 204, the same zone again included.
 */
export const SetTimeZoneRequest = z.strictObject({ time_zone: TimeZone })

export type JobKind = z.infer<typeof JobKind>
export type ScheduledJob = z.infer<typeof ScheduledJob>
export type JobRun = z.infer<typeof JobRun>
export type Delivery = z.infer<typeof Delivery>
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>
export type PushSubscribed = z.infer<typeof PushSubscribed>
export type PushConfig = z.infer<typeof PushConfig>
export type Proactivity = z.infer<typeof Proactivity>
export type OrgSchedule = z.infer<typeof OrgSchedule>
export type SetTimeZoneRequest = z.infer<typeof SetTimeZoneRequest>
