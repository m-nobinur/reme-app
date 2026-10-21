import {
  ActivityFeed,
  ApprovalDecision,
  type AttentionItem as Attention,
  type BlueprintReviewOutput,
  CHAT_TURN_MS,
  type ChangeKind,
  Conversation,
  ConversationHistory,
  ConversationList,
  type CreateReminderRequest,
  DomainCheckout,
  DomainName,
  DomainPurchaseStatus,
  ErrorEnvelope,
  FactList,
  type MemoryReviewAction,
  MemoryView,
  type MessageFeedback,
  Org,
  PreviewLink,
  PushConfig,
  PushSubscribed,
  type PushSubscribeRequest,
  type RegistrantDetails,
  StaffDirectory,
  Uuid,
  WorkspaceStatus,
} from "@workspace/contracts"
import { answerSpecOf } from "@workspace/ui/lib/answer"
import { WORKING } from "@workspace/ui/lib/build-state"
import { factLabel } from "@workspace/ui/lib/facts"
import { refusalText } from "@workspace/ui/lib/refusal"
import { stoppedLines } from "../stopped"
import { apiFetch, COOKIE, forwardedSession } from "./transport"
import type {
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
 * the org id from the sealed session and would not read one if we sent it,
 * so nothing here takes one either.
 *
 * The pipeline has no endpoint yet. It answers empty rather than inventing
 * rows, which is what an owner on their first day genuinely has. Nothing here
 * falls back to a fixture: an empty inbox is true, and a fixture business on a
 * tenant's screen is not (exit gate 9, R8).
 */

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
 * the browser's `Cookie` header through: anything else a page has set is ours
 * and is not `apps/api`'s business.
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

/** How long a photo upload has before the api starts answering. */
const UPLOAD_TIMEOUT_MS = 120_000

const sessionCookie = (session: string) =>
  `${COOKIE}=${encodeURIComponent(session)}`

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
    /** How long the api has to start answering, when not `API_TIMEOUT_MS`. */
    timeoutMs?: number
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
  return await apiFetch(
    new URL(path, apiUrl()),
    {
      method: init.method ?? "GET",
      headers,
      body:
        init.raw ??
        (init.body === undefined ? undefined : JSON.stringify(init.body)),
    },
    init.timeoutMs
  )
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
        detail: stoppedLines(item.cause).join(" "),
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
    case "job_paused":
      return {
        title: "A scheduled task was paused",
        detail:
          "Something Reme does on a schedule kept failing, so it was paused.",
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
        site: { host: null, url: null, live: null },
        builds: [],
        attention: [],
        missing_facts: [],
        assistant_name: null,
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
        ...(item.photos
          ? {
              photos: item.photos.map(({ thumbnail, ...photo }) =>
                thumbnail ? { ...photo, src: thumbnail } : photo
              ),
            }
          : {}),
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
    case "reminder":
      return {
        kind: "reminder",
        id: item.reminder_id,
        title: item.title,
        detail: "You asked to be reminded. Mark it done on the Reminders page.",
        raisedBy: SYSTEM,
        raisedById: null,
        raisedAt: item.due_at,
        expiresAt: null,
        onExpiry: "It stays here until you mark it done.",
      }
    default:
      return {
        kind: item.kind,
        id: item.event_id,
        ...logged(item),
        ...(item.kind === "alert" && item.reason === "build_failed"
          ? { stopped: item.cause ?? "other" }
          : {}),
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
    expectedSeconds: status.expected_seconds,
    host: status.site.host,
    url: status.site.url,
    missingFacts: status.missing_facts,
    assistantName: status.assistant_name,
    derivedReminders: status.reminders.derived,
    reminderNotes: status.reminders.notes,
    etag,
  }
}

async function workspace(staff: Promise<StaffMember[]>): Promise<Workspace> {
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
  "revision.a11y_unchecked": "checking",
}

/**
 * A refusal the owner can act on from the panel is worded by `refusalText`;
 * any other 4xx is a stale screen, and a 5xx is a defect and throws.
 */
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
  // `org.unresolved` is a session with no organisation, which has nothing to
  // act on: a defect, not a stale screen.
  if (
    response.status >= 400 &&
    response.status < 500 &&
    refusal.success &&
    code !== "org.unresolved"
  ) {
    const reason = refusalText(code, STALE)
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

async function decideBlueprint(
  assignmentId: string,
  decision: BlueprintReviewOutput,
  key: string
): Promise<WriteOutcome> {
  const path = `/builds/${segment(assignmentId)}/blueprint`
  // The same decision again is a retry and gets its receipt.
  return await outcome(await post(path, decision, key), path)
}

async function cancelBuild(assignmentId: string): Promise<WriteOutcome> {
  const path = `/builds/${segment(assignmentId)}/cancel`
  // One build is stopped once: a second press is the same request.
  return await outcome(
    await post(path, undefined, `cancel:${assignmentId}`),
    path
  )
}

async function deleteAccount(): Promise<WriteOutcome> {
  // An account is deleted once: a second press is the same request.
  return await outcome(
    await post("/account", undefined, "account:delete", "DELETE"),
    "/account"
  )
}

async function preview(assignmentId: string): Promise<PreviewLinks | null> {
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
  text: string,
  key: string,
  changeKind?: ChangeKind
): Promise<WriteOutcome> {
  return await outcome(
    await post("/changes", { text, change_kind: changeKind }, key),
    "/changes"
  )
}

async function createReminder(
  input: CreateReminderRequest,
  key: string
): Promise<WriteOutcome> {
  return await outcome(await post("/reminders", input, key), "/reminders")
}

/**
 * A domain purchase's Checkout, created with the registrant as the card
 * shows it. A refusal is the owner's to read (the name was taken, the price
 * changed, buying is off), so it comes back as its code. Each press is its
 * own Checkout, keyed by the caller.
 */
async function domainCheckout(
  name: string,
  details: RegistrantDetails,
  key: string
): Promise<DomainCheckout | { refused: string | null }> {
  // A hostname never holds "/" or a lone dot, so it cannot reach another route.
  const path = `/domains/${DomainName.parse(name)}/checkout`
  const response = await post(path, details, key)
  const body = await response.json().catch(() => null)
  if (response.ok) return DomainCheckout.parse(body)
  const refusal = ErrorEnvelope.safeParse(body)
  if (response.status >= 400 && response.status < 500 && refusal.success) {
    return { refused: refusal.data.code }
  }
  throw new Error(`apps/api answered ${response.status} for ${path}`)
}

async function googleConnect(
  input: Parameters<OwnerDataSource["googleConnect"]>[0]
): ReturnType<OwnerDataSource["googleConnect"]> {
  const response = await call("/google/connect", {
    method: "POST",
    body: input,
    // Past the api's own 30 s for the connect, so its answer gets back.
    timeoutMs: 35_000,
  }).catch(() => null)
  if (response?.ok) return "connected"
  const refusal = ErrorEnvelope.safeParse(
    await response?.json().catch(() => null)
  )
  return response?.status === 422 &&
    refusal.success &&
    refusal.data.code.includes("scopes_missing")
    ? "scopes_missing"
    : "failed"
}

/** The newest purchase of a domain in the owner's business, or null when there is none. */
async function domainStatus(
  name: string
): Promise<DomainPurchaseStatus | null> {
  const path = `/domains/${DomainName.parse(name)}`
  const response = await call(path)
  if (!response || response.status === 404) return null
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for ${path}`)
  }
  return DomainPurchaseStatus.parse(await response.json())
}

async function completeReminder(id: string): Promise<WriteOutcome> {
  const path = `/reminders/${segment(id)}`
  // Done is done: a second press is the same request.
  return await outcome(
    await post(path, { done: true }, `done:${id}`, "PATCH"),
    path
  )
}

async function memory(): Promise<MemoryView | null> {
  const body = await get("/memory")
  return body === null ? null : MemoryView.parse(body)
}

async function undoMemory(
  version: number
): Promise<MemoryView | "stale" | null> {
  const response = await call("/memory/undo", {
    method: "POST",
    body: { version },
  })
  if (!response || response.status === 401 || response.status === 403) {
    return null
  }
  if (response.status === 409) return "stale"
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for /memory/undo`)
  }
  return MemoryView.parse(await response.json())
}

async function reviewMemory(
  action: MemoryReviewAction
): Promise<MemoryView | "stale" | null> {
  const response = await call("/memory/review", {
    method: "POST",
    body: action,
  })
  if (!response || response.status === 401 || response.status === 403) {
    return null
  }
  if (response.status === 409) return "stale"
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for /memory/review`)
  }
  return MemoryView.parse(await response.json())
}

async function pushKey(): Promise<string | null> {
  const body = await get("/push/config")
  return body === null ? null : PushConfig.parse(body).public_key
}

async function subscribePush(
  input: PushSubscribeRequest,
  key: string
): Promise<string | null> {
  const response = await post("/push/subscriptions", input, key)
  if (response.ok) return PushSubscribed.parse(await response.json()).id
  // A refusal (not the owner, an address that is no push service) is final.
  if (response.status >= 400 && response.status < 500) return null
  throw new Error(
    `apps/api answered ${response.status} for /push/subscriptions`
  )
}

async function unsubscribePush(id: string): Promise<WriteOutcome> {
  const path = `/push/subscriptions/${segment(id)}`
  return await outcome(
    await post(path, undefined, `unsubscribe:${id}`, "DELETE"),
    path
  )
}

async function conversations(): Promise<Conversation[]> {
  const body = await get("/conversations")
  return body === null ? [] : ConversationList.parse(body).conversations
}

async function conversation(id: string): Promise<Conversation | null> {
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

async function createConversation(key: string): Promise<Conversation | null> {
  const response = await post("/conversations", undefined, key)
  // A session with no organisation has nowhere to store one.
  if (response.status === 401 || response.status === 403) {
    return null
  }
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for /conversations`)
  }
  return Conversation.parse(await response.json())
}

async function updateConversation(
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

async function conversationMessages(id: string): Promise<TransportedMessage[]> {
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
  org: currentOrg,
  staff: staffOf,
  directory: async () => {
    const staff = await staffOf()
    return { staff, tree: treeOf(staff) }
  },
  workspace,
  pipeline: async () => [],
  activity,
  profile: async () => {
    const [org, facts] = await Promise.all([currentOrg(), factsOf()])
    return org ? { org, facts } : null
  },
  pollWorkspace,
  answer,
  decideBlueprint,
  cancelBuild,
  deleteAccount,
  preview,
  requestChange,
  createReminder,
  completeReminder,
  memory,
  undoMemory,
  reviewMemory,
  pushKey,
  subscribePush,
  unsubscribePush,
  domainCheckout,
  domainStatus,
  googleConnect,
  conversations,
  conversation,
  createConversation,
  updateConversation,
  rateMessage,
  conversationMessages,
  // A turn may wait on the onboarding planner, then the script, before it
  // answers; cut short, the owner's retry finds it still running (chat.busy).
  chat: (raw) =>
    call("/chat", { method: "POST", raw, timeoutMs: CHAT_TURN_MS }),
  assets: async ({ body, type, length, key }) => {
    const session = await forwardedSession()
    if (!session) return null
    return await apiFetch(
      new URL("/assets", apiUrl()),
      {
        method: "POST",
        headers: {
          cookie: sessionCookie(session),
          "content-type": type,
          "content-length": String(length),
          "idempotency-key": key,
        },
        body,
      },
      // The api answers once every byte is in, which a slow line takes a while to send.
      UPLOAD_TIMEOUT_MS
    )
  },
  photo: (assetId) => call(`/photos/${segment(assetId)}`),
  decideApproval: async (approvalId, revisionId, decision) => {
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
