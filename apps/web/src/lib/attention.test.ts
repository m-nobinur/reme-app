import { expect, it } from "vitest"
import type { AttentionItem } from "./api/types"
import { waitingOnOwner } from "./attention"

const item = (kind: AttentionItem["kind"]) =>
  ({ kind, id: kind }) as unknown as AttentionItem

it("lists only what waits on an answer: approvals and questions", () => {
  expect(
    waitingOnOwner([
      item("approval"),
      item("question"),
      item("report"),
      item("alert"),
      item("question"),
    ])
  ).toHaveLength(3)
})

it("lists nothing when there are only reports and alerts", () => {
  expect(waitingOnOwner([item("report"), item("alert")])).toEqual([])
})
