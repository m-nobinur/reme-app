import { describe, expect, it } from "vitest"
import { Delivery, JobRun, OrgSchedule, ScheduledJob } from "../src/schedule.ts"
import { ACCEPTED, REFUSED, verdict } from "./json-schema.ts"
import { samples } from "./samples.ts"

describe("ScheduledJob", () => {
  const job = samples.ScheduledJob as Record<string, unknown>

  it.each([
    ["a one-off reminder", job],
    ["a claimed job", { ...job, claimed_at: "2026-08-27T09:30:00Z" }],
    [
      "a recurring job",
      { ...job, kind: "heartbeat", ref_id: null, rule: "0 */4 * * *" },
    ],
    [
      "a paused job",
      { ...job, failures: 5, paused_at: "2026-08-27T09:30:00Z" },
    ],
  ])("accepts %s", (_name, value) => {
    expect(verdict("ScheduledJob", ScheduledJob, value)).toEqual(ACCEPTED)
  })

  it.each([
    ["another kind", { ...job, kind: "digest" }],
    ["no next run", { ...job, next_run_at: undefined }],
    [
      "a next run with no offset",
      { ...job, next_run_at: "2026-08-27T09:30:00" },
    ],
    ["an empty rule", { ...job, rule: "" }],
    ["no claim field", { ...job, claimed_at: undefined }],
    ["a negative failure count", { ...job, failures: -1 }],
    ["no org", { ...job, org_id: undefined }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("ScheduledJob", ScheduledJob, value)).toEqual(REFUSED)
  })
})

describe("JobRun", () => {
  const run = samples.JobRun as Record<string, unknown>

  it.each([
    ["a run with no detail", run],
    ["a failed run", { ...run, outcome: "failed", detail: "timeout" }],
  ])("accepts %s", (_name, value) => {
    expect(verdict("JobRun", JobRun, value)).toEqual(ACCEPTED)
  })

  it.each([
    ["another outcome", { ...run, outcome: "sent" }],
    ["no run time", { ...run, run_at: undefined }],
    ["a detail past 500 characters", { ...run, detail: "x".repeat(501) }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("JobRun", JobRun, value)).toEqual(REFUSED)
  })
})

describe("Delivery", () => {
  const delivery = samples.Delivery as Record<string, unknown>

  it.each(["in_app", "email"])("accepts the %s channel", (channel) => {
    expect(verdict("Delivery", Delivery, { ...delivery, channel })).toEqual(
      ACCEPTED
    )
  })

  it.each(["pending", "sending", "unknown", "sent", "failed", "suppressed"])(
    "accepts the %s state",
    (state) => {
      expect(verdict("Delivery", Delivery, { ...delivery, state })).toEqual(
        ACCEPTED
      )
    }
  )

  it.each([
    ["a push channel, which comes later", { ...delivery, channel: "push" }],
    ["an empty key", { ...delivery, key: "" }],
    ["another state", { ...delivery, state: "queued" }],
    ["no attempt count", { ...delivery, attempts: undefined }],
    ["a fractional attempt count", { ...delivery, attempts: 1.5 }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("Delivery", Delivery, value)).toEqual(REFUSED)
  })
})

describe("OrgSchedule", () => {
  const schedule = samples.OrgSchedule as Record<string, unknown>

  it.each([
    ["the defaults", schedule],
    ["a zone not yet known", { ...schedule, time_zone: null }],
    [
      "quiet hours inside one day",
      { ...schedule, quiet_start: "13:00", quiet_end: "14:30" },
    ],
    ["the off dial", { ...schedule, proactivity: "off" }],
    ["the low dial", { ...schedule, proactivity: "low" }],
    ["the high dial", { ...schedule, proactivity: "high" }],
  ])("accepts %s", (_name, value) => {
    expect(verdict("OrgSchedule", OrgSchedule, value)).toEqual(ACCEPTED)
  })

  it.each([
    ["24:00", { ...schedule, quiet_start: "24:00" }],
    ["seconds in a quiet time", { ...schedule, quiet_end: "08:00:00" }],
    ["a quiet time with no zero pad", { ...schedule, quiet_end: "8:00" }],
    ["another dial", { ...schedule, proactivity: "always" }],
    ["a zone with a space", { ...schedule, time_zone: "New York" }],
    ["no dial", { ...schedule, proactivity: undefined }],
  ])("refuses %s", (_name, value) => {
    expect(verdict("OrgSchedule", OrgSchedule, value)).toEqual(REFUSED)
  })
})
