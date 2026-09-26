import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { apiSource, treeOf } from "./client"
import type { StaffMember } from "./types"

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: () => "sealed",
}))

const SRC = fileURLToPath(new URL("../..", import.meta.url))

/**
 * The seam is one module or it is not a seam.
 *
 * A loader that reached past `source.ts` for one screen would still be reading
 * the previous implementation after the next swap, and nothing else in the repo
 * would notice.
 */
it("names an implementation in exactly one module", () => {
  const offenders = readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
    .filter((file) => {
      const source = readFileSync(join(SRC, file), "utf8")
      return /from\s+"[^"]*\/client"|from\s+"\.\/client"/.test(source)
    })

  expect(offenders).toEqual(["lib/api/source.ts"])
})

/**
 * The `manager_staff_id` closure (§5.2).
 *
 * The rows arrive as a flat list ordered by staff code, so this is the only
 * thing standing between the API's answer and the reporting lines a page draws,
 * and no other suite can see it: a real session's directory is empty until
 * someone is hired.
 */
const member = (id: string, managerId: string | null): StaffMember => ({
  id,
  staffCode: id,
  displayName: id,
  kind: "agent",
  positionTitle: null,
  roleTitle: null,
  departmentName: null,
  managerId,
  status: "active",
})

it("hangs each row off its manager", () => {
  const shape = (nodes: ReturnType<typeof treeOf>): Record<string, unknown> =>
    Object.fromEntries(
      nodes.map((node) => [node.staff.id, shape(node.reports)])
    )

  expect(
    shape(
      treeOf([
        member("a", null),
        member("b", "a"),
        member("c", "b"),
        member("d", "a"),
      ])
    )
  ).toEqual({ a: { b: { c: {} }, d: {} } })
})

it("draws a row whose manager it cannot see rather than dropping it", () => {
  // A manager outside this org's rows is not a reason to hide someone from
  // their own directory: a tree with a branch missing is a misleading tree.
  const tree = treeOf([member("a", null), member("orphan", "not-in-this-org")])
  expect(tree.map((node) => node.staff.id)).toEqual(["a", "orphan"])
})

it("has no tree to draw when nobody has been hired", () => {
  expect(treeOf([])).toEqual([])
})

/**
 * The reads and the one write, against a stubbed `apps/api`. Every body below
 * is a contract sample, so a mapping that drifts from the contract fails here
 * rather than on an owner's screen.
 */
const ORG = "00000000-0000-4000-8000-000000000001"
const DEV = "00000000-0000-4000-8000-000000000002"
const ASSIGNMENT = "00000000-0000-4000-8000-000000000003"
const APPROVAL = "00000000-0000-4000-8000-000000000004"
const REVISION = "00000000-0000-4000-8000-000000000005"
const REQUEST = "00000000-0000-4000-8000-000000000006"
const FACT = "00000000-0000-4000-8000-000000000007"
const AT = "2026-09-26T10:00:00.000Z"
const EXPIRES = "2026-09-29T10:00:00.000Z"

const approval = {
  kind: "approval",
  request: {
    approval_id: APPROVAL,
    org_id: ORG,
    assignment_id: ASSIGNMENT,
    requested_by_staff_id: DEV,
    approver_staff_id: DEV,
    action_kind: "site.publish",
    target: { kind: "revision", revision_id: REVISION },
    rationale: "The new hero is ready.",
    requested_at: AT,
    expires_at: EXPIRES,
  },
  version: 4,
}
const question = {
  kind: "question",
  request: {
    request_id: REQUEST,
    org_id: ORG,
    assignment_id: ASSIGNMENT,
    requested_by_staff_id: DEV,
    field: "hours.weekday",
    why: "The contact section shows opening hours.",
    answer_schema: {},
    options: null,
    blocking: true,
    requested_at: AT,
    expires_at: null,
  },
}
const report = {
  kind: "report",
  event_id: "01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  assignment_id: ASSIGNMENT,
  at: AT,
  what: "published",
  revision: { revision_id: REVISION, version: 3 },
}
const alert = {
  kind: "alert",
  event_id: "01J8Z3K4M5N6P7Q8R9S0T1V2W4",
  assignment_id: ASSIGNMENT,
  at: AT,
  reason: "build_failed",
}
const workspace = {
  site: { host: null, live: null },
  builds: [],
  attention: [approval, question, alert, report],
  missing_facts: [],
}
const staff = {
  staff: [
    {
      staff_id: DEV,
      org_id: ORG,
      staff_code: "DEV-001",
      kind: "agent",
      display_name: "Alex",
      position_title: null,
      role_id: null,
      department_id: null,
      manager_staff_id: null,
      status: "active",
      created_at: AT,
      updated_at: AT,
    },
  ],
}
const fact = {
  fact_id: FACT,
  org_id: ORG,
  key: "hours.weekday",
  fact_type: "hours",
  value: { open: "08:00", close: "17:00" },
  version: 1,
  provenance: {
    source: "owner_stated",
    confidence: 1,
    verified_by_staff_id: null,
    verified_at: null,
  },
  valid_from: AT,
  valid_to: null,
  superseded_by_fact_id: null,
}
const decision = {
  approval_id: APPROVAL,
  org_id: ORG,
  decision: "approved",
  target: { kind: "revision", revision_id: REVISION },
  decided_by: { kind: "owner_session", user_id: "user_1", session_id: "s_1" },
  decided_at: AT,
}

type Call = { path: string; init: RequestInit | undefined }
let calls: Call[] = []
let answers: Record<string, unknown> = {}

beforeEach(() => {
  process.env.REME_API_URL = "https://api.test"
  calls = []
  answers = {
    "GET /workspace": workspace,
    "GET /staff": staff,
    "GET /activity": { items: [alert, report] },
    "GET /facts": { facts: [fact] },
    "GET /org": {
      org_id: ORG,
      slug: "fictional-co",
      name: "Fictional Co",
      created_at: AT,
    },
    [`POST /approvals/${APPROVAL}/decision`]: decision,
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      calls.push({ path: url.pathname, init })
      const body = answers[`${init?.method ?? "GET"} ${url.pathname}`]
      if (body instanceof Response) return body
      return body === undefined
        ? new Response(null, { status: 404 })
        : Response.json(body)
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The directory the dashboard has already read, handed to `attention`. */
const alex: StaffMember = { ...member(DEV, null), displayName: "Alex" }

const refusal = (status: number, code: string) =>
  Response.json(
    { class: "validation", code, message: code, occurred_at: AT, detail: {} },
    { status }
  )

const domainApproval = {
  ...approval,
  request: {
    ...approval.request,
    approval_id: "00000000-0000-4000-8000-000000000008",
    target: { kind: "domain", hostname: "fictional.invalid" },
  },
}

it("reads attention from the workspace, in its order and the owner's words", async () => {
  const { attention: items } = await apiSource.workspace(
    ORG,
    Promise.resolve([alex])
  )
  // Names come from the directory the caller already has, not a second read.
  expect(calls.map((call) => call.path)).toEqual(["/workspace"])
  expect(
    items.map(({ kind, id, title, raisedBy, expiresAt }) => ({
      kind,
      id,
      title,
      raisedBy,
      expiresAt,
    }))
  ).toEqual([
    {
      kind: "approval",
      id: APPROVAL,
      title: "Version 4 is ready to publish",
      raisedBy: "Alex",
      expiresAt: EXPIRES,
    },
    {
      kind: "question",
      id: REQUEST,
      title: "Weekday hours",
      raisedBy: "Alex",
      expiresAt: null,
    },
    {
      kind: "alert",
      id: alert.event_id,
      title: "A build failed",
      raisedBy: "Reme",
      expiresAt: null,
    },
    {
      kind: "report",
      id: report.event_id,
      title: "Published v3",
      raisedBy: "Reme",
      expiresAt: null,
    },
  ])
  // The approval carries its contract whole, so the target drawn is the one
  // the decision binds to.
  expect(items[0]).toMatchObject({ request: approval.request, version: 4 })
})

const build = (state: string) => ({
  assignment_id: ASSIGNMENT,
  kind: "site.revise",
  state,
  goal: "Change the hero line",
  revision: null,
  created_at: AT,
  updated_at: AT,
})

it("reads the live version, and a build only while it is working", async () => {
  answers["GET /workspace"] = {
    ...workspace,
    site: {
      host: "fictional.invalid",
      live: { revision_id: REVISION, version: 3 },
    },
    builds: [build("awaiting_review")],
  }
  expect(await apiSource.workspace(ORG, Promise.resolve([]))).toMatchObject({
    live: 3,
    building: false,
  })

  answers["GET /workspace"] = {
    ...workspace,
    builds: [build("paused"), build("implementing")],
  }
  expect(await apiSource.workspace(ORG, Promise.resolve([]))).toMatchObject({
    live: null,
    building: true,
  })
})

it("lists only the workspace's approvals, each with its version", async () => {
  const items = await apiSource.approvals(ORG)
  expect(items).toEqual([
    {
      request: approval.request,
      version: 4,
      revisionId: REVISION,
      title: "Version 4 is ready to publish",
      requestedBy: "Alex",
      onExpiry: expect.any(String),
    },
  ])
})

it("reads the directory for approvals only when there is one to name", async () => {
  answers["GET /workspace"] = { ...workspace, attention: [alert, report] }
  expect(await apiSource.approvals(ORG)).toEqual([])
  expect(calls.map((call) => call.path)).toEqual(["/workspace"])
})

it("leaves out an approval with no version to decide on", async () => {
  // A decision names a revision, so a domain or spend approval could only
  // offer buttons that do nothing. `/workspace` lists none today.
  answers["GET /workspace"] = {
    ...workspace,
    attention: [domainApproval, approval],
  }
  const listed = await apiSource.approvals(ORG)
  expect(listed.map((item) => item.request.approval_id)).toEqual([APPROVAL])
  const { attention } = await apiSource.workspace(ORG, Promise.resolve([alex]))
  expect(
    attention.filter((item) => item.kind === "approval").map((item) => item.id)
  ).toEqual([APPROVAL])
})

it("reads activity from /activity", async () => {
  expect(await apiSource.activity(ORG)).toEqual([
    { id: alert.event_id, summary: "A build failed", occurredAt: AT },
    { id: report.event_id, summary: "Published v3", occurredAt: AT },
  ])
})

it("reads the profile's facts from /facts", async () => {
  expect(await apiSource.profile(ORG)).toEqual({
    org: { id: ORG, slug: "fictional-co", name: "Fictional Co" },
    facts: [fact],
  })
})

it("answers empty for a session with no organisation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 403 }))
  )
  expect(await apiSource.workspace(ORG, Promise.resolve([]))).toEqual({
    attention: [],
    live: null,
    building: false,
  })
  expect(await apiSource.approvals(ORG)).toEqual([])
  expect(await apiSource.activity(ORG)).toEqual([])
  expect(await apiSource.profile(ORG)).toBeNull()
})

it("refuses a workspace off contract rather than rendering it", async () => {
  answers["GET /workspace"] = { ...workspace, attention: [{ kind: "memo" }] }
  await expect(apiSource.workspace(ORG, Promise.resolve([]))).rejects.toThrow()
})

it("posts a decision bound to the revision, with an idempotency key", async () => {
  expect(
    await apiSource.decideApproval(ORG, APPROVAL, REVISION, "rejected")
  ).toEqual({ recorded: true })
  const [call] = calls
  expect(call?.path).toBe(`/approvals/${APPROVAL}/decision`)
  expect(call?.init?.method).toBe("POST")
  expect(JSON.parse(String(call?.init?.body))).toEqual({
    decision: "rejected",
    revision_id: REVISION,
  })
  const headers = new Headers(call?.init?.headers)
  expect(headers.get("content-type")).toBe("application/json")
  expect(headers.get("cookie")).toBe("wos-session=sealed")
  // The same decision on the same revision is the same key, so a retry
  // replays rather than decides again.
  const key = headers.get("idempotency-key")
  expect(key).toBeTruthy()
  await apiSource.decideApproval(ORG, APPROVAL, REVISION, "rejected")
  expect(new Headers(calls[1]?.init?.headers).get("idempotency-key")).toBe(key)
})

for (const [status, code, reason] of [
  [409, "approval.expired", "expired"],
  [409, "approval.target_mismatch", "replaced"],
  [409, "approval.not_requested", "gone"],
  [404, "approval.not_found", "gone"],
  [404, "assignment.not_found", "gone"],
] as const) {
  it(`says why a decision was refused: ${code}`, async () => {
    answers[`POST /approvals/${APPROVAL}/decision`] = refusal(status, code)
    expect(
      await apiSource.decideApproval(ORG, APPROVAL, REVISION, "approved")
    ).toEqual({ recorded: false, reason })
  })
}

it("throws on any other refusal, so nothing looks recorded", async () => {
  answers[`POST /approvals/${APPROVAL}/decision`] = refusal(
    403,
    "approval.impersonated"
  )
  await expect(
    apiSource.decideApproval(ORG, APPROVAL, REVISION, "approved")
  ).rejects.toThrow()
})

it("names an item raised by someone outside the directory as Reme", async () => {
  // The requester is not in the directory this session can read, so the card
  // says who it can vouch for rather than a staff id.
  const stranger = "00000000-0000-4000-8000-000000000009"
  const unknown = {
    ...approval,
    request: { ...approval.request, requested_by_staff_id: stranger },
  }
  answers["GET /workspace"] = { ...workspace, attention: [unknown] }
  const [listed] = await apiSource.approvals(ORG)
  expect(listed?.requestedBy).toBe("Reme")
  const {
    attention: [card],
  } = await apiSource.workspace(ORG, Promise.resolve([alex]))
  expect(card?.raisedBy).toBe("Reme")
})
