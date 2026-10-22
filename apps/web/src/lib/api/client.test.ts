import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { EMPTY_WORKSPACE } from "../attention"
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
  site: { host: null, url: null, live: null },
  builds: [],
  attention: [approval, question, alert, report],
  missing_facts: [],
  assistant_name: null,
  reminders: { notes: [], derived: [] },
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
      title: "Your new version is ready to publish",
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
      url: "https://fictional.invalid",
      live: { revision_id: REVISION, version: 3, assignment_id: ASSIGNMENT },
    },
    builds: [build("awaiting_review")],
  }
  expect(await apiSource.workspace(Promise.resolve([]))).toMatchObject({
    live: 3,
    liveRevision: { revisionId: REVISION, assignmentId: ASSIGNMENT },
    building: false,
    open: true,
  })

  answers["GET /workspace"] = {
    ...workspace,
    builds: [build("paused"), build("implementing")],
  }
  expect(await apiSource.workspace(Promise.resolve([]))).toMatchObject({
    live: null,
    liveRevision: null,
    building: true,
    open: true,
  })
})

it("leaves out an approval with no version to decide on", async () => {
  // A decision names a revision, so a domain or spend approval could only
  // offer buttons that do nothing. `/workspace` lists none today.
  answers["GET /workspace"] = {
    ...workspace,
    attention: [domainApproval, approval],
  }
  const { attention } = await apiSource.workspace(Promise.resolve([alex]))
  expect(
    attention.filter((item) => item.kind === "approval").map((item) => item.id)
  ).toEqual([APPROVAL])
})

it("reads activity from /activity as reports and alerts", async () => {
  expect(
    (await apiSource.activity()).map(({ kind, id, title, raisedAt }) => ({
      kind,
      id,
      title,
      raisedAt,
    }))
  ).toEqual([
    {
      kind: "alert",
      id: alert.event_id,
      title: "A build failed",
      raisedAt: AT,
    },
    {
      kind: "report",
      id: report.event_id,
      title: "Published v3",
      raisedAt: AT,
    },
  ])
})

it("reads the profile's facts from /facts", async () => {
  expect(await apiSource.profile()).toEqual({
    org: { id: ORG, slug: "fictional-co", name: "Fictional Co" },
    facts: [fact],
  })
})

it("reads the directory once for both the list and the tree", async () => {
  const { staff: members, tree } = await apiSource.directory()
  expect(members.map((each) => each.id)).toEqual([DEV])
  expect(tree.map((node) => node.staff.id)).toEqual([DEV])
  expect(calls.map((call) => call.path)).toEqual(["/staff"])
})

it("reads the profile's organisation once", async () => {
  await apiSource.profile()
  expect(calls.filter((call) => call.path === "/org")).toHaveLength(1)
})

it("makes no request for a pipeline it cannot read yet", async () => {
  expect(await apiSource.pipeline()).toEqual([])
  expect(calls).toEqual([])
})

it("reads a due reminder as an item raised when it fell due, and a paused job as an alert", async () => {
  const reminder = {
    kind: "reminder",
    reminder_id: "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
    title: "Ring the boiler engineer",
    due_at: AT,
  }
  const paused = { ...alert, reason: "job_paused", assignment_id: null }
  answers["GET /workspace"] = { ...workspace, attention: [reminder] }
  answers["GET /activity"] = { items: [paused] }
  const { attention } = await apiSource.workspace(Promise.resolve([]))
  expect(attention).toEqual([
    {
      kind: "reminder",
      id: reminder.reminder_id,
      title: "Ring the boiler engineer",
      detail: "You asked to be reminded. Mark it done on the Reminders page.",
      raisedBy: "Reme",
      raisedById: null,
      raisedAt: AT,
      expiresAt: null,
      onExpiry: "It stays here until you mark it done.",
    },
  ])
  expect(await apiSource.activity()).toMatchObject([
    {
      kind: "alert",
      id: paused.event_id,
      title: "A scheduled task was paused",
    },
  ])
})

it("answers empty for a session with no organisation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 403 }))
  )
  expect(await apiSource.workspace(Promise.resolve([]))).toEqual(
    EMPTY_WORKSPACE
  )
  expect(await apiSource.activity()).toEqual([])
  expect(await apiSource.profile()).toBeNull()
})

it("stores no conversation, and records no write, for a session with no organisation", async () => {
  answers["POST /conversations"] = refusal(403, "org.unresolved")
  expect(await apiSource.createConversation("__LOCALID_abc")).toBeNull()
  // Nothing to act on is a defect to surface, not a stale screen to retry.
  answers["POST /changes"] = refusal(403, "org.unresolved")
  await expect(apiSource.requestChange("Bigger logo", "k")).rejects.toThrow()
})

it("refuses a workspace off contract rather than rendering it", async () => {
  answers["GET /workspace"] = { ...workspace, attention: [{ kind: "memo" }] }
  await expect(apiSource.workspace(Promise.resolve([]))).rejects.toThrow()
})

it("posts a decision bound to the revision, with an idempotency key", async () => {
  expect(
    await apiSource.decideApproval(APPROVAL, REVISION, "rejected")
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
  await apiSource.decideApproval(APPROVAL, REVISION, "rejected")
  expect(new Headers(calls[1]?.init?.headers).get("idempotency-key")).toBe(key)
})

for (const [status, code, reason] of [
  [409, "approval.expired", "expired"],
  [409, "approval.target_mismatch", "replaced"],
  [409, "approval.not_requested", "gone"],
  [404, "approval.not_found", "gone"],
  [404, "assignment.not_found", "gone"],
  [409, "revision.a11y_unchecked", "checking"],
] as const) {
  it(`says why a decision was refused: ${code}`, async () => {
    answers[`POST /approvals/${APPROVAL}/decision`] = refusal(status, code)
    expect(
      await apiSource.decideApproval(APPROVAL, REVISION, "approved")
    ).toEqual({ recorded: false, reason })
  })
}

it("throws on any other refusal, so nothing looks recorded", async () => {
  answers[`POST /approvals/${APPROVAL}/decision`] = refusal(
    403,
    "approval.impersonated"
  )
  await expect(
    apiSource.decideApproval(APPROVAL, REVISION, "approved")
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
  const {
    attention: [card],
  } = await apiSource.workspace(Promise.resolve([alex]))
  expect(card?.raisedBy).toBe("Reme")
})

const CONVERSATION = "00000000-0000-4000-8000-00000000000a"
const conversation = {
  id: CONVERSATION,
  kind: "assistant",
  title: null,
  archived_at: null,
  created_at: AT,
  updated_at: AT,
}
const building = {
  assignment_id: ASSIGNMENT,
  kind: "site.build",
  state: "implementing",
  goal: "Build my website",
  revision: null,
  created_at: AT,
  updated_at: AT,
}
const headerOf = (call: Call | undefined, name: string) =>
  new Headers(call?.init?.headers).get(name)

it("polls with the last tag and keeps what it has on a 304", async () => {
  answers["GET /workspace"] = new Response(null, { status: 304 })
  expect(await apiSource.pollWorkspace('"a1"')).toBe("unchanged")
  expect(calls.map((call) => call.path)).toEqual(["/workspace"])
  expect(headerOf(calls[0], "if-none-match")).toBe('"a1"')
})

it("reads a changed workspace with its tag, builds, facts and reminders", async () => {
  answers["GET /workspace"] = Response.json(
    {
      site: {
        host: "fictional.reme.localhost",
        url: "http://fictional.reme.localhost:3004",
        live: null,
      },
      builds: [building],
      expected_seconds: {
        full: { p50: 180, p95: 330 },
        quick: { p50: 15, p95: 45 },
      },
      attention: [],
      missing_facts: ["business.phone"],
      assistant_name: "Ava",
      reminders: {
        notes: [],
        derived: [{ rule: "facts_missing", keys: ["business.phone"] }],
      },
    },
    { headers: { etag: '"b2"' } }
  )
  const read = await apiSource.pollWorkspace('"a1"')
  expect(read).toMatchObject({
    etag: '"b2"',
    building: true,
    builds: [building],
    expectedSeconds: { quick: { p50: 15, p95: 45 } },
    host: "fictional.reme.localhost",
    url: "http://fictional.reme.localhost:3004",
    missingFacts: ["business.phone"],
    assistantName: "Ava",
    derivedReminders: [{ rule: "facts_missing", keys: ["business.phone"] }],
  })
  // Nothing to name, so the directory is not read.
  expect(calls.map((call) => call.path)).toEqual(["/workspace"])
})

it("shows a review's generated photo from its thumbnail, and one without as before", async () => {
  const id = "0b9c4a1e-2f3d-4c5b-8a6e-7d8f9a0b1c2d"
  answers["GET /workspace"] = {
    ...workspace,
    attention: [
      {
        ...approval,
        photos: [
          {
            slot_id: "hero",
            section: "hero",
            alt: "A van",
            thumbnail: `/api/photos/${id}`,
          },
          { slot_id: "team", section: "about", alt: "The team" },
        ],
      },
    ],
  }
  const read = await apiSource.pollWorkspace(null)
  expect(read !== "unchanged" && read.attention[0]).toMatchObject({
    photos: [
      { slot_id: "hero", alt: "A van", src: `/api/photos/${id}` },
      { slot_id: "team", alt: "The team" },
    ],
  })
  const [, team] =
    (read !== "unchanged" &&
      read.attention[0]?.kind === "approval" &&
      read.attention[0].photos) ||
    []
  expect(team).not.toHaveProperty("src")
})

it("polls in one request, naming the asker by id for the frame to resolve", async () => {
  answers["GET /workspace"] = { ...workspace, attention: [question] }
  const read = await apiSource.pollWorkspace(null)
  // No /org and no /staff: the api reads the org from the session, and the
  // frame already holds the names.
  expect(calls.map((call) => call.path)).toEqual(["/workspace"])
  expect(headerOf(calls[0], "if-none-match")).toBeNull()
  expect(read !== "unchanged" && read.attention[0]).toMatchObject({
    kind: "question",
    raisedById: DEV,
    assignmentId: ASSIGNMENT,
    answer: { kind: "fact", key: "hours.weekday" },
  })
})

it("counts a queued build as open but not working", async () => {
  answers["GET /workspace"] = {
    ...workspace,
    attention: [],
    builds: [{ ...building, state: "queued" }],
  }
  expect(await apiSource.pollWorkspace(null)).toMatchObject({
    building: false,
    open: true,
  })
})

it("refuses an id that is not a uuid before any request is made", async () => {
  // `new URL` collapses dot segments, so ".." would reach another route.
  await expect(apiSource.answer("..", REQUEST, "x", "k")).rejects.toThrow()
  await expect(apiSource.cancelBuild("../changes")).rejects.toThrow()
  await expect(apiSource.preview(".")).rejects.toThrow()
  await expect(apiSource.conversation("..")).rejects.toThrow()
  await expect(
    apiSource.decideApproval("..", REVISION, "approved")
  ).rejects.toThrow()
  await expect(
    apiSource.updateConversation("..", { archived: true }, "k")
  ).rejects.toThrow()
  await expect(apiSource.conversationMessages("..")).rejects.toThrow()
  expect(calls).toEqual([])
})

it("reads no history for a conversation that is not the owner's", async () => {
  expect(await apiSource.conversationMessages(CONVERSATION)).toEqual([])
})

it("shows the question /workspace says the build waits on, and no other", async () => {
  // Item 82: the api picks the question; the panel shows exactly that one.
  const second = {
    ...question,
    request: {
      ...question.request,
      request_id: "00000000-0000-4000-8000-00000000000b",
      field: "business.phone",
    },
  }
  answers["GET /workspace"] = { ...workspace, attention: [second] }
  const read = await apiSource.pollWorkspace(null)
  expect(read !== "unchanged" && read.attention.map((item) => item.id)).toEqual(
    [second.request.request_id]
  )
})

it("sends an answer to the build it blocks, with the caller's key", async () => {
  answers[`POST /builds/${ASSIGNMENT}/answer`] = Response.json(
    {},
    { status: 202 }
  )
  const value = { open: "08:00", close: "17:00" }
  expect(await apiSource.answer(ASSIGNMENT, REQUEST, value, "k-1")).toEqual({
    done: true,
  })
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    request_id: REQUEST,
    value,
  })
  expect(headerOf(calls[0], "idempotency-key")).toBe("k-1")
})

it("says why an answer was refused, including one already answered differently", async () => {
  answers[`POST /builds/${ASSIGNMENT}/answer`] = refusal(400, "answer.invalid")
  expect(await apiSource.answer(ASSIGNMENT, REQUEST, "x", "k")).toEqual({
    done: false,
    reason: expect.stringContaining("does not fit the question"),
  })
  answers[`POST /builds/${ASSIGNMENT}/answer`] = refusal(
    409,
    "answer.already_given"
  )
  // A different answer is on record: this one was not, and the question is
  // gone from the build.
  expect(await apiSource.answer(ASSIGNMENT, REQUEST, "x", "k")).toEqual({
    done: false,
    gone: true,
    reason: expect.stringContaining("already answered"),
  })
  answers[`POST /builds/${ASSIGNMENT}/answer`] = new Response(null, {
    status: 502,
  })
  await expect(
    apiSource.answer(ASSIGNMENT, REQUEST, "x", "k")
  ).rejects.toThrow()
})

it("stops a build once, however often Stop is pressed", async () => {
  answers[`POST /builds/${ASSIGNMENT}/cancel`] = {
    assignment_id: ASSIGNMENT,
    state: "cancelled",
  }
  expect(await apiSource.cancelBuild(ASSIGNMENT)).toEqual({ done: true })
  expect(calls[0]?.init?.body).toBeUndefined()
  expect(headerOf(calls[0], "idempotency-key")).toBe(`cancel:${ASSIGNMENT}`)
})

it("deletes the account with DELETE and one key, and words the refusals", async () => {
  answers["DELETE /account"] = new Response(null, { status: 204 })
  expect(await apiSource.deleteAccount()).toEqual({ done: true })
  expect(calls[0]?.init?.method).toBe("DELETE")
  expect(calls[0]?.init?.body).toBeUndefined()
  expect(headerOf(calls[0], "idempotency-key")).toBe("account:delete")

  answers["DELETE /account"] = refusal(409, "account.other_members")
  expect(await apiSource.deleteAccount()).toEqual({
    done: false,
    reason: expect.stringContaining("Remove them first"),
  })
  answers["DELETE /account"] = new Response(null, { status: 503 })
  await expect(apiSource.deleteAccount()).rejects.toThrow()
})

it("reads a build's preview and its three screenshots", async () => {
  const link = {
    revision_id: REVISION,
    url: "https://preview.example.invalid/?t=a",
    screenshots: [1, 2, 3].map(
      (n) => `https://preview.example.invalid/screenshots/${n}.png?t=b`
    ),
    expires_at: EXPIRES,
  }
  answers[`GET /builds/${ASSIGNMENT}/preview`] = link
  expect(await apiSource.preview(ASSIGNMENT)).toEqual({
    revisionId: REVISION,
    url: link.url,
    screenshots: link.screenshots,
    expiresAt: EXPIRES,
  })
})

it("sends a change in the owner's words, and says why one is refused", async () => {
  answers["POST /changes"] = refusal(409, "change.question_open")
  expect(await apiSource.requestChange("Bigger logo", "k-2")).toEqual({
    done: false,
    reason: expect.stringContaining("Answer it first"),
  })
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    text: "Bigger logo",
  })
})

it("sends the change kind a photo action names", async () => {
  answers["POST /changes"] = refusal(409, "change.question_open")
  await apiSource.requestChange("Try another photo", "k-4", "photo")
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    text: "Try another photo",
    change_kind: "photo",
  })
})

it("asks the api to post a panel note in the chat, in the conversation named", async () => {
  answers["POST /changes"] = refusal(409, "change.question_open")
  await apiSource.requestChange("Bigger logo", "k-5", undefined, {
    conversation_id: REQUEST,
  })
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    text: "Bigger logo",
    chat: { conversation_id: REQUEST },
  })
})

it("says a cancelled change was stopped, not that the page is stale", async () => {
  answers["POST /changes"] = refusal(409, "change.cancelled")
  expect(await apiSource.requestChange("Bigger logo", "k-3")).toEqual({
    done: false,
    reason: "That change was stopped. Ask again to start it.",
  })
})

it("lists, fetches and creates conversations over the contract", async () => {
  answers["GET /conversations"] = { conversations: [conversation] }
  answers[`GET /conversations/${CONVERSATION}`] = conversation
  answers["POST /conversations"] = conversation
  expect(await apiSource.conversations()).toEqual([conversation])
  expect(await apiSource.conversation(CONVERSATION)).toEqual(conversation)
  expect(await apiSource.createConversation("__LOCALID_abc")).toEqual(
    conversation
  )
  const create = calls.at(-1)
  // An empty body, keyed on the thread's local id.
  expect(create?.init?.body).toBeUndefined()
  expect(headerOf(create, "idempotency-key")).toBe("__LOCALID_abc")
})

it("answers null for a conversation that is not the owner's", async () => {
  expect(await apiSource.conversation(CONVERSATION)).toBeNull()
})

it("renames and archives with a PATCH of one field", async () => {
  answers[`PATCH /conversations/${CONVERSATION}`] = conversation
  await apiSource.updateConversation(CONVERSATION, { archived: true }, "k")
  expect(calls[0]?.init?.method).toBe("PATCH")
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ archived: true })
})

it("rates a reply with a POST keyed by the press", async () => {
  answers[`POST /conversations/${CONVERSATION}/feedback`] = new Response(null, {
    status: 204,
  })
  await apiSource.rateMessage(
    CONVERSATION,
    { message_id: "msg_2", rating: "down" },
    "press-1"
  )
  expect(calls[0]?.init?.method).toBe("POST")
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    message_id: "msg_2",
    rating: "down",
  })
  expect(headerOf(calls[0], "idempotency-key")).toBe("press-1")
})

it("reads a conversation's messages, oldest first, as stored", async () => {
  const message = {
    id: "msg_1",
    parent_id: null,
    format: "ai-sdk/v6",
    content: {
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
      metadata: { custom: { createdAt: AT } },
    },
    feedback: null,
  }
  answers[`GET /conversations/${CONVERSATION}/messages`] = {
    messages: [message],
  }
  expect(await apiSource.conversationMessages(CONVERSATION)).toEqual([message])
})

const NOTE = "00000000-0000-4000-8000-00000000000b"

it("says why a reminder's time was refused, in the owner's words", async () => {
  const add = () =>
    apiSource.createReminder({ title: "Order more cloths", due_at: AT }, "k-4")
  answers["POST /reminders"] = refusal(400, "reminder.due_past")
  expect(await add()).toEqual({
    done: false,
    reason: "A reminder cannot be due in the past.",
  })
  answers["POST /reminders"] = refusal(400, "reminder.due_far")
  expect(await add()).toEqual({
    done: false,
    reason: "A reminder can be due at most a year ahead.",
  })
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    title: "Order more cloths",
    due_at: AT,
  })
  expect(headerOf(calls[0], "idempotency-key")).toBe("k-4")
})

it("marks a reminder done once, however often Done is pressed", async () => {
  answers[`PATCH /reminders/${NOTE}`] = {}
  expect(await apiSource.completeReminder(NOTE)).toEqual({ done: true })
  expect(calls[0]?.init?.method).toBe("PATCH")
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ done: true })
  expect(headerOf(calls[0], "idempotency-key")).toBe(`done:${NOTE}`)

  // Gone from this business: the panel reads again rather than retrying.
  answers[`PATCH /reminders/${NOTE}`] = refusal(404, "reminder.not_found")
  expect(await apiSource.completeReminder(NOTE)).toMatchObject({
    done: false,
    gone: true,
  })
})

it("reads the push key, and treats a refused subscription as not saved", async () => {
  answers["GET /push/config"] = { public_key: "BKey" }
  expect(await apiSource.pushKey()).toBe("BKey")
  answers["GET /push/config"] = { public_key: null }
  expect(await apiSource.pushKey()).toBeNull()

  const input = {
    endpoint: "https://fcm.googleapis.com/fcm/send/a1",
    keys: { p256dh: "p", auth: "a" },
  }
  answers["POST /push/subscriptions"] = { id: NOTE }
  expect(await apiSource.subscribePush(input, "k-5")).toBe(NOTE)
  expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual(input)
  expect(headerOf(calls.at(-1), "idempotency-key")).toBe("k-5")
  answers["POST /push/subscriptions"] = refusal(403, "push.not_owner")
  expect(await apiSource.subscribePush(input, "k-6")).toBeNull()
})

it("takes a push subscription off by its id", async () => {
  answers[`DELETE /push/subscriptions/${NOTE}`] = {}
  expect(await apiSource.unsubscribePush(NOTE)).toEqual({ done: true })
  expect(calls.at(-1)?.init?.method).toBe("DELETE")
  answers[`DELETE /push/subscriptions/${NOTE}`] = refusal(404, "push.not_found")
  expect(await apiSource.unsubscribePush(NOTE)).toMatchObject({ done: false })
})

const DETAILS = {
  registrant: {
    name: "Jane Smith",
    business_name: "Sparkle Clean",
    email: "jane@sparkle.example",
    phone: "+447700900123",
    address: {
      street: "12 Mill Lane",
      city: "Bristol",
      postal_code: "BS1 4AB",
      country_code: "GB",
    },
  },
  registrant_type: "STRA",
} as const

it("opens a domain's Checkout with the details shown, and hands back a refusal's code", async () => {
  const checkout = {
    name: "sparkleclean.co.uk",
    price_gbp: 8,
    client_secret: "cs_x",
    expires_at: AT,
  }
  answers["POST /domains/sparkleclean.co.uk/checkout"] = checkout
  expect(
    await apiSource.domainCheckout("sparkleclean.co.uk", DETAILS, "k-9")
  ).toEqual(checkout)
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(DETAILS)
  expect(headerOf(calls[0], "idempotency-key")).toBe("k-9")

  answers["POST /domains/sparkleclean.co.uk/checkout"] = refusal(
    409,
    "domain.unavailable"
  )
  expect(
    await apiSource.domainCheckout("sparkleclean.co.uk", DETAILS, "k-10")
  ).toEqual({ refused: "domain.unavailable" })

  // A name that is not a hostname never becomes a path.
  await expect(
    apiSource.domainCheckout("../account", DETAILS, "k-11")
  ).rejects.toThrow()
  expect(calls).toHaveLength(2)
})

it("reads a domain purchase's status, and none when the api has no such purchase", async () => {
  const status = {
    name: "sparkleclean.co.uk",
    state: "verifying",
    test: true,
    outcome: "test_registered",
  }
  answers["GET /domains/sparkleclean.co.uk"] = status
  expect(await apiSource.domainStatus("sparkleclean.co.uk")).toEqual(status)
  expect(await apiSource.domainStatus("other.co.uk")).toBeNull()
})

it("reads the open reminders in the order /workspace lists them", async () => {
  const written = (id: string, due_at: string | null) => ({
    id,
    title: "Order more cloths",
    due_at,
    done_at: null,
    source: "owner",
    conversation_id: null,
    created_at: AT,
    updated_at: AT,
  })
  const notes = [written(NOTE, EXPIRES), written(FACT, null)]
  answers["GET /workspace"] = {
    ...workspace,
    reminders: { notes, derived: [] },
  }
  const read = await apiSource.pollWorkspace(null)
  expect(read !== "unchanged" && read.reminderNotes).toEqual(notes)
})
