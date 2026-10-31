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
  // Approved here: a publishing line, whether or not the poll has caught up.
  const here = { review: v2, at: "2026-10-28T22:01:42Z" }
  const publishing = {
    kind: "approved",
    version: 2,
    published: false,
  }
  expect(readyCard(v2, here, 1)).toEqual(publishing)
  expect(readyCard(null, here, 1)).toEqual(publishing)
  expect(readyCard(v3, here, 1)).toEqual({ kind: "review", review: v3 })
})

it("holds the publishing line until the assistant says it is live, then lets it go", () => {
  const v1 = {
    approvalId: "a",
    revisionId: "rev-a",
    version: 1,
    assignmentId: null,
    at: "",
  }
  const here = { review: v1, at: "2026-10-28T22:01:42Z" }
  expect(readyCard(null, here, null, null)).toEqual({
    kind: "approved",
    version: 1,
    published: false,
  })
  // Off the chat, it goes once the version is live.
  expect(readyCard(null, here, 1)).toBeNull()
  // Live in under ten seconds, the live message 70 s later: no gap between.
  expect(readyCard(null, here, 1, "2026-10-28T22:00:00Z")).toEqual({
    kind: "approved",
    version: 1,
    published: true,
  })
  // Said live: the live message says it, so the line goes.
  expect(readyCard(null, here, 1, "2026-10-28T22:02:52Z")).toBeNull()
})

describe("awaitsReadyLine", () => {
  const at = "2026-10-25T10:26:49Z"
  const t = (iso: string) => Date.parse(iso)
  const seen = t(at) + 20_000
  it.each([
    ["no review", null, null, seen, seen, false],
    [
      "a new review the poll just brought, nothing said since",
      at,
      null,
      seen,
      seen + 5_000,
      true,
    ],
    [
      "the ready line landed",
      at,
      "2026-10-25T10:27:00Z",
      seen,
      seen + 1_000,
      false,
    ],
    [
      "only a reply from before the review",
      at,
      "2026-10-25T10:26:27Z",
      seen,
      seen + 5_000,
      true,
    ],
    [
      "past the wait since this tab saw it",
      at,
      null,
      seen,
      seen + 20_000,
      false,
    ],
    [
      "an old review on a reload",
      at,
      null,
      t(at) + 600_000,
      t(at) + 600_000,
      false,
    ],
  ])("%s", (_case, reviewAt, saidAt, seenAt, now, waits) => {
    expect(awaitsReadyLine(reviewAt, saidAt, seenAt, now)).toBe(waits)
  })
})
