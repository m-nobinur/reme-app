import type { AssignmentState, BuildSummary } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { deriveReminders, type ReminderInput } from "../src/workspace.ts"

/**
 * Each rule at its boundary, against an injected clock. The live wiring,
 * and each reminder clearing when its row resolves, is in
 * `workspace.test.ts`.
 */

const NOW = new Date("2026-09-28T12:00:00.000Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
const ORG = crypto.randomUUID()
const STAFF = crypto.randomUUID()

const approval = (expiresIn: number, assignmentId = crypto.randomUUID()) => ({
  kind: "approval" as const,
  request: {
    approval_id: crypto.randomUUID(),
    org_id: ORG,
    assignment_id: assignmentId,
    requested_by_staff_id: STAFF,
    approver_staff_id: STAFF,
    action_kind: "site.publish",
    target: { kind: "revision" as const, revision_id: crypto.randomUUID() },
    rationale: "The preview passed every gate.",
    requested_at: at(expiresIn - 72 * HOUR),
    expires_at: at(expiresIn),
  },
  version: 2,
})

const question = (openFor: number) => ({
  kind: "question" as const,
  request: {
    request_id: crypto.randomUUID(),
    org_id: ORG,
    assignment_id: crypto.randomUUID(),
    requested_by_staff_id: STAFF,
    field: "business.phone",
    why: "The contact section shows it.",
    answer_schema: { type: "object" },
    options: null,
    blocking: true,
    requested_at: at(-openFor),
    expires_at: null,
  },
})

const build = (
  state: AssignmentState,
  version: number | null = 3,
  assignmentId = crypto.randomUUID(),
  idleFor = 13 * HOUR
): BuildSummary => ({
  assignment_id: assignmentId,
  kind: "site.build",
  state,
  goal: "Build the site from the canonical facts.",
  revision:
    version === null
      ? null
      : { revision_id: crypto.randomUUID(), version: version },
  created_at: at(-idleFor - HOUR),
  updated_at: at(-idleFor),
})

const derive = (input: Partial<ReminderInput>) =>
  deriveReminders(
    { approvals: [], questions: [], builds: [], missing: [], ...input },
    NOW
  )

describe("approval_expiring", () => {
  it("reminds of a review 23h59m from expiry", () => {
    const item = approval(23 * HOUR + 59 * MINUTE)
    expect(derive({ approvals: [item] })).toEqual([
      {
        rule: "approval_expiring",
        approval_id: item.request.approval_id,
        version: 2,
        expires_at: item.request.expires_at,
      },
    ])
  })

  it("does not remind of one exactly 24h from expiry", () => {
    expect(derive({ approvals: [approval(24 * HOUR)] })).toEqual([])
  })

  it("does not remind of one already past, as the sweep parks it", () => {
    expect(derive({ approvals: [approval(0), approval(-MINUTE)] })).toEqual([])
  })
})

describe("question_waiting", () => {
  it("reminds of a question open 12h01m", () => {
    const item = question(12 * HOUR + MINUTE)
    expect(derive({ questions: [item] })).toEqual([
      { rule: "question_waiting", request_id: item.request.request_id },
    ])
  })

  it("does not remind of one open exactly 12h", () => {
    expect(derive({ questions: [question(12 * HOUR)] })).toEqual([])
  })
})

describe("preview_unpublished", () => {
  it("reminds of a preview no review was opened on", () => {
    const item = build("preview_ready", 3)
    expect(derive({ builds: [item] })).toEqual([
      {
        rule: "preview_unpublished",
        assignment_id: item.assignment_id,
        version: 3,
      },
    ])
  })

  it("does not remind of a preview that reached preview_ready exactly 12h ago", () => {
    expect(
      derive({ builds: [build("preview_ready", 3, undefined, 12 * HOUR)] })
    ).toEqual([])
  })

  it("does not remind of an owner build passing through on its way to review", () => {
    expect(
      derive({ builds: [build("preview_ready", 3, undefined, MINUTE)] })
    ).toEqual([])
  })

  // `readApprovals` lists approvals only on builds under review, so this is
  // a review opened between the builds and approvals reads.
  it("leaves a build whose approval is listed to that approval", () => {
    const id = crypto.randomUUID()
    expect(
      derive({
        approvals: [approval(48 * HOUR, id)],
        builds: [build("preview_ready", 3, id)],
      })
    ).toEqual([])
  })

  it("clears once the build leaves preview_ready: reviewed, publishing, published, cancelled, or still building", () => {
    const states: AssignmentState[] = [
      "awaiting_review",
      "blocked_on_approval",
      "release_candidate",
      "published",
      "cancelled",
      "validating",
    ]
    expect(derive({ builds: states.map((s) => build(s)) })).toEqual([])
  })

  it("names no preview for a build with no revision", () => {
    expect(derive({ builds: [build("preview_ready", null)] })).toEqual([])
  })
})

describe("facts_missing", () => {
  it("carries every missing key in one reminder", () => {
    expect(derive({ missing: ["business.phone", "hours.weekday"] })).toEqual([
      { rule: "facts_missing", keys: ["business.phone", "hours.weekday"] },
    ])
  })

  it("clears once nothing is missing", () => {
    expect(derive({ missing: [] })).toEqual([])
  })
})

describe("the order the owner reads them in", () => {
  // Approvals arrive soonest expiry first and questions oldest first, as
  // `readApprovals` and `readQuestions` order them.
  it("puts expiring approvals first, then questions, previews and facts", () => {
    const sooner = approval(2 * HOUR)
    const later = approval(20 * HOUR)
    const rules = derive({
      approvals: [sooner, later],
      questions: [question(13 * HOUR)],
      builds: [build("preview_ready", 1)],
      missing: ["business.name"],
    }).map((r) => (r.rule === "approval_expiring" ? r.approval_id : r.rule))
    expect(rules).toEqual([
      sooner.request.approval_id,
      later.request.approval_id,
      "question_waiting",
      "preview_unpublished",
      "facts_missing",
    ])
  })
})
