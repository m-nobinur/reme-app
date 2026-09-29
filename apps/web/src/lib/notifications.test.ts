import { expect, it } from "vitest"
import type { AttentionItem } from "./api/types"
import { waitingOnOwner } from "./attention"
import { notificationsOf, seenAtOf, unreadCount } from "./notifications"

const item = (kind: AttentionItem["kind"], id: string, raisedAt: string) =>
  ({ kind, id, raisedAt }) as unknown as AttentionItem

const SEEN = "2026-10-01T09:00:00.000Z"

it("counts an item raised at the seen time as read", () => {
  expect(unreadCount([item("question", "q", SEEN)], SEEN)).toBe(0)
})

it("counts an item raised after the seen time as unread", () => {
  expect(
    unreadCount([item("alert", "a", "2026-10-01T09:00:00.001Z")], SEEN)
  ).toBe(1)
})

it("counts every item as unread when there is no cookie", () => {
  const items = [
    item("report", "r", "2026-09-01T09:00:00.000Z"),
    item("approval", "p", "2026-09-02T09:00:00.000Z"),
  ]
  expect(unreadCount(items, seenAtOf(undefined))).toBe(2)
  // A cookie that is not a time is the same as none.
  expect(unreadCount(items, seenAtOf("yesterday"))).toBe(2)
})

it("takes questions and approvals from /workspace and reports and alerts from /activity", () => {
  // /workspace carries the last day's reports and alerts too, and /activity
  // the same report again: each kind is read from one source only.
  const attention = [
    item("question", "q", "2026-10-01T08:00:00.000Z"),
    item("approval", "p", "2026-10-01T07:00:00.000Z"),
    item("report", "r", "2026-10-01T06:00:00.000Z"),
    item("alert", "a", "2026-10-01T05:00:00.000Z"),
  ]
  const activity = [
    item("report", "r", "2026-10-01T06:00:00.000Z"),
    item("alert", "a", "2026-10-01T05:00:00.000Z"),
    item("question", "stray", "2026-10-01T04:00:00.000Z"),
  ]
  expect(
    notificationsOf(waitingOnOwner(attention), activity).map((each) => each.id)
  ).toEqual(["q", "p", "r", "a"])
})

it("lists the newest first", () => {
  const listed = notificationsOf(
    [
      item("question", "old", "2026-09-20T09:00:00.000Z"),
      item("approval", "new", "2026-10-02T09:00:00.000Z"),
    ],
    [item("report", "middle", "2026-09-28T09:00:00.000Z")]
  )
  expect(listed.map((each) => each.id)).toEqual(["new", "middle", "old"])
})
