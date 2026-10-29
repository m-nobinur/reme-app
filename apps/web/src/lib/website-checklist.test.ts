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
      seg("address", "done", { id: "d", names: { domain: "spark.co.uk" } }),
      seg("google", "done", { synced_at: "2026-10-22T09:30:00.000Z" }),
    ]),
    ZONE,
    NOW
  )
  expect(summary(rows)).toEqual([
    "published|done|Published today, 12:00 PM|Visit your website",
    "address|done|spark.example.com|-",
    "d|done|Live|-",
    "google|done|Verified, pages sent. Data read today, 10:30 AM|-",
  ])
  expect(rows[2]?.title).toBe("spark.co.uk")
})

it("shows Google's clicks and appearances for the last 28 days once it has sent some", () => {
  const rows = checklistFor(
    workspace([
      seg("golive", "done"),
      seg("google", "done", {
        synced_at: "2026-10-22T09:30:00.000Z",
        numbers: { clicks: 1, impressions: 340 },
      }),
    ]),
    ZONE,
    NOW
  )
  expect(summary(rows).at(-1)).toBe(
    "google|done|1 click and 340 appearances on Google in the last 28 days. Data read today, 10:30 AM|-"
  )
})

it("treats a task nothing has begun as no row, and offers it", () => {
  const unbegun = (kind: "address" | "google") =>
    seg(kind, "upcoming", { steps: [{ id: "find_out", state: "next" }] })
  expect(
    summary(
      checklistFor(
        workspace([
          seg("golive", "done"),
          unbegun("address"),
          unbegun("google"),
        ]),
        ZONE,
        NOW
      )
    )
  ).toEqual([
    "published|done|Published today, 12:00 PM|Visit your website",
    "address|done|spark.example.com|Use your own domain",
    "google|next|Connect it once your own domain is live|-",
  ])
})

it("offers a domain and Google when the site has neither", () => {
  expect(
    summary(checklistFor(workspace([seg("golive", "done")]), ZONE, NOW))
  ).toEqual([
    "published|done|Published today, 12:00 PM|Visit your website",
    "address|done|spark.example.com|Use your own domain",
    "google|next|Connect it once your own domain is live|-",
  ])
})

it("offers Google's own sign-in once the owner's domain is live, never a chat line", () => {
  const live = (domain: ActivitySegment) =>
    checklistFor(workspace([seg("golive", "done"), domain]), ZONE, NOW).at(-1)
  // The task is done, or the site is served on the domain already.
  for (const domain of [
    seg("address", "done", { id: "d", names: { domain: "spark.co.uk" } }),
    seg("address", "now", { id: "d", names: { domain: "spark.example.com" } }),
  ]) {
    expect(live(domain)).toMatchObject({
      line: "Not connected",
      action: { kind: "google", label: "Connect Google" },
    })
  }
  expect(
    live(seg("address", "now", { id: "d", names: { domain: "spark.co.uk" } }))
      ?.action
  ).toBeNull()
})

it("shows an address waiting on the owner, a bought one with its renewal, and Google signing in", () => {
  const waiting = (step: string) =>
    seg("address", "waiting", {
      id: "a",
      names: { domain: "a.co.uk" },
      steps: [{ id: step, state: "waiting" }],
    })
  const rows = (...segments: ActivitySegment[]) =>
    summary(
      checklistFor(workspace([seg("golive", "done"), ...segments]), ZONE, NOW)
    ).slice(2)
  expect(rows(waiting("records"), seg("google", "waiting"))).toEqual([
    "a|waiting|Waiting for your DNS change|Show the change",
    "google|waiting|Waiting for you to sign in|Sign in again",
  ])
  expect(rows(waiting("purchase"))[0]).toBe(
    "a|waiting|Waiting for your payment|Continue to payment"
  )
  expect(
    rows(
      seg("address", "done", { id: "b", names: { domain: "b.co.uk" } }),
      seg("purchase", "upcoming", {
        id: "renewal",
        at: "2027-10-01T00:00:00.000Z",
        names: { domain: "b.co.uk" },
      })
    )[0]
  ).toBe("b|done|Live. Renews 1 October 2027|-")
})

it("sends the owner to the approval before the first publish, and waits on go-live otherwise", () => {
  const site = { live: null, url: null, host: null }
  const waiting = checklistFor(
    workspace([], site, [seg("golive", "waiting")]),
    ZONE,
    NOW
  )
  expect(summary(waiting)[0]).toBe(
    "published|waiting|Waiting for your approval to publish|Review it"
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
