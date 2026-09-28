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
  site: { host: null, live: null },
  builds: [],
  attention: [approval, question, alert, report],
  missing_facts: [],
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
      live: { revision_id: REVISION, version: 3, assignment_id: ASSIGNMENT },
    },
    builds: [build("awaiting_review")],
  }
  expect(await apiSource.workspace(ORG, Promise.resolve([]))).toMatchObject({
    live: 3,
    liveRevision: { revisionId: REVISION, assignmentId: ASSIGNMENT },
    building: false,
    open: true,
  })

  answers["GET /workspace"] = {
    ...workspace,
    builds: [build("paused"), build("implementing")],
  }
  expect(await apiSource.workspace(ORG, Promise.resolve([]))).toMatchObject({
    live: null,
    liveRevision: null,
    building: true,
    open: true,
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

it("reads activity from /activity as reports and alerts", async () => {
  expect(
    (await apiSource.activity(ORG)).map(({ kind, id, title, raisedAt }) => ({
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
  expect(await apiSource.workspace(ORG, Promise.resolve([]))).toEqual(
    EMPTY_WORKSPACE
  )
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
      site: { host: "fictional.example.invalid", live: null },
      builds: [building],
      attention: [],
      missing_facts: ["business.phone"],
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
    host: "fictional.example.invalid",
    missingFacts: ["business.phone"],
    derivedReminders: [{ rule: "facts_missing", keys: ["business.phone"] }],
  })
  // Nothing to name, so the directory is not read.
  expect(calls.map((call) => call.path)).toEqual(["/workspace"])
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
  await expect(apiSource.answer(ORG, "..", REQUEST, "x", "k")).rejects.toThrow()
  await expect(apiSource.cancelBuild(ORG, "../changes")).rejects.toThrow()
  await expect(apiSource.preview(ORG, ".")).rejects.toThrow()
  await expect(apiSource.conversation(ORG, "..")).rejects.toThrow()
  await expect(
    apiSource.decideApproval(ORG, "..", REVISION, "approved")
  ).rejects.toThrow()
  await expect(
    apiSource.updateConversation(ORG, "..", { archived: true }, "k")
  ).rejects.toThrow()
  await expect(apiSource.conversationMessages(ORG, "..")).rejects.toThrow()
  expect(calls).toEqual([])
})

it("reads no history for a conversation that is not the owner's", async () => {
  expect(await apiSource.conversationMessages(ORG, CONVERSATION)).toEqual([])
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
  expect(
    await apiSource.answer(ORG, ASSIGNMENT, REQUEST, value, "k-1")
  ).toEqual({ done: true })
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    request_id: REQUEST,
    value,
  })
  expect(headerOf(calls[0], "idempotency-key")).toBe("k-1")
})

it("says why an answer was refused, including one already answered differently", async () => {
  answers[`POST /builds/${ASSIGNMENT}/answer`] = refusal(400, "answer.invalid")
  expect(await apiSource.answer(ORG, ASSIGNMENT, REQUEST, "x", "k")).toEqual({
    done: false,
    reason: expect.stringContaining("does not fit the question"),
  })
  answers[`POST /builds/${ASSIGNMENT}/answer`] = refusal(
    409,
    "answer.already_given"
  )
  // A different answer is on record: this one was not, and the question is
  // gone from the build.
  expect(await apiSource.answer(ORG, ASSIGNMENT, REQUEST, "x", "k")).toEqual({
    done: false,
    gone: true,
    reason: expect.stringContaining("already answered"),
  })
  answers[`POST /builds/${ASSIGNMENT}/answer`] = new Response(null, {
    status: 502,
  })
  await expect(
    apiSource.answer(ORG, ASSIGNMENT, REQUEST, "x", "k")
  ).rejects.toThrow()
})

it("stops a build once, however often Stop is pressed", async () => {
  answers[`POST /builds/${ASSIGNMENT}/cancel`] = {
    assignment_id: ASSIGNMENT,
    state: "cancelled",
  }
  expect(await apiSource.cancelBuild(ORG, ASSIGNMENT)).toEqual({ done: true })
  expect(calls[0]?.init?.body).toBeUndefined()
  expect(headerOf(calls[0], "idempotency-key")).toBe(`cancel:${ASSIGNMENT}`)
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
  expect(await apiSource.preview(ORG, ASSIGNMENT)).toEqual({
    revisionId: REVISION,
    url: link.url,
    screenshots: link.screenshots,
    expiresAt: EXPIRES,
  })
})

it("sends a change in the owner's words, and says why one is refused", async () => {
  answers["POST /changes"] = refusal(409, "change.question_open")
  expect(await apiSource.requestChange(ORG, "Bigger logo", "k-2")).toEqual({
    done: false,
    reason: expect.stringContaining("Answer the question"),
  })
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    text: "Bigger logo",
  })
})

it("says a cancelled change was cancelled, not that the page is stale", async () => {
  answers["POST /changes"] = refusal(409, "change.cancelled")
  expect(await apiSource.requestChange(ORG, "Bigger logo", "k-3")).toEqual({
    done: false,
    reason: "That change was cancelled. Ask for it again.",
  })
})

it("lists, fetches and creates conversations over the contract", async () => {
  answers["GET /conversations"] = { conversations: [conversation] }
  answers[`GET /conversations/${CONVERSATION}`] = conversation
  answers["POST /conversations"] = conversation
  expect(await apiSource.conversations(ORG)).toEqual([conversation])
  expect(await apiSource.conversation(ORG, CONVERSATION)).toEqual(conversation)
  expect(await apiSource.createConversation(ORG, "__LOCALID_abc")).toEqual(
    conversation
  )
  const create = calls.at(-1)
  // An empty body, keyed on the thread's local id.
  expect(create?.init?.body).toBeUndefined()
  expect(headerOf(create, "idempotency-key")).toBe("__LOCALID_abc")
})

it("answers null for a conversation that is not the owner's", async () => {
  expect(await apiSource.conversation(ORG, CONVERSATION)).toBeNull()
})

it("renames and archives with a PATCH of one field", async () => {
  answers[`PATCH /conversations/${CONVERSATION}`] = conversation
  await apiSource.updateConversation(ORG, CONVERSATION, { archived: true }, "k")
  expect(calls[0]?.init?.method).toBe("PATCH")
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ archived: true })
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
  }
  answers[`GET /conversations/${CONVERSATION}/messages`] = {
    messages: [message],
  }
  expect(await apiSource.conversationMessages(ORG, CONVERSATION)).toEqual([
    message,
  ])
})
