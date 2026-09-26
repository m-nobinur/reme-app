import { getCookie } from "@tanstack/react-start/server"
import {
  ActivityFeed,
  ApprovalDecision,
  type AssignmentState,
  type AttentionItem as Attention,
  ErrorEnvelope,
  FactList,
  Org,
  StaffDirectory,
  WorkspaceStatus,
} from "@workspace/contracts"
import { factLabel } from "../facts"
import type {
  ActivityItem,
  ApprovalItem,
  AttentionItem,
  DecisionOutcome,
  OrgNode,
  OrgSummary,
  OwnerDataSource,
  StaffMember,
  TransportedFact,
  Workspace,
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
  const session = getCookie(COOKIE)
  if (!session) {
    return null
  }
  const response = await fetch(new URL(path, apiUrl()), {
    headers: { cookie: sessionCookie(session) },
  })
  if (response.status === 401 || response.status === 403) {
    return null
  }
  if (!response.ok) {
    throw new Error(`apps/api answered ${response.status} for ${path}`)
  }
  return await response.json()
}

const sessionCookie = (session: string) =>
  `${COOKIE}=${encodeURIComponent(session)}`

/** One write. The caller reads the answer, since some refusals are the owner's to act on. */
async function post(
  path: string,
  body: unknown,
  idempotencyKey: string
): Promise<Response> {
  const session = getCookie(COOKIE)
  if (!session) {
    throw new Error(`no session to send ${path} with`)
  }
  const response = await fetch(new URL(path, apiUrl()), {
    method: "POST",
    headers: {
      cookie: sessionCookie(session),
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  })
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
async function workspaceStatus(): Promise<WorkspaceStatus> {
  const body = await get("/workspace")
  if (body === null) {
    return {
      site: { host: null, live: null },
      builds: [],
      attention: [],
      missing_facts: [],
    }
  }
  const status = WorkspaceStatus.parse(body)
  return {
    ...status,
    attention: status.attention.filter(
      (item) =>
        item.kind !== "approval" || item.request.target.kind === "revision"
    ),
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
        id: item.request.approval_id,
        title: approvalTitle(item.version),
        detail: item.request.rationale,
        raisedBy: names.get(item.request.requested_by_staff_id) ?? SYSTEM,
        raisedAt: item.request.requested_at,
        expiresAt: item.request.expires_at,
        onExpiry: APPROVAL_EXPIRY,
      }
    case "question":
      return {
        kind: "question",
        id: item.request.request_id,
        title: factLabel(item.request.field),
        detail: item.request.why,
        raisedBy: names.get(item.request.requested_by_staff_id) ?? SYSTEM,
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
        raisedAt: item.at,
        expiresAt: null,
        onExpiry: "Nothing to decide.",
      }
  }
}

/** The states in which a build is doing work rather than waiting on someone. */
const WORKING = new Set<AssignmentState>([
  "queued",
  "briefing",
  "planning",
  "implementing",
  "validating",
  "revising",
  "repairing",
  "release_candidate",
])

async function workspace(
  _orgId: string,
  staff: Promise<StaffMember[]>
): Promise<Workspace> {
  const [status, members] = await Promise.all([workspaceStatus(), staff])
  const names = namesOf(members)
  return {
    attention: status.attention.map((item) => toAttention(item, names)),
    live: status.site.live?.version ?? null,
    building: status.builds.some((build) => WORKING.has(build.state)),
    open: status.builds.length > 0,
  }
}

/**
 * `GET /approvals` was dropped: the workspace's attention list carries them.
 * The directory is read only when there is an approval to name.
 */
async function approvals(): Promise<ApprovalItem[]> {
  const found = (await workspaceStatus()).attention.filter(
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

async function activity(): Promise<ActivityItem[]> {
  const body = await get("/activity")
  if (body === null) {
    return []
  }
  return ActivityFeed.parse(body).items.map((item) => ({
    id: item.event_id,
    summary: logged(item).title,
    occurredAt: item.at,
  }))
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
  decideApproval: async (_orgId, approvalId, revisionId, decision) => {
    const path = `/approvals/${encodeURIComponent(approvalId)}/decision`
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
