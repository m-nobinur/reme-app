import { expect, it } from "vitest"
import type { AttentionItem } from "./api/types"
import { waitingOnOwner } from "./attention"

const item = (kind: AttentionItem["kind"]) =>
  ({ kind, id: kind }) as unknown as AttentionItem

it("counts only what waits on an answer: approvals and questions", () => {
  expect(
    waitingOnOwner([
      item("approval"),
      item("question"),
      item("report"),
      item("alert"),
      item("question"),
    ])
  ).toBe(3)
})

it("counts nothing when there are only reports and alerts", () => {
  expect(waitingOnOwner([item("report"), item("alert")])).toBe(0)
})
