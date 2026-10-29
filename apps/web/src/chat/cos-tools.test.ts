import type { ActivitySegment } from "@workspace/contracts"
import { expect, it } from "vitest"
import type { AttentionItem, Workspace } from "@/lib/api/types"
import { cosTools, liveKey, liveState, questionTitles } from "./cos-tools"

const item = (kind: string, id: string, title: string) =>
  ({ kind, id, title }) as AttentionItem

it("keeps one key while a poll changes nothing the cards show", () => {
  const first = questionTitles([
    item("question", "q1", "Your phone number"),
    item("alert", "a1", "Build stopped"),
  ])
  const later = questionTitles([
    item("report", "r1", "Draft ready"),
    item("question", "q1", "Your phone number"),
  ])
  expect(later).toBe(first)
  expect(questionTitles([item("question", "q1", "Your email")])).not.toBe(first)
})

it("names an open question, and none that is not open", () => {
  const { question } = cosTools(
    questionTitles([item("question", "q1", "Your phone number")])
  )
  expect(question("q1")).toBe("Your phone number")
  expect(question("q2")).toBeNull()
  expect(cosTools(questionTitles()).question("q1")).toBeNull()
})

const seg = (s: Partial<ActivitySegment>) =>
  ({
    id: "x",
    state: "done",
    steps: [],
    at: "2026-10-29T09:00:00Z",
    ...s,
  }) as ActivitySegment
const workspace = (standing: ActivitySegment[] | undefined, w = {}) =>
  ({
    host: "spark.co.uk",
    reminderNotes: [{ id: "r1" }],
    activity: { standing },
    ...w,
  }) as unknown as Workspace

it("reads Google as connected only once its sign-in is done, and unknown without standing", () => {
  const google = (state: "done" | "waiting") =>
    seg({ kind: "google", steps: [{ id: "sign_in", state }] })
  expect(
    liveState(liveKey(workspace([google("done")]))).cards.googleConnected
  ).toBe(true)
  expect(
    liveState(liveKey(workspace([google("waiting")]))).cards.googleConnected
  ).toBe(false)
  expect(liveState(liveKey(workspace([]))).cards.googleConnected).toBe(false)
  expect(
    liveState(liveKey(workspace(undefined))).cards.googleConnected
  ).toBeNull()
})

it("names the domains the website is live on", () => {
  const { domainLive } = liveState(
    liveKey(
      workspace([
        seg({
          kind: "address",
          state: "now",
          names: { domain: "spark.co.uk" },
        }),
        seg({ kind: "address", state: "done", names: { domain: "spark.com" } }),
        seg({ kind: "address", state: "now", names: { domain: "spark.uk" } }),
      ])
    )
  ).cards
  expect(["spark.co.uk", "spark.com", "spark.uk"].map(domainLive)).toEqual([
    true,
    true,
    false,
  ])
})

it("offers an undo only for an open reminder, and every one before the workspace is read", () => {
  const { reminderOpen } = liveState(liveKey(workspace([])))
  expect(reminderOpen?.("r1")).toBe(true)
  expect(reminderOpen?.("r2")).toBe(false)
  expect(liveState(liveKey(null)).reminderOpen).toBeUndefined()
})

it("keeps one key while a poll changes nothing the live cards show", () => {
  const before = workspace([seg({ kind: "golive" })])
  const after = workspace([seg({ kind: "golive", at: "2026-10-29T10:00:00Z" })])
  expect(liveKey(after)).toBe(liveKey(before))
})
