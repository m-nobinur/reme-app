import { getCookie } from "@tanstack/react-start/server"
import { sessionEncryption } from "@workos/authkit-session"
import { getAuthKitContextOrNull } from "@workos/authkit-tanstack-react-start"
import {
  ActivityFeed,
  ApprovalDecision,
  type AttentionItem as Attention,
  Conversation,
  ConversationHistory,
  ConversationList,
  type CreateReminderRequest,
  ErrorEnvelope,
  FactList,
  type MessageFeedback,
  Org,
  PreviewLink,
  StaffDirectory,
  Uuid,
  WorkspaceStatus,
} from "@workspace/contracts"
import { answerSpecOf } from "@workspace/ui/lib/answer"
import { factLabel } from "@workspace/ui/lib/facts"
import { WORKING } from "../build-state"
import type {
  ApprovalItem,
  AttentionItem,
  DecisionOutcome,
  OrgNode,
  OrgSummary,
  OwnerDataSource,
  PreviewLinks,
  StaffMember,
  TransportedFact,
  TransportedMessage,
  Workspace,
  WorkspacePoll,
  WriteOutcome,
} from "./types"

/**
 * The owner screens, read from `apps/api` over the contracts.
 *
 * Every value on every screen comes from a row a tenant owns, resolved from their own session: no request
 * from here names an organisation, in any spelling, because `apps/api` produces
 * the org id from the sealed session and would not read one if we sent it.
 * `orgId` is still a parameter of `OwnerDataSource` and is deliberately unused
 * below.
 *
 * The pipeline has no endpoint yet. It answers empty rather than inventing
 * rows, which is what an owner on their first day genuinely has. Nothing here
 * falls back to a fixture: an empty inbox is true, and a fixture business on a
 * tenant's screen is not (exit gate 9, R8).
 */

/** The cookie AuthKit writes and `apps/api` reads (ADR-024, ADR-026). */
const COOKIE = "wos-session"

/**
 * Where `apps/api` answers. A `vars` entry rather than a secret, because it is
 * a public URL. Three lines rather than an import from `lib/auth/org.ts`, which
 * would drag `@workos-inc/node` into the graph of every product loader for the
 * sake of a `process.env` read.
 */
function apiUrl(): string {
  const value = process.env.REME_API_URL
  if (!value) {
    throw new Error(
      "REME_API_URL is not set on this Worker. Local values go in apps/web/.dev.vars; the deployed value is a vars entry in wrangler.jsonc."
    )
  }
  return value
}

/**
 * One read, with the session forwarded.
 *
 * Only the session cookie is forwarded, rebuilt by name rather than by passing
 * the browser's `Cookie` header through: the organisation the owner picked and
 * anything else a page has set are ours and are not `apps/api`'s business.
 *
 * 401 and 403 answer null rather than throwing. Both mean "this session has no
 * organisation to read", which every screen renders as its empty state: 403
 * `org.unresolved` is the state a signup lands in for a moment (open item 32),
 * and the layout guard has already refused a request with no session at all, so
 * a 401 here is a session that expired between the guard and this call. Any
 * other status is a defect and is thrown, so it reaches an error boundary
 * rather than a screen of zeros.
 */
async function get(path: string): Promise<unknown | null> {
  const response = await call(path)
  if (!response || response.status === 401 || response.status === 403) {
    return null
  }
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for ${path}`)
  }
  return await response.json()
}

const sessionCookie = (session: string) =>
  `${COOKIE}=${encodeURIComponent(session)}`

/**
 * The session to forward: the one AuthKit resolved for this request, sealed
 * again, and not the cookie the request arrived with. When the access token
 * has expired (after about five idle minutes), the middleware refreshes it
 * and sets the new cookie on the response, but the request still carries the
 * old one, which `apps/api` refuses with 401 `session.absent`. Sealed once per
 * request. With no AuthKit context (a unit test), the cookie as it came.
 */
const sealed = new WeakMap<Request, Promise<string>>()

async function forwardedSession(): Promise<string | undefined> {
  const context = getAuthKitContextOrNull()
  if (!context) return getCookie(COOKIE)
  const auth = context.auth()
  if (!auth.user) return undefined
  let seal = sealed.get(context.request)
  if (!seal) {
    const password = process.env.WORKOS_COOKIE_PASSWORD
    if (!password) {
      throw new Error("WORKOS_COOKIE_PASSWORD is not set on this Worker.")
    }
    // The fields `AuthKitCore.encryptSession` seals, from the same session.
    seal = sessionEncryption.sealData(
      {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        user: auth.user,
        impersonator: auth.impersonator,
      },
      { password, ttl: 0 }
    )
    sealed.set(context.request, seal)
  }
  return await seal
}

/**
 * One request with the session forwarded, or null when there is no session.
 * A body goes as JSON; an empty one sends no body at all.
 */
async function call(
  path: string,
  init: {
    method?: string
    body?: unknown
    key?: string
    etag?: string | null
    /** A body already serialised, sent as it is. */
    raw?: string
  } = {}
): Promise<Response | null> {
  const session = await forwardedSession()
  if (!session) {
    return null
  }
  const headers: Record<string, string> = { cookie: sessionCookie(session) }
  if (init.body !== undefined || init.raw !== undefined) {
    headers["content-type"] = "application/json"
  }
  if (init.key) headers["idempotency-key"] = init.key
  if (init.etag) headers["if-none-match"] = init.etag
  return await fetch(new URL(path, apiUrl()), {
    method: init.method ?? "GET",
    headers,
    body:
      init.raw ??
      (init.body === undefined ? undefined : JSON.stringify(init.body)),
  })
}

/** One write. The caller reads the answer, since some refusals are the owner's to act on. */
async function post(
  path: string,
  body: unknown,
  idempotencyKey: string,
  method = "POST"
): Promise<Response> {
  const response = await call(path, { method, body, key: idempotencyKey })
  if (!response) {
    throw new Error(`no session to send ${path} with`)
  }
  return response
}

/**
 * The reporting lines the directory draws, built from `manager_staff_id` in one
 * pass. Roots are the rows whose manager is not in this org's own list, so a row
 * pointing at a manager the reader cannot see is still drawn rather than
 * silently dropped.
 */
export function treeOf(members: StaffMember[]): OrgNode[] {
  const nodes = new Map<string, OrgNode>(
    members.map((staff) => [staff.id, { staff, reports: [] }])
  )
  const roots: OrgNode[] = []
  for (const node of nodes.values()) {
    const parent = node.staff.managerId
      ? nodes.get(node.staff.managerId)
      : undefined
    if (parent) {
      parent.reports.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

async function currentOrg(): Promise<OrgSummary | null> {
  const body = await get("/org")
  if (body === null) {
    return null
  }
  // Parsed rather than read loosely, so a drift between the contract and what
  // the API answers fails here instead of two screens later.
  const org = Org.parse(body)
  return { id: org.org_id, slug: org.slug, name: org.name }
}

/**
 * `role_id` and `department_id` are ids, and there is no read that turns either
 * into a title yet, so both render as "—" rather than as a guess. The column
 * the directory shows in the meantime is `position_title`, which is on the row.
 */
async function staffOf(): Promise<StaffMember[]> {
  const body = await get("/staff")
  if (body === null) {
    return []
  }
  return StaffDirectory.parse(body).staff.map((member) => ({
    id: member.staff_id,
    staffCode: member.staff_code,
    displayName: member.display_name,
    kind: member.kind,
    positionTitle: member.position_title,
    roleTitle: null,
    departmentName: null,
    managerId: member.manager_staff_id,
    status: member.status,
  }))
}

/** Reports and alerts come from the event log, not a staff member. */
const SYSTEM = "Reme"

type Logged = Extract<Attention, { kind: "report" | "alert" }>

/** The headline and the line under it for a report or an alert. */
function logged(item: Logged): { title: string; detail: string } {
  if (item.kind === "report") {
    return {
      title: `Published v${item.revision.version}`,
      detail: `Version ${item.revision.version} is live on your site.`,
    }
  }
  switch (item.reason) {
    case "build_failed":
      return {
        title: "A build failed",
        detail: "It stopped before it had a version to show you.",
      }
    case "budget_parked":
      return {
        title: "A build paused at its spending limit",
        detail: "It spends nothing more until it is picked up again.",
      }
    case "publish_rolled_back":
      return {
        title: "A publish was rolled back",
        detail:
          "The new version failed its checks once live, so your site went back to the one before.",
      }
  }
}

const APPROVAL_EXPIRY =
  "Nothing is published without you. If it expires, the build waits until you decide."

const approvalTitle = (version: number) =>
  `Version ${version} is ready to publish`

/**
 * `/workspace`, with the attention list trimmed. An approval whose target is
 * not a revision is left out: a decision names a revision, so it could only
 * offer buttons that do nothing, and `/workspace` lists none today. A session
 * with no organisation reads as a workspace with nothing in it.
 */
async function workspaceStatus(
  etag: string | null = null
): Promise<{ status: WorkspaceStatus; etag: string | null } | "unchanged"> {
  const response = await call("/workspace", { etag })
  // 304 keeps what the caller has: nothing about the workspace changed.
  if (response?.status === 304) {
    return "unchanged"
  }
  if (!response || response.status === 401 || response.status === 403) {
    return {
      status: {
        site: { host: null, live: null },
        builds: [],
        attention: [],
        missing_facts: [],
        reminders: { notes: [], derived: [] },
      },
      etag: null,
    }
  }
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for /workspace`)
  }
  const status = WorkspaceStatus.parse(await response.json())
  return {
    status: {
      ...status,
      attention: status.attention.filter(
        (item) =>
          item.kind !== "approval" || item.request.target.kind === "revision"
      ),
    },
    etag: response.headers.get("etag"),
  }
}

/** `workspaceStatus` for a caller with no tag, which always gets a body. */
async function currentStatus(): Promise<WorkspaceStatus> {
  const read = await workspaceStatus()
  if (read === "unchanged") {
    throw new Error("apps/api answered 304 to a read with no tag")
  }
  return read.status
}

const namesOf = (staff: StaffMember[]) =>
  new Map(staff.map((member) => [member.id, member.displayName]))

function toAttention(
  item: Attention,
  names: Map<string, string>
): AttentionItem {
  switch (item.kind) {
    case "approval":
      return {
        kind: "approval",
        request: item.request,
        version: item.version,
        id: item.request.approval_id,
        title: approvalTitle(item.version),
        detail: item.request.rationale,
        raisedBy: names.get(item.request.requested_by_staff_id) ?? SYSTEM,
        raisedById: item.request.requested_by_staff_id,
        raisedAt: item.request.requested_at,
        expiresAt: item.request.expires_at,
        onExpiry: APPROVAL_EXPIRY,
      }
    case "question":
      return {
        kind: "question",
        assignmentId: item.request.assignment_id,
        answer: answerSpecOf(item.request),
        id: item.request.request_id,
        title: factLabel(item.request.field),
        detail: item.request.why,
        raisedBy: names.get(item.request.requested_by_staff_id) ?? SYSTEM,
        raisedById: item.request.requested_by_staff_id,
        raisedAt: item.request.requested_at,
        expiresAt: item.request.expires_at,
        onExpiry: item.request.blocking
          ? "The build waits on you until you answer."
          : "The build carries on without it.",
      }
    default:
      return {
        kind: item.kind,
        id: item.event_id,
        ...logged(item),
        raisedBy: SYSTEM,
        raisedById: null,
        raisedAt: item.at,
        expiresAt: null,
        onExpiry: "Nothing to decide.",
      }
  }
}

function workspaceOf(
  { status, etag }: { status: WorkspaceStatus; etag: string | null },
  names: Map<string, string>
): Workspace {
  return {
    attention: status.attention.map((item) => toAttention(item, names)),
    live: status.site.live?.version ?? null,
    liveRevision: status.site.live
      ? {
          revisionId: status.site.live.revision_id,
          assignmentId: status.site.live.assignment_id,
        }
      : null,
    building: status.builds.some((build) => WORKING.has(build.state)),
    open: status.builds.length > 0,
    builds: status.builds,
    host: status.site.host,
    missingFacts: status.missing_facts,
    derivedReminders: status.reminders.derived,
    reminderNotes: status.reminders.notes,
    etag,
  }
}

async function workspace(
  _orgId: string,
  staff: Promise<StaffMember[]>
): Promise<Workspace> {
  const [read, members] = await Promise.all([workspaceStatus(), staff])
  if (read === "unchanged") {
    throw new Error("apps/api answered 304 to a read with no tag")
  }
  return workspaceOf(read, namesOf(members))
}

/**
 * The panel's poll: one request, and unchanged is the common answer, with no
 * body. It names no one; the frame already read the directory.
 */
async function pollWorkspace(etag: string | null): Promise<WorkspacePoll> {
  const read = await workspaceStatus(etag)
  return read === "unchanged" ? read : workspaceOf(read, new Map())
}

/**
 * `GET /approvals` was dropped: the workspace's attention list carries them.
 * The directory is read only when there is an approval to name.
 */
async function approvals(): Promise<ApprovalItem[]> {
  const found = (await currentStatus()).attention.filter(
    (item) => item.kind === "approval"
  )
  if (found.length === 0) {
    return []
  }
  const names = namesOf(await staffOf())
  return found.flatMap((item) => {
    const card = toAttention(item, names)
    const { target } = item.request
    return card.kind === "approval" && target.kind === "revision"
      ? [
          {
            request: card.request,
            version: card.version,
            revisionId: target.revision_id,
            title: card.title,
            requestedBy: card.raisedBy,
            onExpiry: card.onExpiry,
          },
        ]
      : []
  })
}

/**
 * The refusals an owner can do something about, by code. Anything else is a
 * defect or a permission problem and throws.
 */
const REFUSED: Record<
  string,
  Exclude<DecisionOutcome, { recorded: true }>["reason"]
> = {
  "approval.expired": "expired",
  "approval.target_mismatch": "replaced",
  "approval.not_requested": "gone",
  "approval.not_found": "gone",
  "assignment.not_found": "gone",
}

/**
 * The refusals an owner can act on from the panel, in their words. Any other
 * 4xx is a stale screen; a 5xx is a defect and throws.
 */
const REFUSALS: Record<string, string> = {
  "answer.invalid":
    "That answer does not fit the question. Check it and send it again.",
  "answer.already_given":
    "That question was already answered, so this answer was not recorded.",
  "change.question_open":
    "Answer the question waiting on you first, then ask again.",
  "change.build_busy":
    "A build is finishing. Ask again once it is ready for you.",
  "change.cancelled": "That change was cancelled. Ask for it again.",
  "reminder.due_past": "That time has already passed.",
  "reminder.due_far": "Pick a time within a year.",
  "reminder.not_found": "That reminder is no longer open.",
  "account.other_members":
    "Other people still belong to this business. Remove them first.",
  "account.not_owner": "Only the owner can delete this account.",
}
const STALE = "That has changed since this page loaded. Look again and retry."

/** Refusals that mean the item no longer waits on the owner. */
const GONE = new Set(["answer.already_given", "reminder.not_found"])

/** A write's answer as an outcome. */
async function outcome(
  response: Response,
  path: string
): Promise<WriteOutcome> {
  if (response.ok) {
    return { done: true }
  }
  const refusal = ErrorEnvelope.safeParse(
    await response.json().catch(() => null)
  )
  const code = refusal.success ? refusal.data.code : ""
  if (response.status >= 400 && response.status < 500 && refusal.success) {
    const reason = REFUSALS[code] ?? STALE
    return GONE.has(code)
      ? { done: false, reason, gone: true }
      : { done: false, reason }
  }
  throw new Error(`apps/api answered ${response.status} for ${path}`)
}

/**
 * An id as a path segment. Only a UUID: `new URL` collapses `.` and `..`,
 * so anything else could reach a different route.
 */
function segment(id: string): string {
  if (!Uuid.safeParse(id).success) {
    throw new Error("Expected a UUID for a path segment.")
  }
  return id
}

async function answer(
  _orgId: string,
  assignmentId: string,
  requestId: string,
  value: unknown,
  key: string
): Promise<WriteOutcome> {
  const path = `/builds/${segment(assignmentId)}/answer`
  const response = await post(path, { request_id: requestId, value }, key)
  // The same answer again is a retry and gets its receipt (202). A 409
  // `answer.already_given` means a different answer is on record, so this
  // one was not recorded.
  return await outcome(response, path)
}

async function cancelBuild(
  _orgId: string,
  assignmentId: string
): Promise<WriteOutcome> {
  const path = `/builds/${segment(assignmentId)}/cancel`
  // One build is stopped once: a second press is the same request.
  return await outcome(
    await post(path, undefined, `cancel:${assignmentId}`),
    path
  )
}

async function deleteAccount(_orgId: string): Promise<WriteOutcome> {
  // An account is deleted once: a second press is the same request.
  return await outcome(
    await post("/account", undefined, "account:delete", "DELETE"),
    "/account"
  )
}

async function preview(
  _orgId: string,
  assignmentId: string
): Promise<PreviewLinks | null> {
  const body = await get(`/builds/${segment(assignmentId)}/preview`)
  if (body === null) {
    return null
  }
  const link = PreviewLink.parse(body)
  return {
    revisionId: link.revision_id,
    url: link.url,
    screenshots: link.screenshots,
    expiresAt: link.expires_at,
  }
}

async function requestChange(
  _orgId: string,
  text: string,
  key: string
): Promise<WriteOutcome> {
  return await outcome(await post("/changes", { text }, key), "/changes")
}

async function createReminder(
  _orgId: string,
  input: CreateReminderRequest,
  key: string
): Promise<WriteOutcome> {
  return await outcome(await post("/reminders", input, key), "/reminders")
}

async function completeReminder(
  _orgId: string,
  id: string
): Promise<WriteOutcome> {
  const path = `/reminders/${segment(id)}`
  // Done is done: a second press is the same request.
  return await outcome(
    await post(path, { done: true }, `done:${id}`, "PATCH"),
    path
  )
}

async function conversations(): Promise<Conversation[]> {
  const body = await get("/conversations")
  return body === null ? [] : ConversationList.parse(body).conversations
}

async function conversation(
  _orgId: string,
  id: string
): Promise<Conversation | null> {
  const response = await call(`/conversations/${segment(id)}`)
  // Another org's id is a 404, the same as one that never existed.
  if (!response || [401, 403, 404].includes(response.status)) {
    return null
  }
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for a conversation`)
  }
  return Conversation.parse(await response.json())
}

async function createConversation(
  _orgId: string,
  key: string
): Promise<Conversation> {
  const response = await post("/conversations", undefined, key)
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for /conversations`)
  }
  return Conversation.parse(await response.json())
}

async function updateConversation(
  _orgId: string,
  id: string,
  patch: { title: string } | { archived: boolean },
  key: string
): Promise<void> {
  const response = await post(
    `/conversations/${segment(id)}`,
    patch,
    key,
    "PATCH"
  )
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for a conversation`)
  }
}

async function rateMessage(
  _orgId: string,
  id: string,
  feedback: MessageFeedback,
  key: string
): Promise<void> {
  const response = await post(
    `/conversations/${segment(id)}/feedback`,
    feedback,
    key
  )
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for a rating`)
  }
}

async function conversationMessages(
  _orgId: string,
  id: string
): Promise<TransportedMessage[]> {
  const response = await call(`/conversations/${segment(id)}/messages`)
  // Another org's id is a 404, the same as one that never existed: no
  // history to show.
  if (!response || [401, 403, 404].includes(response.status)) {
    return []
  }
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for a history`)
  }
  // Parsed first, so every field is the contract's; parts are JSON because
  // they arrived as JSON.
  return ConversationHistory.parse(await response.json())
    .messages as TransportedMessage[]
}

async function activity(): Promise<AttentionItem[]> {
  const body = await get("/activity")
  if (body === null) {
    return []
  }
  // Reports and alerts name no staff member, so no directory is read.
  return ActivityFeed.parse(body).items.map((item) =>
    toAttention(item, new Map())
  )
}

async function factsOf(): Promise<TransportedFact[]> {
  const body = await get("/facts")
  // Parsed first, so every field but `value` is the contract's; `value` is
  // JSON because it arrived as JSON.
  return body === null ? [] : (FactList.parse(body).facts as TransportedFact[])
}

export const apiSource: OwnerDataSource = {
  // The switcher's list. One organisation per session today, because that is
  // what a session's `org_id` claim resolves to and what signup creates.
  orgs: async () => {
    const org = await currentOrg()
    return org ? [org] : []
  },
  staff: staffOf,
  orgTree: async () => treeOf(await staffOf()),
  workspace,
  approvals,
  pipeline: async () => [],
  activity,
  profile: async () => {
    const [org, facts] = await Promise.all([currentOrg(), factsOf()])
    return org ? { org, facts } : null
  },
  pollWorkspace,
  answer,
  cancelBuild,
  deleteAccount,
  preview,
  requestChange,
  createReminder,
  completeReminder,
  conversations,
  conversation,
  createConversation,
  updateConversation,
  rateMessage,
  conversationMessages,
  chat: (raw) => call("/chat", { method: "POST", raw }),
  decideApproval: async (_orgId, approvalId, revisionId, decision) => {
    const path = `/approvals/${segment(approvalId)}/decision`
    const response = await post(
      path,
      { decision, revision_id: revisionId },
      // The same decision on the same revision is the same request, so a
      // retry replays the first answer instead of deciding twice.
      `decision:${approvalId}:${revisionId}:${decision}`
    )
    const body = await response.json().catch(() => null)
    if (response.ok) {
      ApprovalDecision.parse(body)
      return { recorded: true }
    }
    const refusal = ErrorEnvelope.safeParse(body)
    const reason =
      (response.status === 404 || response.status === 409) && refusal.success
        ? REFUSED[refusal.data.code]
        : undefined
    if (reason) {
      return { recorded: false, reason }
    }
    throw new Error(`apps/api answered ${response.status} for ${path}`)
  },
}
