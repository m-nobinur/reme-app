import { describe, expect, it } from "vitest"
import type { AttentionItem, Workspace } from "./api/types"
import { awaitsReadyLine, readyCard, readyForReview } from "./site-ready"

const approval = (
  id: string,
  version: number,
  at: string,
  target: object = { kind: "revision", revision_id: `rev-${id}` }
) =>
  ({
    kind: "approval",
    id,
    title: `Version ${version}`,
    detail: "",
    raisedBy: "Developer",
    raisedById: null,
    raisedAt: at,
    expiresAt: null,
    onExpiry: "",
    version,
    request: { approval_id: id, target },
  }) as unknown as AttentionItem

const workspace = (attention: AttentionItem[]) =>
  ({ attention }) as unknown as Workspace

it("picks the newest review of a built version, and nothing else", () => {
  expect(readyForReview(null)).toBeNull()
  expect(
    readyForReview(
      workspace([
        approval("a", 1, "2026-10-01T09:00:00Z"),
        approval("b", 2, "2026-10-01T10:00:00Z"),
        approval("c", 3, "2026-10-01T11:00:00Z", {
          kind: "domain",
          hostname: "brightclean.example",
        }),
      ])
    )
  ).toEqual({
    approvalId: "b",
    revisionId: "rev-b",
    version: 2,
    assignmentId: undefined,
    at: "2026-10-01T10:00:00Z",
  })
})

it("asks, then says approved, then asks again for a newer version", () => {
  const v2 = {
    approvalId: "b",
    revisionId: "rev-b",
    version: 2,
    assignmentId: null,
    at: "",
  }
  const v3 = {
    approvalId: "c",
    revisionId: "rev-c",
    version: 3,
    assignmentId: null,
    at: "",
  }
  expect(readyCard(null, null, null)).toBeNull()
  expect(readyCard(v2, null, 1)).toEqual({ kind: "review", review: v2 })
  // Approved here: quiet, whether or not the poll has caught up.
  expect(readyCard(v2, v2, 1)).toEqual({ kind: "approved", version: 2 })
  expect(readyCard(null, v2, 1)).toEqual({ kind: "approved", version: 2 })
  expect(readyCard(v3, v2, 1)).toEqual({ kind: "review", review: v3 })
})

it("drops the approved line once that version is live", () => {
  const v1 = {
    approvalId: "a",
    revisionId: "rev-a",
    version: 1,
    assignmentId: null,
    at: "",
  }
  expect(readyCard(null, v1, null)).toEqual({ kind: "approved", version: 1 })
  expect(readyCard(null, v1, 1)).toBeNull()
})

describe("awaitsReadyLine", () => {
  const at = "2026-10-25T10:26:49Z"
  const t = (iso: string) => Date.parse(iso)
  it.each([
    ["no review", null, null, t(at), false],
    ["a new review with nothing said since", at, null, t(at) + 5_000, true],
    [
      "the ready line landed",
      at,
      "2026-10-25T10:27:00Z",
      t(at) + 11_000,
      false,
    ],
    [
      "only a reply from before the review",
      at,
      "2026-10-25T10:26:27Z",
      t(at) + 5_000,
      true,
    ],
    ["past the wait, with no line", at, null, t(at) + 20_000, false],
  ])("%s", (_case, reviewAt, saidAt, now, waits) => {
    expect(awaitsReadyLine(reviewAt, saidAt, now)).toBe(waits)
  })
})
