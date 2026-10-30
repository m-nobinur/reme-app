import type { ActivitySegment } from "@workspace/contracts"
import { expect, it } from "vitest"
import type { Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { groupsOf } from "./tasks"

const segment = (
  kind: ActivitySegment["kind"],
  state: ActivitySegment["state"],
  steps: ActivitySegment["steps"] = []
): ActivitySegment => ({
  id: kind,
  kind,
  state,
  steps,
  at: "2026-10-29T09:00:00.000Z",
})

const ONBOARDED = segment("onboarding", "done")

/** The Build and publish row for a workspace with this journey. */
const websiteSetup = (
  journey: ActivitySegment[],
  over: Partial<Workspace> = {}
) =>
  groupsOf(
    {
      ...EMPTY_WORKSPACE,
      ...over,
      activity: { journey, now: [], waiting: [], upcoming: [], done: [] },
    },
    "Wren"
  )
    .find((group) => group.id === "website")
    ?.tasks.find((task) => task.title === "Build and publish")

it("says Waiting on you, and what for, while going live waits on the owner", () => {
  const task = websiteSetup([
    ONBOARDED,
    segment("website", "done"),
    segment("golive", "waiting", [{ id: "publish", state: "waiting" }]),
  ])
  expect(task).toMatchObject({
    status: "yours",
    detail: "Publish your website",
  })
})

it("says In progress while the build is at work and nothing waits on the owner", () => {
  const task = websiteSetup([
    ONBOARDED,
    segment("website", "now", [{ id: "pages", state: "now" }]),
  ])
  expect(task).toMatchObject({
    status: "active",
    detail: "Wren builds your first version and you publish it.",
  })
})

it("names the first stage that waits, when more than one does", () => {
  const task = websiteSetup([
    ONBOARDED,
    segment("website", "waiting", [{ id: "choose", state: "waiting" }]),
    segment("golive", "waiting", [{ id: "publish", state: "waiting" }]),
  ])
  expect(task).toMatchObject({
    status: "yours",
    detail: "Choose a name for your website",
  })
})

it("is done once the site is live, whatever a later change waits on", () => {
  const task = websiteSetup(
    [
      ONBOARDED,
      segment("change", "waiting", [{ id: "publish", state: "waiting" }]),
    ],
    { live: 2 }
  )
  expect(task).toMatchObject({
    status: "done",
    detail: "Wren builds your first version and you publish it.",
  })
})

it("is up next after onboarding, and says so, before any stage has begun", () => {
  const task = websiteSetup([
    segment("onboarding", "now"),
    segment("website", "upcoming"),
  ])
  expect(task).toMatchObject({
    status: "waiting",
    after: "Set up your business",
  })
})

it("says Waiting on you, and what for, on every stage that waits on the owner", () => {
  // A task waiting on the owner is in the waiting group and in standing.
  const owed = [
    {
      ...segment("address", "waiting", [{ id: "records", state: "waiting" }]),
      names: { domain: "spark.co.uk" },
    },
    segment("google", "waiting", [{ id: "sign_in", state: "waiting" }]),
  ]
  const groups = groupsOf(
    {
      ...EMPTY_WORKSPACE,
      live: 1,
      activity: {
        journey: [
          segment("onboarding", "waiting", [
            { id: "services", state: "waiting" },
          ]),
        ],
        now: [],
        waiting: owed,
        upcoming: [],
        done: [],
        standing: owed,
      },
    },
    "Wren"
  )
  const row = (title: string) =>
    groups.flatMap((group) => group.tasks).find((task) => task.title === title)
  expect(row("Set up your business")).toMatchObject({
    status: "yours",
    detail: "Answer the setup question",
  })
  expect(row("Your own address")).toMatchObject({
    status: "yours",
    detail: "Make the DNS change for spark.co.uk",
  })
  expect(row("Show up on Google")).toMatchObject({
    status: "yours",
    detail: "Sign in to Google",
  })
})
