import type { ActivitySegment } from "@workspace/contracts"
import { expect, it } from "vitest"
import type { Workspace } from "./api/types"
import { checklistFor } from "./website-checklist"

const NOW = new Date("2026-10-22T12:00:00.000Z")
const ZONE = "Europe/London"

const seg = (
  kind: ActivitySegment["kind"],
  state: ActivitySegment["state"],
  over: Partial<ActivitySegment> = {}
): ActivitySegment => ({
  id: kind,
  kind,
  state,
  steps: [],
  at: "2026-10-22T11:00:00.000Z",
  ...over,
})

const workspace = (
  standing: ActivitySegment[] | undefined,
  over: Partial<Workspace> = {},
  journey: ActivitySegment[] = []
): Workspace =>
  ({
    live: 3,
    host: "spark.example.com",
    url: "https://spark.example.com",
    assistantName: "Ellie",
    activity: {
      journey,
      now: [],
      waiting: [],
      upcoming: [],
      done: [],
      ...(standing && { standing }),
    },
    ...over,
  }) as Workspace

const summary = (rows: ReturnType<typeof checklistFor>) =>
  rows.map((r) => `${r.id}|${r.mark}|${r.line}|${r.action?.label ?? "-"}`)

it("lists a live site with its own domain and Google, with each next action", () => {
  const rows = checklistFor(
    workspace([
      seg("golive", "done"),
      seg("domain", "done", { id: "d", names: { domain: "spark.co.uk" } }),
      seg("google", "done", { synced_at: "2026-10-22T09:30:00.000Z" }),
    ]),
    ZONE,
    NOW
  )
  expect(summary(rows)).toEqual([
    "published|done|Published today, 12:00 pm|Visit your website",
    "address|done|spark.example.com|-",
    "d|done|Live|-",
    "google|done|Verified, pages sent. Data read today, 10:30 am|-",
  ])
  expect(rows[2]?.title).toBe("spark.co.uk")
})

it("offers a domain and Google when the site has neither", () => {
  expect(
    summary(checklistFor(workspace([seg("golive", "done")]), ZONE, NOW))
  ).toEqual([
    "published|done|Published today, 12:00 pm|Visit your website",
    "address|done|spark.example.com|Use your own domain",
    "google|next|Not connected|Connect Google",
  ])
})

it("shows a domain waiting on the owner, a purchase with its renewal and Google signing in", () => {
  const rows = checklistFor(
    workspace([
      seg("golive", "done"),
      seg("domain", "waiting", { id: "a", names: { domain: "a.co.uk" } }),
      seg("purchase", "done", { id: "b", names: { domain: "b.co.uk" } }),
      seg("purchase", "upcoming", {
        id: "renewal",
        at: "2027-10-01T00:00:00.000Z",
        names: { domain: "b.co.uk" },
      }),
      seg("google", "waiting"),
    ]),
    ZONE,
    NOW
  )
  expect(summary(rows).slice(2)).toEqual([
    "a|waiting|Waiting for your DNS change|Show the change",
    "b|done|Renews 1 October 2027|-",
    "google|waiting|Waiting for you to sign in|Sign in again",
  ])
})

it("marks a stopped job and asks what happened", () => {
  const rows = checklistFor(
    workspace([seg("golive", "done"), seg("google", "failed")]),
    ZONE,
    NOW
  )
  expect(summary(rows).at(-1)).toBe(
    "google|failed|The Google connection stopped. Ask Ellie to try again.|Ask what happened"
  )
})

it("sends the owner to the approval before the first publish, and waits on go-live otherwise", () => {
  const site = { live: null, url: null, host: null }
  const waiting = checklistFor(
    workspace([], site, [seg("golive", "waiting")]),
    ZONE,
    NOW
  )
  expect(summary(waiting)[0]).toBe(
    "published|waiting|Waiting for your approval|Review it"
  )
  expect(summary(waiting).at(-1)).toBe(
    "google|next|Connect it once your website is live|-"
  )
  expect(summary(checklistFor(workspace([], site), ZONE, NOW))[0]).toBe(
    "published|next|Not published yet|-"
  )
})

it("says no time before the reader's zone is known, and no Google without the standing group", () => {
  expect(
    summary(checklistFor(workspace([seg("golive", "done")]), null, NOW))[0]
  ).toBe("published|done|Published|Visit your website")
  // An api older than the page: Google's state is unknown, so no row.
  const rows = checklistFor(workspace(undefined), ZONE, NOW)
  expect(summary(rows)).toEqual([
    "published|done|Published|Visit your website",
    "address|done|spark.example.com|-",
  ])
})
