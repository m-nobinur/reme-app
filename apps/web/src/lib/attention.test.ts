import { expect, it } from "vitest"
import type { AttentionItem } from "./api/types"
import { EMPTY_WORKSPACE, readWorkspace, waitingOnOwner } from "./attention"

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

it("reads what waits on the owner through the filter", async () => {
  const workspace = await readWorkspace(async () => ({
    ...EMPTY_WORKSPACE,
    attention: [item("approval"), item("report")],
    live: 3,
  }))
  expect(workspace?.attention).toHaveLength(1)
  expect(workspace?.live).toBe(3)
})

it("answers null rather than throwing when the read fails", async () => {
  expect(
    await readWorkspace(async () => {
      throw new Error("the api answered 503")
    })
  ).toBeNull()
})
